import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Backend, quoteShell, runCommand } from '../src/backend';
import { effortFrameGuard, NativeSettings, NavigationKeyNotSent, type SettingChoices, type SettingContext, type SettingDriver } from '../src/backend/native-settings';
import type { SessionSettingKind, Workspace } from '../src/shared/types';
import { sessionSettingTicketLifetimeMs } from '../src/shared/session-setting-ticket';
import { readFixtureSetting } from './support/read-fixture-setting';

const composer = '\n─────────────────────────────────\n❯ \n─────────────────────────────────\n  ? for shortcuts\n';
const context: SettingContext = { workspaceId: 'fixture', sessionId: randomUUID(), targetKey: 'fixture-target' };

test('the model list comes from one SDK probe without a tmux pane, and each explicit change runs one native command in the session', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-catalog-apply-')));
  const workspace: Workspace = { id: 'catalog-fixture', name: 'Fixture', kind: 'local', cwd: root, claudeDir: join(root, 'config') };
  const socket = 'catalog-apply-' + randomUUID().slice(0, 8);
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [resolve('scripts/mock-claude.mjs'), '--fixture-config', workspace.claudeDir!] });
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    const session = await backend.createSession(workspace);
    const paneId = session.paneId!;
    const tmux = (...args: string[]) => runCommand(workspace, ['tmux', '-L', socket, ...args].map(quoteShell).join(' ')).then(result => result.stdout.toString());
    const capture = () => tmux('capture-pane', '-p', '-t', paneId);
    for (let i = 0; i < 80 && !(await capture()).includes('shortcuts'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    const before = await capture();
    const catalog = await backend.probeModelCatalog(workspace);
    assert.deepEqual(catalog.models.map(row => [row.value, row.label, row.efforts]), [
      ['fixture-alpha', 'Fixture Alpha', ['low', 'medium', 'high']], ['fixture-beta', 'Fixture Beta', ['low', 'medium', 'high']]]);
    assert.deepEqual(catalog.defaults, { model: 'fixture-alpha', effort: 'medium', ultracodeAvailable: false });
    assert.equal(await capture(), before, 'the session is not touched');
    assert.deepEqual((await tmux('list-panes', '-a', '-F', '#{pane_id}')).trim().split('\n'), [paneId], 'no query pane');
    const [call, ...more] = readFileSync(join(workspace.claudeDir!, 'probe-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(more.length, 0);
    assert.deepEqual(call.args.slice(-7), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']);
    assert.equal(call.cwd, await realpath(process.env.HOME!), 'asked from the home directory, outside any project');
    assert.equal(call.claudeConfigDir, workspace.claudeDir, 'the folder\'s Claude configuration');
    const rows = {
      model: catalog.models.map(row => ({ label: row.label, description: row.description, value: row.value })),
      effort: catalog.models[0].efforts.map(level => ({ label: level, value: level })),
    };
    for (const [kind, label] of [['model', 'Fixture Beta'], ['effort', 'low']] as const) {
      const ticket = backend.bindSettingChoices(workspace, session.id, paneId, { kind, command: `/${kind}`, complete: true, options: rows[kind] });
      const choice = ticket.options.find(option => option.label === label)!;
      const verified = await backend.setSessionSetting(workspace, session.id, ticket.token, choice.id);
      assert.equal(verified.options.find(option => option.current)?.label, label);
    }
    const after = await capture();
    assert.equal(after.match(/❯ \/model/g)?.length, 1);
    assert.equal(after.match(/❯ \/effort/g)?.length, 1);
    assert.match(after, /Set model to Fixture Beta for this session only/);
    assert.match(after, /Set effort level to low \(this session only\)/);
  } finally {
    await backend.dispose();
    await runCommand(workspace, 'tmux -L ' + quoteShell(socket) + ' kill-server 2>/dev/null || true');
    await rm(root, { recursive: true, force: true });
  }
});

/** Rows as the machine's model list would give them for this fixture's menu. */
function choicesOf(fixture: NativeMenuFixture, kind: SessionSettingKind): SettingChoices {
  const labels = kind === 'model' ? fixture.modelLabels : fixture.effortLabels;
  return { kind, command: `/${kind}`, complete: true, options: labels.map((label, index) =>
    ({ label, ...(kind === 'model' && { description: fixture.modelDescriptions?.[index] ?? 'Observed provider description' }) })) };
}

test('one-page settings use bounded round trips and protect external drafts and permission dialogs at dispatch', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-setting-read-')));
  const workspace: Workspace = { id: 'settings-fixture', name: 'Fixture', kind: 'local', cwd: root, claudeDir: join(root, 'config') };
  const socket = 'settings-' + randomUUID().slice(0, 8);
  const backend = new Backend({ tmuxSocket: socket, claudeCommand: process.execPath, claudeArgs: [resolve('scripts/mock-claude.mjs'), '--fixture-config', workspace.claudeDir!] });
  const tmux = (...args: string[]) => ['tmux', '-L', socket, ...args].map(quoteShell).join(' ');
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    const session = await backend.createSession(workspace);
    const capture = async () => (await runCommand(workspace, tmux('capture-pane', '-p', '-t', session.paneId!))).stdout.toString();
    const waitForText = async (text: string) => {
      for (let i = 0; i < 40; i++) {
        if ((await capture()).includes(text)) return;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.fail(`Fixture did not render ${text}`);
    };
    for (let i = 0; i < 40; i++) {
      if ((await backend.readSession(workspace, session.id, true)).viewport?.includes('shortcuts')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const transport = (backend as any).transport, run = transport.run.bind(transport);
    const calls: string[] = [];
    let intervention: 'draft' | 'edited-command' | 'permission' | 'navigation-redraw' | undefined, enterCalls = 0, pasteCalls = 0, eraseCalls = 0;
    transport.run = async (target: Workspace, script: string, options: { tag?: string } = {}) => {
      calls.push(options.tag ?? '');
      if (intervention === 'navigation-redraw' && script.includes("'Escape'") && script.includes('LECTERN_MENU_KEY_NOT_SENT_')) {
        intervention = undefined;
        const check = /(\[ "\$\{lectern_digest%% \*\}" = )'[a-f0-9]{64}'/;
        assert.match(script, check);
        const refused = await run(target, script.replace(check, "$1'previous-frame'"), options);
        assert.match(refused.stdout.toString(), /^LECTERN_MENU_KEY_NOT_SENT_[\da-f-]{36}$/);
        assert.match(await capture(), /Select model/, 'the real shell guard exited before sending Escape');
        return refused;
      }
      if (script.includes("'paste-buffer'")) pasteCalls++;
      if (script.includes("'C-u'")) eraseCalls++;
      if (script.includes("'send-keys'") && script.includes("'Enter'")) {
        enterCalls++;
        if (intervention === 'edited-command') {
          intervention = undefined;
          await runCommand(target, tmux('send-keys', '-t', session.paneId!, '-l', ' local'));
          await waitForText('❯ /model local');
        }
      }
      if (intervention === 'draft' && script.includes("'paste-buffer'")) {
        intervention = undefined;
        await runCommand(target, tmux('send-keys', '-t', session.paneId!, '-l', 'keep my draft'));
        await waitForText('keep my draft');
      }
      if (intervention === 'permission' && script.includes("'paste-buffer'")) {
        intervention = undefined;
        const stateFile = quoteShell(join(workspace.claudeDir!, 'screen-state'));
        script = script.replace('sleep 0.1', `echo waiting > ${stateFile}\nsleep 0.3`);
      }
      return run(target, script, options);
    };
    for (const kind of ['model', 'effort'] as const) {
      calls.length = 0;
      const menu = await readFixtureSetting(backend, workspace, session.id, kind);
      assert.equal(menu.complete, true);
      assert.equal(menu.options.find(option => option.id === menu.currentOptionId)?.label, kind === 'model' ? 'Fixture Alpha' : 'medium');
      assert.ok(calls.length <= 8, JSON.stringify(calls));
      // The previous binary may leave its pasted command in a pane. Restarted
      // Lectern has only the visible draft and focus to bind an explicit click.
      await runCommand(workspace, tmux('send-keys', '-t', session.paneId!, '-l', '/' + kind));
      await waitForText('Set the session ' + kind);
      pasteCalls = enterCalls = 0;
      await assert.rejects(readFixtureSetting(backend, workspace, session.id, kind), /输入框为空/);
      const resume = { resumePendingCommand: true };
      await assert.rejects(readFixtureSetting(backend, workspace, session.id, kind === 'model' ? 'effort' : 'model', resume), /输入框为空/);
      await assert.rejects(backend.setSessionSetting(workspace, session.id, menu.token, menu.options[0].id), /输入框为空/);
      assert.equal(enterCalls, 0);
      const recovered = await readFixtureSetting(backend, workspace, session.id, kind, resume);
      assert.equal(recovered.complete, true);
      assert.deepEqual(recovered.options.map(o => [o.label, o.current]), menu.options.map(o => [o.label, o.current]));
      assert.equal(enterCalls, 1);
      assert.equal(pasteCalls, 0);
    }
    intervention = 'navigation-redraw';
    assert.equal((await readFixtureSetting(backend, workspace, session.id, 'model')).complete, true);
    assert.equal(intervention, undefined);
    await runCommand(workspace, tmux('send-keys', '-t', session.paneId!, '-l', '/model'));
    await waitForText('Set the session model');
    intervention = 'edited-command';
    await assert.rejects(readFixtureSetting(backend, workspace, session.id, 'model', { resumePendingCommand: true }), /原生设置画面或输入框已变化/);
    assert.match(await capture(), /❯ \/model local/);
    await runCommand(workspace, tmux('send-keys', '-t', session.paneId!, '-N', String('/model local'.length), 'BSpace'));
    intervention = 'draft';
    await assert.rejects(readFixtureSetting(backend, workspace, session.id, 'model'), /原生设置画面或输入框已变化/);
    const viewport = await capture();
    assert.match(viewport, /❯ keep my draft/);
    assert.doesNotMatch(viewport, /\/model|Select model/);
    await runCommand(workspace, tmux('send-keys', '-t', session.paneId!, '-N', String('keep my draft'.length), 'BSpace'));
    intervention = 'permission';
    enterCalls = 0;
    // Neither Enter nor the Ctrl+U that would take the typed command out goes to the dialog.
    await assert.rejects(readFixtureSetting(backend, workspace, session.id, 'effort'), /\/effort 命令，没有执行；Lectern 输入的 \/effort 也没能清除/);
    assert.equal(enterCalls, 0);
    assert.equal(eraseCalls, 0);
    assert.ok((await runCommand(workspace, tmux('capture-pane', '-p', '-t', session.paneId!))).stdout.includes('Permission required'));
  } finally {
    await backend.dispose();
    await runCommand(workspace, tmux('kill-server') + ' 2>/dev/null || true');
    await rm(root, { recursive: true, force: true });
  }
});

// Native Claude 2.1.319 over SSH. Moving the checkmark off the long Default
// label changes the whole description column width; option text is unchanged.
class CapturedSshMenuFixture implements SettingDriver {
  before = readFileSync(new URL('./fixtures/settings/model-ssh-before.txt', import.meta.url), 'utf8');
  after = readFileSync(new URL('./fixtures/settings/model-ssh-after.txt', import.meta.url), 'utf8');
  current = 1;
  focus = 1;
  opened = false;
  actions: string[] = [];
  receiptLabel = 'Haiku 5.5';
  history = '';
  async inspect() {
    let viewport = this.history + composer;
    if (this.opened) viewport = (this.current === 1 ? this.before : this.after)
      .replace(/^   ❯ /gm, '     ').replace(new RegExp(`^     ${this.focus}\\.`, 'm'), `   ❯ ${this.focus}.`);
    return { paneId: '%7', viewport };
  }
  async type(command: string, paneId: string) {
    assert.equal(paneId, '%7'); assert.equal(command, '/model'); assert.equal(this.opened, false);
    this.actions.push(command); this.opened = true; this.focus = this.current;
  }
  async key(key: Parameters<SettingDriver['key']>[0], paneId: string) {
    assert.equal(paneId, '%7'); assert.equal(this.opened, true); this.actions.push(key);
    if (key === 'Escape') this.opened = false;
    else if (key === 'Down') this.focus = Math.min(5, this.focus + 1);
    else if (key === 'Up') this.focus = Math.max(1, this.focus - 1);
    else if (key === 's') {
      assert.equal(this.focus, 5); this.current = 5; this.opened = false;
      this.history += `❯ /model\n  ⎿ Set model to ${this.receiptLabel} for this session only\n`;
    }
    else assert.fail(`Unexpected key: ${key}`);
  }
}

test('real SSH wrapped descriptions verify a successful Haiku selection without weakening catalog identity', async () => {
  const fixture = new CapturedSshMenuFixture(), menus = new NativeSettings();
  const initial = await menus.get(fixture, context, 'model');
  const target = initial.options.find(option => option.label === 'Haiku')!;
  assert.ok(target);
  const verified = await menus.set(fixture, context, initial.token, target.id);
  assert.equal(verified.options.find(option => option.current)?.label, 'Haiku');
  assert.equal(verified.options.find(option => option.current)?.description, target.description);
  assert.deepEqual(fixture.actions, ['/model', 'Escape', '/model', 'Down', 'Down', 'Down', 'Down', 's']);
  assert.equal(fixture.opened, false);
});

test('a changed wrapped description blocks stale application and a different native receipt cannot confirm the selection', async () => {
  const before = new CapturedSshMenuFixture(), beforeMenus = new NativeSettings();
  const first = await beforeMenus.get(before, context, 'model');
  before.before = before.before.replace('prompts over 100k)', 'prompts over 200k)');
  await assert.rejects(beforeMenus.set(before, context, first.token, first.options.find(option => option.label === 'Haiku')!.id), /已变化/);
  assert.equal(before.actions.includes('s'), false);
  const after = new CapturedSshMenuFixture(), afterMenus = new NativeSettings();
  const second = await afterMenus.get(after, context, 'model');
  after.receiptLabel = 'Haiku 4.5';
  await assert.rejects(afterMenus.set(after, context, second.token, second.options.find(option => option.label === 'Haiku')!.id), /可能已生效.*未完成核验/);
  assert.equal(after.actions.filter(action => action === 's').length, 1);
});

class NativeMenuFixture implements SettingDriver {
  paneId = '%7';
  kind?: SessionSettingKind;
  currentModel = 1;
  currentEffort = 1;
  focus = 1;
  modelLabels = Array.from({ length: 11 }, (_, i) => `Provider choice ${i + 1}`);
  modelDescriptions?: string[];
  effortLabels = ['quick', 'balanced', 'careful', 'thorough'];
  actions: string[] = [];
  history = '';
  draft = '';
  sessionOnly = true;
  ignoreApply = false;
  cacheConfirmation = false;
  pendingModel?: number;
  confirmationLabel?: string;
  confirmationFocus: 'confirm' | 'cancel' = 'confirm';
  unknownConfirmation = false;
  confirmationFrame?: string;
  receiptLabel?: string;
  recordReceipt(kind: SessionSettingKind) {
    const label = this.receiptLabel ?? (kind === 'model' ? this.modelLabels[this.currentModel] : this.effortLabels[this.currentEffort]);
    const message = kind === 'model' ? `Set model to ${label} for this session only` : `Set effort level to ${label} (this session only): Observed effort`;
    this.history += `\n❯ /${kind}\n  ⎿ ${message}\n`;
  }
  onInspect?: () => Promise<void>;
  onKey?: (key: string) => void;
  async inspect() {
    await this.onInspect?.();
    let viewport = this.history + composer.replace('❯ ', `❯ ${this.draft}`);
    if (this.kind === 'model') {
      const start = Math.max(0, Math.min(this.focus - 1, this.modelLabels.length - 3));
      const rows = this.modelLabels.slice(start, start + 3).map((label, index) => {
        const ordinal = start + index;
        return ` ${ordinal === this.focus ? '❯' : ' '} ${ordinal + 1}. ${label}${ordinal === this.currentModel ? ' ✔' : ''}  ${this.modelDescriptions?.[ordinal] ?? 'Observed provider description'}`;
      });
      viewport = `${this.history}\nSelect model\n${start ? `↑ ${start} more\n` : ''}${rows.join('\n')}\n${start + 3 < this.modelLabels.length ? `↓ ${this.modelLabels.length - start - 3} more\n` : ''}\nEnter to set as default · ${this.sessionOnly ? 's to use this session only · ' : ''}Esc to cancel\n`;
    } else if (this.kind === 'effort') {
      const labels = this.effortLabels.map(label => label.padEnd(12)).join('');
      const pointer = this.focus * 12 + Math.floor((this.effortLabels[this.focus].length - 1) / 2);
      const track = '─'.repeat(labels.length - 1);
      viewport = `Effort\nFaster                Smarter\n${track.slice(0, pointer)}▲${track.slice(pointer + 1)}\n${labels}\n←/→ to adjust · Enter to confirm · ${this.sessionOnly ? 's for this session only · ' : ''}Esc to cancel\n`;
    }
    if (this.pendingModel !== undefined) {
      const label = this.confirmationLabel ?? this.modelLabels[this.pendingModel];
      viewport = `Switch model?\nYour next response will be slower and use more tokens\n\n${this.unknownConfirmation ? 'Unrecognized account configuration request' : `This conversation is cached for the current model. Switching to ${label} means the full history gets re-read.`}\n\n${this.confirmationFocus === 'confirm' ? '❯' : ' '} 1. Yes, switch to ${label}\n${this.confirmationFocus === 'cancel' ? '❯' : ' '} 2. No, go back\n\nEnter to confirm · Esc to cancel\n`;
      viewport = this.confirmationFrame ?? viewport;
    }
    return { paneId: this.paneId, viewport };
  }
  async type(command: string, expectedPane: string) {
    assert.equal(expectedPane, this.paneId);
    assert.equal(this.kind, undefined);
    this.actions.push(command);
    if (command !== '/model' && command !== '/effort') throw new Error('Unexpected command');
    this.kind = command === '/model' ? 'model' : 'effort';
    this.focus = this.kind === 'model' ? this.currentModel : this.currentEffort;
  }
  async key(key: Parameters<SettingDriver['key']>[0], expectedPane: string) {
    assert.equal(expectedPane, this.paneId);
    this.actions.push(key);
    if (this.pendingModel !== undefined) {
      if (key === 'Enter') {
        assert.equal(this.confirmationFocus, 'confirm');
        if (!this.ignoreApply) this.currentModel = this.pendingModel;
        this.recordReceipt('model');
        this.pendingModel = undefined;
      } else if (key === 'Up') this.confirmationFocus = 'confirm';
      else if (key === 'Escape') this.pendingModel = undefined;
      else assert.fail(`Unexpected confirmation key: ${key}`);
      this.onKey?.(key); return;
    }
    assert.ok(this.kind);
    if (key === 'Escape') this.kind = undefined;
    else if (key === 's') {
      if (this.kind === 'model' && this.cacheConfirmation) this.pendingModel = this.focus;
      else {
        if (!this.ignoreApply) { if (this.kind === 'model') this.currentModel = this.focus; else this.currentEffort = this.focus; }
        this.recordReceipt(this.kind);
      }
      this.kind = undefined;
    } else {
      const max = (this.kind === 'model' ? this.modelLabels : this.effortLabels).length - 1;
      this.focus = Math.max(0, Math.min(max, this.focus + (key === 'Up' || key === 'Left' ? -1 : 1)));
    }
    this.onKey?.(key);
  }
}

test('model-list choices bind to the target pane with no current row, and a choice uses the target row and receipt', async () => {
  const menus = new NativeSettings(), helper = new NativeMenuFixture(), target = new NativeMenuFixture();
  helper.paneId = '%18'; helper.modelLabels = ['Atlas', 'Birch', 'Cedar']; helper.currentModel = 0;
  target.modelLabels = ['Cedar', 'Atlas', 'Birch']; target.currentModel = 0;
  target.effortLabels = ['careful', 'quick', 'balanced']; target.currentEffort = 2;
  for (const kind of ['model', 'effort'] as const) {
    const catalog = choicesOf(helper, kind);
    const paneMenu = menus.bindChoices(context, target.paneId, catalog);
    assert.equal(paneMenu.currentOptionId, undefined);
    assert.ok(paneMenu.options.every(option => !option.current));
    assert.deepEqual(target.actions, []);
    const applied = await menus.set(target, context, paneMenu.token, paneMenu.options[0].id);
    assert.equal(applied.options.find(option => option.current)?.label, paneMenu.options[0].label);
    assert.deepEqual(target.actions, kind === 'model' ? ['/model', 'Down', 's'] : ['/effort', 'Left', 's']);
    await assert.rejects(menus.set(target, context, paneMenu.token, paneMenu.options[0].id), /过期/);
    target.actions = [];
  }
  assert.deepEqual(helper.actions, [], 'no other terminal is read');
});

test('portable choices require an unambiguous enabled identity in the target and never resave the active row', async () => {
  const menus = new NativeSettings(), helper = new NativeMenuFixture();
  helper.modelLabels = ['Atlas', 'Birch', 'Birch'];
  const catalog = choicesOf(helper, 'model');
  assert.deepEqual(menus.bindChoices(context, helper.paneId, catalog).options.map(option => !!option.disabled), [false, true, true],
    'rows the native menu cannot tell apart are not offered');
  for (const labels of [['Birch', 'Elm'], ['Atlas (disabled)', 'Birch'], ['Atlas', 'Atlas'], ['Atlas', 'Birch']]) {
    const target = new NativeMenuFixture();
    target.modelLabels = labels;
    if (labels.join(',') === 'Atlas,Birch') target.modelDescriptions = ['Changed provider identity', 'Observed provider description'];
    const menu = menus.bindChoices(context, target.paneId, catalog);
    await assert.rejects(menus.set(target, context, menu.token, menu.options[0].id), /无法唯一确认/);
    assert.deepEqual(target.actions, ['/model', 'Escape']);
  }
  const target = new NativeMenuFixture();
  target.modelLabels = ['Elm', 'Atlas'];
  const menu = menus.bindChoices(context, target.paneId, catalog);
  const unchanged = await menus.set(target, context, menu.token, menu.options[0].id);
  assert.equal(unchanged.options.find(option => option.current)?.label, 'Atlas');
  assert.deepEqual(target.actions, ['/model', 'Escape']);
});

test('expired and foreign target tickets cannot send input, and a cached catalog can be rebound without either terminal', async t => {
  const menus = new NativeSettings(), helper = new NativeMenuFixture(), target = new NativeMenuFixture();
  helper.modelLabels = target.modelLabels = ['Atlas', 'Elm'];
  const catalog = choicesOf(helper, 'model');
  const first = menus.bindChoices(context, target.paneId, catalog);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(first.observedAt) });
  t.mock.timers.tick(sessionSettingTicketLifetimeMs);
  await assert.rejects(menus.set(target, context, first.token, first.options[0].id), /过期/);
  const second = menus.bindChoices(context, target.paneId, catalog);
  await assert.rejects(menus.set(target, { ...context, targetKey: 'other' }, second.token, second.options[0].id), /不属于/);
  await assert.rejects(menus.set(target, { ...context, sessionId: randomUUID() }, second.token, second.options[0].id), /不属于/);
  target.paneId = '%201';
  await assert.rejects(menus.set(target, context, second.token, second.options[0].id), /其他 tmux pane/);
  assert.deepEqual(helper.actions, []);
  assert.deepEqual(target.actions, []);
});

test('a stale, absent, or wrongly scoped receipt is uncertain without another command or save', async () => {
  const menus = new NativeSettings(), helper = new NativeMenuFixture();
  helper.modelLabels = ['Default (recommended)', 'Simple'];
  helper.modelDescriptions = ['Use the default model (currently Opus 5.5) · Cost', 'Simple model'];
  const catalog = choicesOf(helper, 'model');
  for (const result of ['stale', 'absent', 'global', 'accepted']) {
    const target = new NativeMenuFixture();
    target.modelLabels = helper.modelLabels; target.modelDescriptions = helper.modelDescriptions;
    const ack = '❯ /model\n  ⎿ Set model to Opus 5.5 (default) for this session only\n';
    if (result === 'stale') target.history = ack;
    target.recordReceipt = () => {
      if (result === 'accepted') target.history += ack + "\n           tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking\n";
      if (result === 'global') target.history += ack.replace('for this session only', 'as your default');
    };
    const menu = menus.bindChoices(context, target.paneId, catalog);
    const pending = menus.set(target, context, menu.token, menu.options[0].id);
    if (result === 'accepted') assert.equal((await pending).options.find(option => option.current)?.label, 'Default (recommended)');
    else await assert.rejects(pending, /未完成核验/);
    assert.deepEqual(target.actions, ['/model', 'Up', 's']);
    await assert.rejects(menus.set(target, context, menu.token, menu.options[0].id), /过期/);
  }
});

test('API-error recovery reads model then effort without timing out after native close acknowledgements', async () => {
  class RecoveryFixture extends NativeMenuFixture {
    override history = '❯ Connectivity check\n\n● API Error: 400 Unsupported model: provider-choice\n';
    override draft = 'Once fixed, resend your message';
    override modelLabels = ['Observed provider A', 'Observed provider B'];
    override async key(key: Parameters<SettingDriver['key']>[0], expectedPane: string) {
      const closing = this.kind;
      await super.key(key, expectedPane);
      if (key === 'Escape') this.history += closing === 'model'
        ? `\n❯ /model\n  ⎿ \u00a0Kept model as ${this.modelLabels[this.currentModel]}\n`
        : '\n❯ /effort\n  ⎿ \u00a0Cancelled\n';
    }
  }
  const fixture = new RecoveryFixture(), menus = new NativeSettings();
  const model = await menus.get(fixture, context, 'model');
  const effort = await menus.get(fixture, context, 'effort');
  assert.equal(model.complete, true);
  assert.equal(effort.complete, true);
  assert.deepEqual(fixture.actions, ['/model', 'Escape', '/effort', 'Escape']);
  assert.equal(fixture.kind, undefined);
  assert.equal(fixture.draft, 'Once fixed, resend your message');
});

test('API-error recovery verifies a session-only model change after several closed settings menus', async () => {
  class RecoveryApplyFixture extends NativeMenuFixture {
    override history = '❯ Connectivity check\n\n● API Error: 400 Unsupported model: provider-choice\n'
      + '\n❯ /model\n  ⎿ Kept model as Observed provider B\n'.repeat(3)
      + '\n❯ /effort\n  ⎿ Cancelled\n';
    override draft = 'Once fixed, resend your message';
    override modelLabels = ['Observed provider A', 'Observed provider B'];
    override async key(key: Parameters<SettingDriver['key']>[0], expectedPane: string) {
      const kind = this.kind;
      await super.key(key, expectedPane);
      if (kind === 'model' && key === 'Escape') {
        const acknowledgement = `Kept model as ${this.modelLabels[this.currentModel]}`;
        this.history += `\n❯ /model\n  ⎿ \u00a0${acknowledgement}\n`;
      }
    }
  }
  const fixture = new RecoveryApplyFixture(), menus = new NativeSettings(2000);
  const initial = await menus.get(fixture, context, 'model');
  const target = initial.options.find(option => option.label === 'Observed provider A')!;
  const applied = await menus.set(fixture, context, initial.token, target.id);
  assert.equal(applied.options.find(option => option.current)?.label, 'Observed provider A');
  assert.deepEqual(fixture.actions, ['/model', 'Escape', '/model', 'Up', 's']);
  assert.equal(fixture.kind, undefined);
  assert.equal(fixture.draft, 'Once fixed, resend your message');
});

test('native model reads enumerate every page, preserve current, and apply only session shortcut with fresh verification', async () => {
  const menus = new NativeSettings(), fixture = new NativeMenuFixture();
  const initial = await menus.get(fixture, context, 'model');
  assert.equal(initial.command, '/model');
  assert.equal(initial.complete, true);
  assert.deepEqual(initial.options.map(option => option.label), fixture.modelLabels);
  assert.equal(initial.options.find(option => option.current)?.label, fixture.modelLabels[1]);
  assert.equal(fixture.currentModel, 1);
  assert.equal(fixture.kind, undefined);
  assert.equal(fixture.actions.filter(action => action === 's').length, 0);
  const target = initial.options[9];
  const verified = await menus.set(fixture, context, initial.token, target.id);
  assert.equal(fixture.currentModel, 9);
  assert.equal(verified.options.find(option => option.id === verified.currentOptionId)?.label, target.label);
  assert.notEqual(verified.token, initial.token);
  assert.notEqual(verified.currentOptionId, target.id);
  assert.equal(fixture.actions.filter(action => action === 's').length, 1);
  assert.equal(fixture.actions.includes('Enter'), false);
  assert.equal(fixture.actions.includes('/models'), false);
  assert.equal(fixture.kind, undefined);
  await assert.rejects(menus.set(fixture, context, initial.token, target.id), /过期/);
});

test('effort options come from observed slider columns and the native save receipt confirms application', async () => {
  const menus = new NativeSettings(), fixture = new NativeMenuFixture();
  const initial = await menus.get(fixture, context, 'effort');
  assert.equal(initial.complete, true);
  assert.deepEqual(initial.options.map(option => option.label), fixture.effortLabels);
  assert.equal(initial.options.find(option => option.current)?.label, 'balanced');
  const verified = await menus.set(fixture, context, initial.token, initial.options[3].id);
  assert.equal(verified.options.find(option => option.current)?.label, 'thorough');
  assert.deepEqual(fixture.actions, ['/effort', 'Escape', '/effort', 'Right', 'Right', 's']);
});

test('scrolls to the nearer advertised end first and observes every model', async () => {
  const fixture = new NativeMenuFixture();
  fixture.currentModel = 7;
  const menu = await new NativeSettings().get(fixture, context, 'model');
  assert.equal(menu.complete, true);
  assert.deepEqual(menu.options.map(option => option.label), fixture.modelLabels);
  assert.equal(menu.options.find(option => option.current)?.label, fixture.modelLabels[7]);
  assert.deepEqual(fixture.actions, ['/model', 'Down', 'Down', ...Array(8).fill('Up'), 'Escape']);
});

test('stale current, changed choices, missing session-only controls, and foreign tickets cannot apply', async () => {
  const menus = new NativeSettings(), fixture = new NativeMenuFixture();
  fixture.modelLabels = fixture.modelLabels.slice(0, 3);
  const first = await menus.get(fixture, context, 'model');
  await assert.rejects(menus.set(fixture, { ...context, sessionId: randomUUID() }, first.token, first.options[0].id), /不属于/);
  fixture.currentModel = 2;
  await assert.rejects(menus.set(fixture, context, first.token, first.options[0].id), /已变化/);
  assert.equal(fixture.kind, undefined);
  assert.equal(fixture.actions.includes('s'), false);
  const next = await menus.get(fixture, context, 'model');
  fixture.modelLabels[0] = 'A newly supplied native option';
  await assert.rejects(menus.set(fixture, context, next.token, next.options[0].id), /已变化/);
  fixture.sessionOnly = false;
  const incomplete = await menus.get(fixture, context, 'model');
  assert.equal(incomplete.complete, false);
  await assert.rejects(menus.set(fixture, context, incomplete.token, incomplete.options[0].id), /未完整/);
  assert.equal(fixture.actions.includes('s'), false);
});

test('draft and unknown dialog guards never clear input or escape an unrelated menu', async () => {
  const fixture = new NativeMenuFixture(), menus = new NativeSettings(100);
  fixture.draft = 'my unfinished message';
  await assert.rejects(menus.get(fixture, context, 'model'), /输入框为空/);
  assert.deepEqual(fixture.actions, []);
  fixture.draft = '';
  fixture.type = async () => { fixture.inspect = async () => ({ paneId: fixture.paneId, viewport: 'Unfamiliar account confirmation\nPress Enter to continue' }); };
  await assert.rejects(menus.get(fixture, context, 'model'), /超时/);
  assert.deepEqual(fixture.actions, []);
});

test('old unsupported-command frames are ignored until the new native menu renders; no alternate command is tried', async () => {
  const fixture = new NativeMenuFixture(), menus = new NativeSettings();
  fixture.modelLabels = fixture.modelLabels.slice(0, 3);
  fixture.history = '❯ /model\n⏺ Unknown command: /model.\n';
  const baseline = await fixture.inspect(), inspect = fixture.inspect.bind(fixture);
  let staleFrames = 2;
  fixture.inspect = async () => fixture.kind && staleFrames-- > 0 ? baseline : inspect();
  const result = await menus.get(fixture, context, 'model');
  assert.equal(result.complete, true);
  assert.deepEqual(fixture.actions, ['/model', 'Escape']);
  const unsupported = new NativeMenuFixture();
  unsupported.type = async command => { unsupported.actions.push(command); unsupported.history = `❯ ${command}\n⏺ Unknown command: ${command}.\n`; };
  await assert.rejects(menus.get(unsupported, context, 'effort'), /未提供/);
  assert.deepEqual(unsupported.actions, ['/effort']);
});

test('timeout cleanup reobserves its own menu, while a changed pane never receives cleanup input', async () => {
  const fixture = new NativeMenuFixture(), menus = new NativeSettings(20);
  let delayed = false;
  fixture.onInspect = async () => { if (fixture.kind && !delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 40)); } };
  await assert.rejects(menus.get(fixture, context, 'model'), /超时/);
  assert.equal(fixture.kind, undefined);
  assert.deepEqual(fixture.actions, ['/model', 'Escape']);
  const rebound = new NativeMenuFixture();
  rebound.onKey = key => { if (key === 'Down') rebound.paneId = '%8'; };
  await assert.rejects(new NativeSettings().get(rebound, context, 'model'), /绑定已改变/);
  assert.equal(rebound.actions.includes('Escape'), false);
});

