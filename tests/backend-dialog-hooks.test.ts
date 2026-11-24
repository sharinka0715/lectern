import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend, quoteShell, runCommand } from '../src/backend';
import { DialogHookStore, decodeDialogHookFile, dialogHookDir } from '../src/backend/dialog-hooks';
import type { Workspace } from '../src/shared/types';

const SESSION = randomUUID(), NONCE = 'ab'.repeat(16);
const file = (event: string, body: object) => Buffer.from(JSON.stringify({ session_id: SESSION, hook_event_name: event, ...body }));

test('a hook file counts only as a complete call of this session: its event, tool, input and call id', () => {
  const ask = { tool_name: 'AskUserQuestion', tool_input: { questions: [] }, tool_use_id: 'toolu_01' };
  assert.deepEqual(decodeDialogHookFile('1795000000-42-PreToolUse.json', file('PreToolUse', ask), SESSION),
    { event: 'PreToolUse', at: 1795000000, toolName: 'AskUserQuestion', input: { questions: [] }, toolUseId: 'toolu_01' });
  // A subagent's call is kept, marked: never a card of the main conversation.
  assert.equal(decodeDialogHookFile('1-2-PreToolUse.json', file('PreToolUse', { ...ask, agent_id: 'a1b2' }), SESSION)?.agentId, 'a1b2');
  // PermissionRequest has no tool_use_id; SessionStart only its source.
  assert.deepEqual(decodeDialogHookFile('1-2-PermissionRequest.json', file('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }), SESSION),
    { event: 'PermissionRequest', at: 1, toolName: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(decodeDialogHookFile('5-2-SessionStart.json', file('SessionStart', { source: 'resume' }), SESSION), { event: 'SessionStart', at: 5, source: 'resume' });
  assert.deepEqual(decodeDialogHookFile('.started', file('SessionStart', { source: 'startup' }), SESSION), { event: 'SessionStart', at: 0, source: 'startup' });
  for (const [name, data, why] of [
    ['1-2-PreToolUse.json', file('PreToolUse', { ...ask, session_id: randomUUID() }), 'another session'],
    ['1-2-PreToolUse.json', file('PermissionRequest', ask), 'another event than its name'],
    ['1-2-PreToolUse.json', file('PreToolUse', { ...ask, tool_use_id: undefined }), 'no call id'],
    ['1-2-PreToolUse.json', file('PreToolUse', { ...ask, tool_use_id: 'x/../y' }), 'an odd call id'],
    ['1-2-PreToolUse.json', file('PreToolUse', { ...ask, tool_input: 'text' }), 'input not an object'],
    ['1-2-PreToolUse.json', file('PreToolUse', { ...ask, tool_name: 'Ask\x1b[1m' }), 'control characters'],
    ['1-2-PreToolUse.json', Buffer.from('{"session_id":'), 'cut JSON'],
    ['1-2-Stop.json', file('Stop', {}), 'not an event Lectern registers'],
    ['../1-2-PreToolUse.json', file('PreToolUse', ask), 'a path'],
  ] as const) assert.equal(decodeDialogHookFile(name, data, SESSION), undefined, why);
});

test('the store keeps each launch\'s newest records across reads, and hands back a replaced folder', () => {
  const store = new DialogHookStore(), dir = `/tmp/lectern-hooks-0/${NONCE}`, next = `/tmp/lectern-hooks-0/${'cd'.repeat(16)}`;
  const frame = (...files: [string, Buffer][]) => ['ok', ...files.flatMap(([name, data]) => [`${name} ${data.length}`, data.toString('base64')])].join('\n') + '\n';
  assert.equal(store.bind('k', dir), undefined);
  assert.equal(store.wantsStarted('k'), true);
  store.ingest('k', dir, frame(['1-1-SessionStart.json', file('SessionStart', { source: 'startup' })],
    ['2-1-PreToolUse.json', file('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {}, tool_use_id: 't1' })],
    ['2-2-PreToolUse.json', file('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {}, tool_use_id: 't2', session_id: randomUUID() })]), SESSION);
  const seen = store.observe('k')!;
  assert.deepEqual(seen.started, { at: 1, source: 'startup' });
  assert.deepEqual(seen.records.map(r => [r.seq, r.event, r.toolUseId]), [[1, 'SessionStart', undefined], [2, 'PreToolUse', 't1']]);
  assert.equal(seen.rejected, 1);
  assert.equal(store.wantsStarted('k'), false);
  // Another folder's frame is not this launch's; a folder gone reads as such.
  store.ingest('k', next, frame(['3-1-PreToolUse.json', file('PreToolUse', { tool_name: 'X', tool_input: {}, tool_use_id: 't3' })]), SESSION);
  assert.equal(store.observe('k')!.records.length, 2);
  store.ingest('k', dir, 'missing\n', SESSION);
  assert.equal(store.observe('k')!.folder, false);
  for (let i = 0; i < 70; i++) store.ingest('k', dir, frame([`${10 + i}-1-PreToolUse.json`, file('PreToolUse', { tool_name: 'X', tool_input: {}, tool_use_id: `n${i}` })]), SESSION);
  assert.equal(store.observe('k')!.records.length, 64);
  assert.equal(store.observe('k')!.records.at(-1)!.toolUseId, 'n69');
  assert.equal(store.bind('k', next), dir, 'a new launch: the old folder is to be removed');
  assert.equal(store.observe('k')!.records.length, 0);
  assert.equal(store.bind('k', undefined), next);
  assert.equal(store.observe('k'), undefined);
});

test('the folder named in the pane option counts only as this launch\'s', () => {
  for (const dir of [`/tmp/lectern-hooks-501/${NONCE}`, `/var/folders/x y/T/lectern-hooks-0/${NONCE}`]) assert.equal(dialogHookDir(dir, NONCE), dir);
  for (const dir of [`/tmp/lectern-hooks-501/${'cd'.repeat(16)}`, `tmp/lectern-hooks-501/${NONCE}`, `/tmp/../lectern-hooks-1/${NONCE}`,
    `/tmp/lectern-hooks-x/${NONCE}`, `/tmp//lectern-hooks-1/${NONCE}`, `/tmp/lectern-hooks-1/${NONCE}/`, `/tmp/a\n/lectern-hooks-1/${NONCE}`, '', undefined]) {
    assert.equal(dialogHookDir(dir, NONCE), undefined, String(dir));
  }
  assert.equal(dialogHookDir(`/tmp/lectern-hooks-1/${NONCE}`, undefined), undefined, 'no verified launch');
});

test('with the setting on a conversation\'s launch records its hooks, the poll reads them, closing removes the folder; off, nothing', { skip: process.platform === 'win32', timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-dialog-hooks-')));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(root, 'tmp');
  const workspace: Workspace = { id: randomUUID(), name: 'fixture', kind: 'local', cwd: root, claudeDir: join(root, 'config') };
  const socket = 'dialoghooks-' + randomUUID().slice(0, 8), exe = join(root, 'claude'), fixture = join(root, 'fixture.mjs');
  const tmux = (...args: string[]) => ['tmux', '-L', socket, ...args].map(quoteShell).join(' ');
  const options = { claudeCommand: exe, tmuxSocket: socket, claudeArgs: [fixture] };
  const backend = new Backend(options), reopened = new Backend(options);
  const wait = async (test: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 100; i++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.fail(what);
  };
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    await mkdir(workspace.claudeDir!); await mkdir(join(root, 'tmp'));
    await symlink(process.execPath, exe);
    // A stand-in for Claude Code: runs its SessionStart hook at start and AskUserQuestion's PreToolUse on a key.
    await writeFile(fixture, `
      import {spawnSync} from 'node:child_process';
      import fs from 'node:fs';
      const args=process.argv.slice(2), settings=JSON.parse(args[args.indexOf('--settings')+1]), id=args.at(-1);
      fs.writeFileSync('settings-'+id, JSON.stringify(settings));
      const hook=(event,body)=>{
        const command=settings.hooks?.[event]?.[0]?.hooks?.[0]?.command; if(!command) return;
        const r=spawnSync('/bin/sh',['-c',command],{input:JSON.stringify({session_id:id,hook_event_name:event,...body}),encoding:'utf8'});
        fs.writeFileSync('hook-'+event+'-'+id, JSON.stringify({code:r.status,stdout:r.stdout,stderr:r.stderr}));
      };
      hook('SessionStart',{source:'startup'});
      fs.writeFileSync('started-'+id, id);
      process.stdin.setRawMode(true); process.stdin.resume();
      process.stdin.on('data',()=>hook('PreToolUse',{tool_name:'AskUserQuestion',tool_use_id:'toolu_fixture',tool_input:{questions:[{question:'Tea?',header:'Drink',options:[{label:'Yes'},{label:'No'}]}]}}));`);
    const launch = async (dialogHooks: boolean) => {
      backend.setLaunchPreferences({ dialogHooks });
      const session = await backend.createSession(workspace);
      await wait(async () => await readFile(join(root, 'started-' + session.id), 'utf8').catch(() => '') === session.id, 'fixture did not start');
      return { session, settings: JSON.parse(await readFile(join(root, 'settings-' + session.id), 'utf8')) };
    };
    // Off (the default): no hooks in the settings, no folder, no option, nothing read.
    const off = await launch(false);
    assert.equal('hooks' in off.settings, false);
    assert.equal((await backend.readSession(workspace, off.session.id)).dialogHooks, undefined);
    assert.equal(await readdir(join(root, 'tmp')).then(names => names.filter(name => name.startsWith('lectern-hooks-')).length), 0);
    // On: the hooks are in the settings and their folder is named in the pane option.
    const on = await launch(true);
    assert.deepEqual(Object.keys(on.settings.hooks), ['PreToolUse', 'PermissionRequest', 'SessionStart']);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'hook-SessionStart-' + on.session.id), 'utf8')), { code: 0, stdout: '', stderr: '' });
    const first = (await backend.readSession(workspace, on.session.id)).dialogHooks;
    assert.equal(first?.folder, true);
    assert.equal(first?.started?.source, 'startup');
    const dir = (await runCommand(workspace, tmux('show-options', '-pqv', '-t', on.session.paneId!, '@lectern_hooks_dir'))).stdout.toString().trim();
    assert.equal(dir, join(root, 'tmp', `lectern-hooks-${process.getuid!()}`, dir.split('/').at(-1)!));
    await runCommand(workspace, tmux('send-keys', '-t', on.session.paneId!, 'x'));
    await wait(async () => !!await readFile(join(root, 'hook-PreToolUse-' + on.session.id), 'utf8').catch(() => ''), 'hook did not run');
    const read = (await backend.readSession(workspace, on.session.id, true)).dialogHooks!;
    assert.deepEqual(read.records.map(r => [r.event, r.toolName, r.toolUseId]), [['SessionStart', undefined, undefined], ['PreToolUse', 'AskUserQuestion', 'toolu_fixture']]);
    assert.deepEqual(await readdir(dir), ['.started'], 'read files are deleted');
    // After a restart the kept SessionStart says the hooks run.
    assert.equal((await reopened.readSession(workspace, on.session.id)).dialogHooks?.started?.source, 'startup');
    // Closing the conversation removes its folder.
    const pane = (await backend.readSession(workspace, on.session.id)).panePid!;
    await backend.closeSession(workspace, on.session.id, on.session.paneId!, pane, false);
    await assert.rejects(lstat(dir));
  } finally {
    await runCommand(workspace, tmux('kill-server')).catch(() => {});
    await Promise.all([backend.dispose(), reopened.dispose()]);
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
