import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Backend } from '../src/backend';
import { inspectSettingsFiles, mergeSettings, normalizeSettingsPath, readSettingsFile, settingsOverrides, SETTINGS_LIMIT, writePrivateSettings } from '../src/backend/conversation-settings';
import { fileIndexWorkspaceKey } from '../src/backend/file-index';
import { HistoryIndexDiskStore } from '../src/backend/history-index-disk-store';
import { statusLineLaunch } from '../src/backend/native-status-line';
import { commandInvocation, quoteShell, Transport } from '../src/backend/transport';
import { catalogKey } from '../src/main/model-catalogs';
import { ConversationSettingsStore } from '../src/main/conversation-settings-store';
import { WorkspaceStore } from '../src/main/store';
import { workspaceReceipts } from '../src/renderer/sidebar-receipts';
import { sessionSettingsTarget } from '../src/shared/session-setting-ticket';
import type { Workspace } from '../src/shared/types';

const workspace: Workspace = { id: 'fixture', kind: 'local', name: 'Fixture', cwd: '/sample/project' };
const location = { cwd: workspace.cwd, cwdAliases: [workspace.cwd], claudeDir: '/sample/config', projectDirs: ['/sample/config/projects/-sample-project'] };
const sid = '11111111-2222-4333-8444-555555555555';
const posix = { skip: process.platform === 'win32' };

test('default workspace identifiers preserve their persisted keys', async t => {
  assert.equal(workspaceReceipts(workspace).scope, '["fixture","local",null,null,"/sample/project",null]');
  assert.equal(fileIndexWorkspaceKey(workspace), 'fixture\n["local","",0,"/sample/project",""]');
  assert.equal(sessionSettingsTarget(workspace), '["local",null,null,"/sample/project",null]');
  assert.equal(catalogKey(workspace), '["local",null,null,null]');
  const root = await mkdtemp(join(tmpdir(), 'lectern-settings-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new HistoryIndexDiskStore(root).forWorkspace(workspace, location)!;
  assert.equal(await index.write([]), true);
  const dir = join(root, 'history-index'), [file] = await readdir(dir);
  assert.equal(JSON.parse(await readFile(join(dir, file), 'utf8')).scope, '0581f060b380ba6611cefd4f6a3818d6a51172bee038e527089b801911b966b4');
});

test('legacy workspace data ignores its configuration directory and drops it on save', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lectern-settings-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'workspaces.json');
  await writeFile(file, JSON.stringify([{ ...workspace, claudeDir: 'old-invalid-value' }]));
  const store = new WorkspaceStore(root);
  await store.load();
  assert.equal(Object.hasOwn(store.get(workspace.id), 'claudeDir'), false);
  await store.save(store.get(workspace.id));
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file, 'utf8'))[0], 'claudeDir'), false);
});

test('conversation records persist null, follow an endpoint across folders and inherit without erasing an edit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lectern-settings-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ConversationSettingsStore(root);
  await store.load();
  assert.equal(store.get(workspace, sid), undefined);
  await store.save(workspace, sid, null);
  assert.deepEqual(store.get(workspace, sid), { settingsFile: null });
  const fork = randomUUID(), other = { ...workspace, cwd: '/sample/another' };
  await store.save(workspace, sid, '~/fixture.json');
  await Promise.all([store.save(other, fork, '~/fixture.json', true), store.save(other, fork, '/sample/updated.json'),
    store.save(other, fork, null, true)]);
  const restored = new ConversationSettingsStore(root);
  await restored.load();
  assert.deepEqual(restored.get(other, sid), { settingsFile: '~/fixture.json' });
  assert.deepEqual(restored.get(workspace, fork), { settingsFile: '/sample/updated.json' });
  assert.equal(restored.get({ kind: 'ssh', host: 'fixture' }, sid), undefined);
});

test('a native UUID change inherits the path the process was launched with', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lectern-settings-native-'));
  const records = new ConversationSettingsStore(root);
  const backend = new Backend({ conversationSettings: records });
  t.after(async () => { await backend.dispose(); await rm(root, { recursive: true, force: true }); });
  const changed = randomUUID();
  await records.save(workspace, sid, '/sample/next-resume.json');
  await (backend as any).inheritSettings(workspace, location, [{ native: { sessionId: changed }, boundSessionId: sid,
    cwd: workspace.cwd, processSettings: { settingsFile: '/sample/start.json' } }]);
  assert.deepEqual(records.get(workspace, changed), { settingsFile: '/sample/start.json' });
  assert.deepEqual(records.get(workspace, sid), { settingsFile: '/sample/next-resume.json' });
  const legacy = randomUUID();
  await (backend as any).inheritSettings(workspace, location, [{ native: { sessionId: legacy }, boundSessionId: sid,
    cwd: workspace.cwd, managed: true }]);
  assert.deepEqual(records.get(workspace, legacy), { settingsFile: null });
});

test('settings overlay merges nested objects, keeps user keys and deduplicates arrays structurally', () => {
  assert.deepEqual(mergeSettings({
    permissions: { defaultMode: 'default', allow: ['Bash'] }, hooks: { SessionStart: [{ a: 1, b: 2 }] },
    env: { USER_VALUE: '1', SAME: '0' }, custom: 'unchanged',
  }, {
    permissions: { defaultMode: 'auto' }, hooks: { SessionStart: [{ b: 2, a: 1 }, { a: 3 }] },
    env: { SAME: '1', APP_VALUE: '2' },
  }), {
    permissions: { defaultMode: 'auto', allow: ['Bash'] }, hooks: { SessionStart: [{ a: 1, b: 2 }, { a: 3 }] },
    env: { USER_VALUE: '1', SAME: '1', APP_VALUE: '2' }, custom: 'unchanged',
  });
});