test('failed post-save verification reports uncertainty and never replays the save', async () => {
  const fixture = new NativeMenuFixture(), menus = new NativeSettings();
  const read = await menus.get(fixture, context, 'effort');
  fixture.ignoreApply = true;
  await assert.rejects(menus.set(fixture, context, read.token, read.options[0].id), /可能已生效.*未完成核验/);
  assert.equal(fixture.actions.filter(action => action === 's').length, 1);
  assert.equal(fixture.kind, undefined);
  await assert.rejects(menus.set(fixture, context, read.token, read.options[0].id), /过期/);
});

test('external current-model changes during navigation abort before session save', async () => {
  const fixture = new NativeMenuFixture(), menus = new NativeSettings();
  fixture.modelLabels = fixture.modelLabels.slice(0, 3);
  const read = await menus.get(fixture, context, 'model');
  fixture.onKey = key => { if (key === 'Up') fixture.currentModel = 2; };
  await assert.rejects(menus.set(fixture, context, read.token, read.options[0].id), /定位选项期间.*已变化/);
  assert.equal(fixture.actions.includes('s'), false);
  assert.equal(fixture.kind, undefined);
});

test('only the requested model cache-cost confirmation receives one Enter, followed by fresh native verification', async () => {
  for (const initialFocus of ['confirm', 'cancel'] as const) {
    const fixture = new NativeMenuFixture(), menus = new NativeSettings();
    fixture.modelLabels = fixture.modelLabels.slice(0, 3);
    fixture.cacheConfirmation = true; fixture.confirmationFocus = initialFocus;
    const read = await menus.get(fixture, context, 'model');
    const verified = await menus.set(fixture, context, read.token, read.options[0].id);
    assert.equal(verified.options.find(option => option.current)?.label, fixture.modelLabels[0]);
    assert.match(verified.detail!, /重新读取会话历史/);
    const afterSave = fixture.actions.slice(fixture.actions.indexOf('s') + 1);
    assert.deepEqual(afterSave, [...(initialFocus === 'cancel' ? ['Up'] : []), 'Enter']);
    assert.equal(fixture.pendingModel, undefined);
  }
});

function legacySshConfirmationFixture() {
  const fixture = new NativeMenuFixture();
  fixture.modelLabels = ['Haiku', 'Sonnet']; fixture.currentModel = 0;
  fixture.modelDescriptions = ['Haiku 5.5 · Fastest for quick answers', 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok'];
  fixture.cacheConfirmation = true;
  fixture.confirmationFrame = readFileSync(new URL('./fixtures/settings/model-confirmation-ssh-no-footer.txt', import.meta.url), 'utf8');
  return fixture;
}

test('real no-footer SSH confirmation accepts only the exact full model name observed in its live description', async () => {
  const fixture = legacySshConfirmationFixture(), menus = new NativeSettings();
  const read = await menus.get(fixture, context, 'model');
  const target = read.options.find(option => option.label === 'Sonnet')!;
  const verified = await menus.set(fixture, context, read.token, target.id);
  assert.equal(verified.options.find(option => option.current)?.label, 'Sonnet');
  assert.equal(verified.options.find(option => option.current)?.description, target.description);
  assert.deepEqual(fixture.actions, ['/model', 'Escape', '/model', 'Down', 's', 'Enter']);
});

test('model family, substring and different-version confirmation targets cannot match the observed full name', async () => {
  for (const target of ['Sonnet 5', 'Sonnet 5.5 preview', 'Custom Sonnet 5.5', '5.5', 'sonnet 5.5']) {
    const fixture = legacySshConfirmationFixture(), menus = new NativeSettings();
    fixture.confirmationFrame = fixture.confirmationFrame!.replaceAll('Sonnet 5.5', target);
    const read = await menus.get(fixture, context, 'model');
    await assert.rejects(menus.set(fixture, context, read.token, read.options.find(option => option.label === 'Sonnet')!.id), /模型与本次选择不一致/);
    assert.equal(fixture.actions.includes('Enter'), false);
    assert.deepEqual(fixture.actions.slice(fixture.actions.indexOf('s') + 1), []);
  }
  const noSegment = legacySshConfirmationFixture(), menus = new NativeSettings();
  noSegment.modelDescriptions![1] = 'Sonnet 5.5';
  const read = await menus.get(noSegment, context, 'model');
  await assert.rejects(menus.set(noSegment, context, read.token, read.options[1].id), /模型与本次选择不一致/);
  assert.equal(noSegment.actions.includes('Enter'), false);
});

test('description-name confirmation still requires a matching model in the save receipt', async () => {
  const fixture = legacySshConfirmationFixture(), menus = new NativeSettings();
  fixture.receiptLabel = 'Sonnet 5.5 preview';
  const read = await menus.get(fixture, context, 'model');
  await assert.rejects(menus.set(fixture, context, read.token, read.options[1].id), /可能已生效.*未完成核验/);
  assert.equal(fixture.actions.filter(action => action === 's').length, 1);
  assert.equal(fixture.actions.filter(action => action === 'Enter').length, 1);
});

test('wrong-target and unknown switch confirmations receive no keys and preserve the native dialog', async () => {
  for (const variant of ['wrong-target', 'unknown-dialog'] as const) {
    const fixture = new NativeMenuFixture(), menus = new NativeSettings(650);
    fixture.modelLabels = fixture.modelLabels.slice(0, 3); fixture.cacheConfirmation = true;
    if (variant === 'wrong-target') fixture.confirmationLabel = 'A model the user did not choose';
    else fixture.unknownConfirmation = true;
    const read = await menus.get(fixture, context, 'model');
    await assert.rejects(menus.set(fixture, context, read.token, read.options[0].id), /未完成核验/);
    assert.equal(fixture.pendingModel, 0);
    assert.equal(fixture.currentModel, 1);
    assert.deepEqual(fixture.actions.slice(fixture.actions.indexOf('s') + 1), []);
  }
});

test('accepting the known cache dialog is insufficient without a matching native receipt', async () => {
  const fixture = new NativeMenuFixture(), menus = new NativeSettings();
  fixture.modelLabels = fixture.modelLabels.slice(0, 3);
  fixture.cacheConfirmation = true; fixture.ignoreApply = true;
  const read = await menus.get(fixture, context, 'model');
  await assert.rejects(menus.set(fixture, context, read.token, read.options[0].id), /未完成核验/);
  assert.equal(fixture.actions.filter(action => action === 'Enter').length, 1);
  assert.equal(fixture.actions.filter(action => action === 's').length, 1);
  assert.equal(fixture.kind, undefined);
});

test('backend input lease rejects ordinary input, keys, and duplicate-workspace setting writes during a native change', async () => {
  const backend = new Backend(), fixture = new NativeMenuFixture();
  fixture.modelLabels = fixture.modelLabels.slice(0, 3);
  const workspace: Workspace = { id: 'a', name: 'Fixture', kind: 'local', cwd: '/tmp' };
  const helper = new NativeMenuFixture();
  helper.modelLabels = [...fixture.modelLabels];
  const catalog = choicesOf(helper, 'model');
  const ticket = backend.bindSettingChoices(workspace, context.sessionId, fixture.paneId, catalog);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  fixture.onInspect = async () => { if (first) { first = false; entered(); await held; } };
  (backend as any).settingDriver = () => fixture;
  try {
    const pending = backend.setSessionSetting(workspace, context.sessionId, ticket.token, ticket.options[0].id);
    await started;
    const alias: Workspace = { ...workspace, kind: 'ssh', id: 'alias', host: 'same-tmux-via-ssh' };
    for (const operation of [() => backend.sendMessage(workspace, context.sessionId, 'must not send'), () => backend.sendKey(alias, context.sessionId, 'Enter'), () => backend.setSessionSetting(alias, context.sessionId, ticket.token, ticket.options[0].id)]) {
      await assert.rejects(operation(), { name: 'SessionInputBusyError' });
    }
    const otherSession = randomUUID();
    // A separate UUID reaches the token check while the first one is held.
    await assert.rejects(backend.setSessionSetting(alias, otherSession, ticket.token, ticket.options[0].id), /不属于此会话/);
    release(); const verified = await pending;
    assert.equal(verified.options.find(option => option.current)?.label, ticket.options[0].label);
    assert.equal((backend as any).cursors.size, 0);
  } finally { release(); await backend.dispose(); }
});

test('expanded native inventory handles disclosure actions and disabled rows without treating either as a model choice', async () => {
  class OverflowMenu implements SettingDriver {
    open = false; expanded = false; focus = 0; selected = 0; actions: string[] = []; history = '';
    async inspect() {
      const labels = ['Active', 'Locked (disabled)', this.expanded ? '▾ More models' : '▸ More models', ...(this.expanded ? ['Custom'] : [])];
      const rows = labels.map((label, index) => `${index === this.focus ? '❯' : ' '} ${index === 2 ? '' : (index === 3 ? 3 : index + 1) + '. '}${label}${this.selected === index ? ' ✔' : ''}`);
      const hint = this.focus === 2 ? `Enter to ${this.expanded ? 'collapse' : 'expand'} · ` : this.focus === 1 ? '' : 'Enter to set as default · s to use this session only · ';
      return { paneId: '%7', viewport: this.open ? `Select model\n${rows.join('\n')}\n${hint}Esc to cancel\n` : this.history + composer };
    }
    async type(command: string) { assert.equal(command, '/model'); this.open = true; this.expanded = this.selected === 3; this.focus = this.selected; }
    async key(key: Parameters<SettingDriver['key']>[0]) {
      this.actions.push(key);
      if (key === 'Enter') { assert.equal(this.focus, 2); assert.equal(this.expanded, false); this.expanded = true; }
      else if (key === 'Down') this.focus++;
      else if (key === 'Up') this.focus--;
      else if (key === 'Escape') this.open = false;
      else if (key === 's') { assert.equal(this.focus, 3); this.selected = this.focus; this.open = false; this.history = '❯ /model\n  ⎿ Set model to Custom for this session only\n'; }
      else assert.fail(key);
    }
  }
  const driver = new OverflowMenu(), engine = new NativeSettings();
  const menu = await engine.get(driver, context, 'model');
  assert.equal(menu.complete, true);
  assert.deepEqual(menu.options.map(item => item.label), ['Active', 'Locked', 'Custom']);
  assert.equal(menu.options[1].disabled, true);
  await assert.rejects(engine.set(driver, context, menu.token, menu.options[1].id));
  const applied = await engine.set(driver, context, menu.token, menu.options[2].id);
  assert.equal(applied.options.find(item => item.current)?.label, 'Custom');
  assert.equal(driver.actions.filter(key => key === 's').length, 1);
});

test('effort cache cost is acknowledged once for the selected level; hook questions are left open', async () => {
  const fixture = new NativeMenuFixture(), engine = new NativeSettings();
  let pending = false;
  const inspect = fixture.inspect.bind(fixture), key = fixture.key.bind(fixture);
  fixture.inspect = async () => pending ? { paneId: '%7', viewport: 'Change effort level?\nYour next response will be slower and use more tokens\nThis conversation is cached for the current effort level. Switching to quick means the full history gets re-read.\n❯ 1. Yes, switch to quick\n2. No, go back\nEnter to confirm · Esc to cancel' } : inspect();
  fixture.key = async (value, pane) => {
    if (value === 's') { fixture.actions.push(value); pending = true; fixture.kind = undefined; return; }
    if (value === 'Enter') {
      assert.equal(pending, true); fixture.actions.push(value); pending = false; fixture.currentEffort = 0;
      fixture.history = '❯ /effort\n  ⎿ CLAUDE_CODE_EFFORT_LEVEL=high overrides this session — clear it and quick takes over\n'; return;
    }
    return key(value, pane);
  };
  const menu = await engine.get(fixture, context, 'effort');
  const applied = await engine.set(fixture, context, menu.token, menu.options[0].id);
  assert.match(applied.nativeFeedback!, /overrides this session/);
  assert.match(applied.detail!, /重新读取会话历史/);
  assert.equal(fixture.actions.filter(value => value === 'Enter').length, 1);
  const hook = legacySshConfirmationFixture();
  hook.confirmationFrame = hook.confirmationFrame!.replace('Your next response will be slower and use more tokens', 'A PreModelSwitch hook asked you to confirm');
  const models = await engine.get(hook, context, 'model');
  await assert.rejects(engine.set(hook, context, models.token, models.options[1].id), /PreModelSwitch hook/);
  assert.deepEqual(hook.actions.slice(hook.actions.indexOf('s') + 1), []);
});

test('menus opening directly below unchanged previous assistant output still work without accepting newly quoted examples', async () => {
  const fixture = new NativeMenuFixture(), engine = new NativeSettings();
  fixture.history = '❯ Last message\n⏺ Previous answer\n';
  fixture.modelLabels = fixture.modelLabels.slice(0, 3);
  assert.equal((await engine.get(fixture, context, 'model')).complete, true);
  assert.deepEqual(fixture.actions, ['/model', 'Escape']);
});

class CountedModelPages extends NativeMenuFixture {
  start = 0;
  behavior: 'native' | 'remapped' | 'ignored' | 'wrong-focus' | 'gap' = 'native';
  async permitsPageKey() { return this.behavior !== 'remapped'; }
  override async inspect() {
    if (this.kind !== 'model') return super.inspect();
    const rows = this.modelLabels.slice(this.start, this.start + 10).map((label, i) => {
      const at = this.start + i;
      return (this.focus === at ? '❯ ' : '  ') + (at + 1) + '. ' + label + (at === this.currentModel ? ' ✔' : '') + '  Observed model';
    });
    const after = this.modelLabels.length - this.start - rows.length;
    const viewport = ['Select model', this.start ? '↑ ' + this.start + ' more' : '', ...rows,
      after ? '↓ ' + after + ' more' : '', 'Enter to set as default · s to use this session only · Esc to cancel'].join('\n');
    return { paneId: this.paneId, viewport, stable: true };
  }
  override async type(command: string, pane: string) {
    await super.type(command, pane);
    this.start = Math.max(0, this.focus - 9);
  }
  override async key(key: Parameters<SettingDriver['key']>[0], pane: string) {
    if (!['Home', 'End', 'PageUp', 'PageDown'].includes(key)) await super.key(key, pane);
    else {
      assert.equal(pane, this.paneId); this.actions.push(key);
      if (this.behavior === 'native' || this.behavior === 'gap') {
        if (key === 'End') this.focus = this.modelLabels.length - 1;
        if (key === 'Home') this.focus = 0;
        if (key === 'PageDown') this.focus += 10;
        if (key === 'PageUp') this.focus -= 10;
      }
      if (this.behavior === 'wrong-focus') this.focus++;
    }
    this.start = Math.max(this.focus - 9, Math.min(this.start, this.focus));
    if (this.behavior === 'gap' && key === 'PageDown') this.start = this.focus;
  }
}

test('counted native model pages return the full observed catalog and checkmark with one End from row five', async () => {
  for (const [count, current, moves] of [[11, 4, ['End']], [28, 4, ['PageDown', 'PageDown', 'End']], [11, 10, ['Home']]] as const) {
    const fixture = new CountedModelPages();
    fixture.modelLabels = Array.from({ length: count }, (_, i) => 'Choice ' + i);
    fixture.currentModel = current;
    const menu = await new NativeSettings().get(fixture, context, 'model');
    assert.equal(menu.complete, true);
    assert.deepEqual(menu.options.map(item => item.label), fixture.modelLabels);
    assert.deepEqual(menu.options.filter(item => item.current).map(item => item.label), [fixture.modelLabels[current]]);
    assert.deepEqual(fixture.actions, ['/model', ...moves, 'Escape']);
  }
});

test('model catalog retains single-arrow reads for remapped or unhandled native page navigation', async () => {
  for (const behavior of ['remapped', 'ignored'] as const) {
    const fixture = new CountedModelPages(); fixture.currentModel = 4; fixture.behavior = behavior;
    const menu = await new NativeSettings().get(fixture, context, 'model');
    assert.equal(menu.complete, true); assert.equal(menu.options.length, 11);
    assert.deepEqual(fixture.actions, ['/model', ...(behavior === 'ignored' ? ['End'] : []), ...Array(6).fill('Down'), 'Escape']);
  }
});

test('wrong focus or skipped model ranges never create a usable ticket', async () => {
  for (const behavior of ['wrong-focus', 'gap'] as const) {
    const fixture = new CountedModelPages(); fixture.currentModel = 4; fixture.behavior = behavior;
    fixture.modelLabels = Array.from({ length: 32 }, (_, i) => 'Choice ' + i);
    await assert.rejects(new NativeSettings().get(fixture, context, 'model'), /翻页后的焦点、行号或数量/);
    assert.deepEqual(fixture.actions, ['/model', 'PageDown', 'Escape']);
  }
});

class NavigationRedraw extends CountedModelPages {
  readonly guardsViewport = true;
  redrawKind: SessionSettingKind = 'model';
  target: 'Home' | 'End' | 'Left' | 'Right' | 'Escape' = 'End';
  attempts = 0;
  change: 'ruler' | 'focus' | 'text' | 'draft' | 'footer' | 'repeat' | 'unknown-receipt' = 'ruler';
  override async inspect() {
    const result = await super.inspect();
    if (this.kind !== this.redrawKind) return result;
    // Native 2.1.326 recovery trace, frames 784 and 804. Only this advisory
    // above the Select model heading disappeared between capture and dispatch.
    const border = this.attempts ? '▔'.repeat(120) : "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking ▔";
    let viewport = border + '\n' + result.viewport;
    if (this.attempts && this.change === 'text') viewport = viewport.replace(/(Select model|Effort)\n/, '$1\nUnfamiliar prompt\n');
    if (this.attempts && this.change === 'draft') viewport = composer.replace('❯ ', '❯ unsent draft');
    if (this.attempts && this.change === 'footer') viewport = viewport.replace(/s (?:to use this|for this) session only · /, '');
    return { ...result, viewport };
  }
  override async key(key: Parameters<SettingDriver['key']>[0], pane: string) {
    if (key === this.target) {
      this.attempts++;
      if (this.attempts === 1 || this.change === 'repeat') {
        if (this.change === 'focus') this.focus++;
        if (this.change === 'unknown-receipt') throw new Error(new NavigationKeyNotSent().message);
        throw new NavigationKeyNotSent();
      }
    }
    await super.key(key, pane);
  }
}

test('a positive not-sent receipt permits one guarded model navigation or read-only dismissal after the native focus-events ruler disappears', async () => {
  for (const target of ['End', 'Home', 'Escape'] as const) {
    const fixture = new NavigationRedraw(); fixture.target = target;
    fixture.currentModel = target === 'Home' ? 10 : 4;
    const menu = await new NativeSettings().get(fixture, context, 'model');
    assert.equal(menu.complete, true);
    assert.equal(menu.options.length, 11);
    assert.equal(menu.options.findIndex(x => x.current), fixture.currentModel);
    assert.equal(fixture.attempts, 2);
    assert.equal(fixture.actions.filter(x => x === target).length, 1);
  }
});

test('a changed model focus, body, footer or native draft stops navigation and leaves the current screen alone', async () => {
  for (const change of ['focus', 'text', 'footer', 'draft'] as const) {
    const fixture = new NavigationRedraw(); fixture.currentModel = 4; fixture.change = change;
    await assert.rejects(new NativeSettings().get(fixture, context, 'model'), /原生菜单或焦点已改变/);
    assert.equal(fixture.attempts, 1); assert.deepEqual(fixture.actions, ['/model']);
  }
});

test('an uncertain receipt cannot redispatch a navigation key and the second explicit refusal has no third attempt', async () => {
  for (const change of ['repeat', 'unknown-receipt'] as const) {
    for (const target of ['End', 'Escape'] as const) {
      const fixture = new NavigationRedraw(); fixture.currentModel = 4; fixture.change = change; fixture.target = target;
      await assert.rejects(new NativeSettings().get(fixture, context, 'model'), /未发送按键/);
      assert.equal(fixture.attempts, change === 'repeat' ? 2 : 1);
      assert.equal(fixture.actions.filter(x => x === target).length, 0);
    }
  }
});

test('one explicit not-sent receipt permits Left or Right on an unchanged effort slider, and never replays the save', async () => {
  for (const arrow of ['Left', 'Right'] as const) {
    const menus = new NativeSettings(), target = new NavigationRedraw();
    target.redrawKind = 'effort'; target.target = arrow;
    const catalog = choicesOf(new NativeMenuFixture(), 'effort');
    const ticket = menus.bindChoices(context, target.paneId, catalog);
    const choice = ticket.options[arrow === 'Left' ? 0 : 2];
    const result = await menus.set(target, context, ticket.token, choice.id);
    assert.equal(result.options.find(option => option.current)?.label, choice.label);
    assert.deepEqual(target.actions, ['/effort', arrow, 's']);
    assert.equal(target.attempts, 2);
  }
});

test('an effort dismissal survives the one native ruler change captured over SSH', async () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/settings/ssh-effort-focus-events.json', import.meta.url), 'utf8'));
  const menus = new NativeSettings(), fixture = new NavigationRedraw();
  fixture.redrawKind = 'effort'; fixture.target = 'Escape';
  fixture.inspect = async () => ({
    paneId: fixture.paneId, stable: true,
    viewport: !fixture.kind ? capture.before : fixture.attempts ? capture.settled : capture.opening,
  });
  const catalog = await menus.get(fixture, context, 'effort');
  assert.equal(catalog.complete, true);
  assert.equal(fixture.attempts, 2);
  assert.deepEqual(fixture.actions, ['/effort', 'Escape']);
});