test('settings overwrite detection labels all sources, skips equal values and hooks, and checks non-objects at parent paths', async () => {
  const paths = [location.claudeDir + '/settings.json', location.cwd + '/.claude/settings.json', location.cwd + '/.claude/settings.local.json', '/sample/custom.json'];
  const settings = [{ permissions: false }, { promptSuggestionEnabled: true }, { permissions: { defaultMode: 'acceptEdits' } },
    { promptSuggestionEnabled: false, permissions: { defaultMode: 'default' }, hooks: ['keep'] }];
  const transport = { run: async (_ws: Workspace, script: string) => {
    const index = paths.findIndex(file => script.startsWith('p=' + quoteShell(file) + '\n'));
    return { stdout: Buffer.from(index < 0 ? 'm' : 'o' + JSON.stringify(settings[index])), stderr: '' };
  } } as Transport;
  const flags = { permissions: { defaultMode: 'auto' }, promptSuggestionEnabled: false, hooks: { SessionStart: [] } };
  const result = await inspectSettingsFiles(transport, workspace, location, paths[3], flags, true);
  assert.deepEqual(result.validation.overrides.map(source => [source.file, ...source.items.map(item => item.key)]),
    paths.map((file, index) => [file, index === 1 ? 'promptSuggestionEnabled' : 'permissions.defaultMode']));
  assert.equal(result.validation.overrides[0].items[0].userValue, 'false');
  assert.deepEqual(settingsOverrides([{ file: paths[0], settings: flags }], flags), []);
});

test('path normalization and target read errors', posix, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lectern-settings-read-'));
  const transport = new Transport();
  t.after(async () => { await transport.dispose(); await rm(root, { recursive: true, force: true }); });
  assert.equal(normalizeSettingsPath('  '), null);
  assert.equal(normalizeSettingsPath(' ~/a.json '), '~/a.json');
  assert.equal(normalizeSettingsPath(' /sample/my settings.json '), '/sample/my settings.json');
  for (const bad of ['~', '~other/file', 'relative', 'C:\\settings.json', '/x\0y']) assert.throws(() => normalizeSettingsPath(bad), /绝对路径/);
  const file = join(root, "test 'file'.json");
  await assert.rejects(readSettingsFile(transport, workspace, file), /不存在/);
  await assert.rejects(readSettingsFile(transport, workspace, root), /普通文件/);
  await assert.rejects(readSettingsFile({ run: async () => ({ stdout: Buffer.from('r'), stderr: '' }) }, workspace, file), /无法读取/);
  await writeFile(file, ' '.repeat(SETTINGS_LIMIT + 1));
  await assert.rejects(readSettingsFile(transport, workspace, file), /1 MiB/);
  await writeFile(file, '{\n "fixture": }');
  await assert.rejects(readSettingsFile(transport, workspace, file), /第 2 行，第 13 列/);
  await writeFile(file, '[]');
  await assert.rejects(readSettingsFile(transport, workspace, file), /顶层/);
  await writeFile(file, '{"example":true}');
  const linked = join(root, 'link.json');
  await symlink(file, linked);
  assert.deepEqual(await readSettingsFile(transport, workspace, linked), { example: true });
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(() => { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
  const privateFile = await writePrivateSettings(transport, workspace, { example: true });
  assert.equal(await readFile(privateFile.path, 'utf8'), '{"example":true}');
  await privateFile.remove();
  await assert.rejects(readFile(privateFile.path), { code: 'ENOENT' });
  const stale = await writePrivateSettings(transport, workspace, { example: 'old' });
  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  await utimes(stale.path, oldTime, oldTime);
  await writePrivateSettings(transport, workspace, { example: 'new' });
  await assert.rejects(readFile(stale.path), { code: 'ENOENT' });
});

test('private SSH stdin is streamed and does not become part of argv', posix, () => {
  const data = Buffer.from('{"fixture":"only on stdin"}');
  const invocation = commandInvocation({ ...workspace, kind: 'ssh', host: 'placeholder' },
    'cat', undefined, undefined, false, data, 'STATUS=', true);
  assert.equal(invocation.input, data);
  assert.equal(invocation.closeInput, true);
  assert.equal(invocation.args.some(arg => arg.includes(data.toString())), false);
});

test('a launch without a custom path retains its original command exactly', async t => {
  const backend = new Backend();
  t.after(() => backend.dispose());
  const nonce = 'a'.repeat(32), version = 'tmux 3.4';
  const callback = statusLineLaunch(sid, nonce, version);
  const inline = JSON.stringify({ ...JSON.parse(callback.settings), enableWorkflows: true, permissions: { defaultMode: 'auto' } });
  const transport = (backend as any).transport as Transport;
  transport.run = async () => ({ stdout: Buffer.from('/sample/bin/claude\n'), stderr: '' });
  const result = await (backend as any).launchCommand(workspace, { ...location, tmuxVersion: version }, sid, false, undefined, {}, null, nonce);
  const prefix = `export PATH='/sample/bin':"$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"; ${callback.register}; `;
  assert.equal(result.command, prefix + 'export COLORTERM="${COLORTERM:-truecolor}"; exec ' + ['/sample/bin/claude', '--settings', inline, '--session-id', sid].map(quoteShell).join(' '));
  assert.equal(result.staged, undefined);
});