test('the atomic effort guard permits only paint in the label under the native pointer', { skip: process.platform === 'win32' }, () => {
  const base = '\x1b[38;5;147m', shine = '\x1b[38;5;189m';
  const history = '❯ /model\n  ⎿ Kept model\n❯ /effort\n  ⎿ Cancelled\n';
  for (const label of ['xhigh', 'max']) {
    const labels = '   low     medium     high     xhigh      max       Tab to toggle';
    const start = labels.indexOf(label);
    const pointer = start + Math.floor(label.length / 2);
    const track = '   ' + '─'.repeat(pointer - 3) + '▲' + '─'.repeat(46 - pointer);
    const frame = (before: string, paint: string) => before + [
      '▔'.repeat(60), '   Effort', '', track, labels.slice(0, start) + paint + labels.slice(start + label.length),
      '', '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel', '',
    ].join('\n');
    const paint = (body: string) => '\x1b[1m' + body + '\x1b[0m\x1b[39m\x1b[49m';
    const phases = [paint(base + label), ...Array.from(label, (letter, n) => paint(
      (n ? base + label.slice(0, n) : '') + shine + letter + (n < label.length - 1 ? base + label.slice(n + 1) : '')))];
    if (label === 'max') phases.push('\x1b[38;2;250;30;40mm\x1b[38;2;245;125;35ma\x1b[38;2;255;240;10mx\x1b[39m');
    for (const before of ['', history]) {
      const observed = frame(before, phases[0]);
      // The business guard hashes the full frame, the query pane can start at the ruler.
      const tail = before ? 7 : undefined;
      const source = tail ? 'tail -n ' + tail : 'cat';
      const guard = effortFrameGuard(observed, tail);
      assert.ok(guard.filter);
      const digestInput = (input: string) => execFileSync('sh', ['-c', source + guard.filter], { input, encoding: 'utf8' });
      const expected = tail ? guard.viewport.split('\n').slice(-tail - 1).join('\n') : guard.viewport;
      for (const phase of phases) {
        const painted = frame(before, phase);
        assert.equal(digestInput(painted), expected);
        assert.equal(effortFrameGuard(painted).viewport, guard.viewport);
      }
      for (const changed of [
        observed.replace('─▲', '▲─'), observed.replace('Tab to toggle', 'Tab to continue'),
        observed.replace('s for this session only', 's to save'), observed.replace('low', '\x1b[1mlow\x1b[0m'),
        observed.replace(base, '\x1b[8m' + base), observed.replace(base + label, base + label.toUpperCase()),
      ]) assert.notEqual(digestInput(changed), expected);
      assert.equal(effortFrameGuard(observed + '❯ unsent draft\n').filter, '');
    }
  }
});

test('a changed effort menu, a second refusal or an uncertain receipt never replays a slider movement', async () => {
  for (const change of ['focus', 'text', 'draft', 'footer', 'repeat', 'unknown-receipt'] as const) {
    const menus = new NativeSettings(), target = new NavigationRedraw();
    target.redrawKind = 'effort'; target.target = 'Left'; target.change = change;
    const catalog = choicesOf(new NativeMenuFixture(), 'effort');
    const ticket = menus.bindChoices(context, target.paneId, catalog);
    await assert.rejects(menus.set(target, context, ticket.token, ticket.options[0].id));
    assert.equal(target.attempts, change === 'repeat' ? 2 : 1);
    assert.equal(target.actions.includes('Left'), false);
    assert.equal(target.actions.includes('s'), false);
  }
});

test('even a presentation-only change elsewhere in the SSH effort frame cannot authorize a second Escape', async () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/settings/ssh-effort-focus-events.json', import.meta.url), 'utf8'));
  for (const changed of [
    capture.settled.replace('Recorded answer.', 'Recorded answer. '),
    capture.opening.replace('reattach for focus tracking', 'reattach to continue'),
  ]) {
    const fixture = new NavigationRedraw();
    fixture.redrawKind = 'effort'; fixture.target = 'Escape';
    fixture.inspect = async () => ({ paneId: fixture.paneId, stable: true,
      viewport: !fixture.kind ? capture.before : fixture.attempts ? changed : capture.opening });
    await assert.rejects(new NativeSettings().get(fixture, context, 'effort'), /未发送按键/);
    assert.equal(fixture.attempts, 1);
    assert.deepEqual(fixture.actions, ['/effort']);
  }
});
