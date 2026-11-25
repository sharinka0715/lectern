// Offline Electron and mock-Claude coverage of conversation settings and launch warnings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, resizeWindow } from './fixtures/electron.mjs';
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import { sel, ui, writeWorkspaces } from './cc-matrix/app.mjs';
import { descendants } from './cc-matrix/sandbox.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-chat-settings-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'project');
const home = path.join(root, 'home'), bin = path.join(home, '.local', 'bin');
const env = { ...process.env, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: config,
  LECTERN_SETTINGS_FIXTURE: '1', LECTERN_DIAGNOSTIC_CONTENT: '0' };
delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const privateServer = createPrivateTmux(root, { env });
const tmux = (...args) => {
  try { return privateServer.tmux(...args); }
  catch (error) { if (error.status === 1) return ''; throw error; }
};
const project = { id: 'settings-fixture', name: '配置测试', cwd };
const outside = randomUUID();
const defaults = path.join(config, 'settings.json'), custom = path.join(home, 'per-chat.json'), nextFile = path.join(root, 'next.json');
const homeSettingsPath = '~/per-chat.json';
const fixtureStatusLine = { type: 'command', command: 'true' };
const defaultSample = { promptSuggestionEnabled: true, statusLine: fixtureStatusLine, permissions: { defaultMode: 'default' }, env: { EXAMPLE_DEFAULT: 'default' } };
const sample = { model: 'fixture-beta', availableModels: ['fixture-beta'], promptSuggestionEnabled: true, enableWorkflows: false,
  statusLine: fixtureStatusLine, env: { EXAMPLE_CUSTOM: 'custom' }, permissions: { allow: ['Bash'] } };
const shots = path.resolve('test-results', 'conversation-settings');
const windowSize = { width: 1400, height: 900 };
const row = id => page.locator(sel.row(id));
const paths = name => path.join(root, name);
const lines = async name => (await readFile(path.join(config, name), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
let app, page, chat;

async function startApp(locale = 'zh-CN', userData = profile) {
  app = await _electron.launch({ args: ['.', '--disable-background-networking'], env: { ...privateServer.env, LECTERN_LOCALE: locale, LECTERN_USER_DATA: userData }, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await resizeWindow(app, page, windowSize.width, windowSize.height);
  chat = ui(page, { tmux });
}

const overrides = () => page.locator('.settings-override-dialog[open]');
const editor = () => page.locator('[data-setting-menu="file"]');
const field = (container, locale = 'zh-CN') => container.getByRole('textbox', {
  name: locale === 'en' ? 'Custom Claude settings file path (JSON)' : '自定义Claude配置文件路径（JSON格式）',
});
const screenshot = name => page.screenshot({ path: path.join(shots, `${name}.png`), animations: 'disabled' });

async function writeHistory({ cwd }, id, text) {
  const historyDir = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(historyDir, { recursive: true });
  const record = { type: 'user', uuid: randomUUID(), sessionId: id, cwd, timestamp: '2030-01-01T12:00:00Z',
    message: { role: 'user', content: text } };
  await writeFile(path.join(historyDir, id + '.jsonl'), JSON.stringify(record) + '\n');
}

async function assertFooterVisible(panel, count) {
  const buttons = panel.locator('.modal-footer button');
  assert.equal(await buttons.count(), count);
  const inside = await panel.evaluate(panel => {
    const bounds = panel.getBoundingClientRect();
    const { paddingLeft, paddingRight, borderLeftWidth, borderRightWidth } = getComputedStyle(panel);
    const left = bounds.left + parseFloat(paddingLeft) + parseFloat(borderLeftWidth);
    const right = bounds.right - parseFloat(paddingRight) - parseFloat(borderRightWidth);
    return [...panel.querySelectorAll('.modal-footer button')].every(button => {
      const rect = button.getBoundingClientRect();
      return rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    });
  });
  assert.ok(inside, 'all footer buttons fit inside the panel');
}

async function captureOverrides(locale, file = custom) {
  const dialog = overrides();
  const list = dialog.locator('.settings-override-list');
  await list.getByRole('heading', { name: defaults, exact: true }).waitFor();
  await list.getByRole('heading', { name: file, exact: true }).waitFor();
  assert.equal(await list.getByRole('listitem').count(), 4);
  assert.equal(await list.getByText('promptSuggestionEnabled', { exact: true }).count(), 0);
  assert.ok(await list.evaluate(list => list.scrollHeight > list.clientHeight), 'the long list scrolls within the dialog');
  await assertFooterVisible(dialog, 3);
  await screenshot(`${locale}-05-launch-overrides`);
}

async function draft(name = project.name) {
  await chat.openDraft(name);
  await page.waitForFunction(() => document.querySelector('[data-draft-settings]')?.dataset.draftSettings === 'ready');
}
async function apply(file) {
  await page.locator('[data-setting-kind="file"]').click();
  await field(editor()).fill(file);
  await editor().getByRole('button', { name: '应用', exact: true }).click();
  await page.locator('[data-setting-kind="file"]').getByText(path.basename(file)).waitFor();
  await editor().getByRole('button', { name: '关闭设置菜单' }).click();
}
async function closeChat() {
  await page.getByRole('button', { name: '关闭当前对话', exact: true }).click();
  await page.locator('dialog.confirm-action[open] button[type="submit"]').click();
  await page.locator('.resume-bar').getByRole('button', { name: '续接会话' }).waitFor();
}
async function launch(message, decision, capture = false) {
  await chat.send(message);
  if (decision) {
    await overrides().getByText('statusLine.command', { exact: true }).first().waitFor();
    if (capture) await captureOverrides('zh');
    await overrides().getByRole('button', { name: decision, exact: true }).click();
  }
  await chat.waitUser(message);
  const id = await chat.activeSessionId();
  assert.ok(id);
  return id;
}

try {
  await Promise.all([profile, cwd, bin, shots].map(dir => mkdir(dir, { recursive: true })));
  const mock = paths('claude-code/cli.js');
  await mkdir(path.dirname(mock));
  await symlink(path.resolve('scripts/mock-claude.mjs'), mock);
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  await writeFile(path.join(bin, 'claude'), `#!/bin/sh\ncase "$1" in --version) echo "2.1.300 (Claude Code)"; exit 0;; auth) exit 0;; esac\nexec ${quote(process.execPath)} ${quote(mock)} --fixture-config "$CLAUDE_CONFIG_DIR" "$@"\n`, { mode: 0o700 });
  await writeHistory(project, outside, '示例历史');
  await writeWorkspaces({ profile }, [project]);
  await writeFile(custom, JSON.stringify(sample));
  await writeFile(nextFile, JSON.stringify({ env: { EXAMPLE_CUSTOM: 'next' } }));
  await writeFile(paths('invalid.json'), '{\n "sample": }');
  await writeFile(paths('array.json'), '[1]');
  await writeFile(paths('wrong-type.json'), '{"model":123}');
  await startApp();

  console.log('检查添加目录界面和静态验证');
  const addFolder = page.locator('.machine-add').first();
  await addFolder.click();
  const add = page.locator('dialog[open]').filter({ has: page.getByRole('textbox', { name: '工作目录' }) });
  await add.waitFor();
  assert.equal(await add.locator('details').count(), 0);
  await page.keyboard.press('Escape');

  await draft();
  await page.locator('[data-setting-kind="file"]').getByText('默认配置', { exact: true }).waitFor();
  await screenshot('zh-01-draft-default');
  const count = (await lines('probe-calls.jsonl')).length;
  await page.locator('[data-setting-kind="file"]').click();
  for (const [file, error, shot] of [
    [paths('missing.json'), '配置文件不存在。', 'zh-03a-draft-missing'], [cwd, '配置路径必须指向普通文件。'],
    [paths('invalid.json'), 'JSON 格式无效', 'zh-03b-draft-invalid-json'], [paths('array.json'), '配置文件的顶层必须是 JSON 对象。'],
  ]) {
    await field(editor()).fill(file);
    await editor().getByRole('alert').filter({ hasText: error }).waitFor();
    if (shot) await screenshot(shot);
  }
  await field(editor()).fill(homeSettingsPath);
  await editor().getByText('statusLine.command', { exact: true }).waitFor();
  await assertFooterVisible(editor(), 2);
  await screenshot('zh-02-draft-configured');
  assert.equal((await lines('probe-calls.jsonl')).length, count, 'typing runs no CLI probe');
  const wrongType = paths('wrong-type.json');
  await field(editor()).fill(wrongType);
  await editor().getByRole('button', { name: '应用', exact: true }).click();
  await editor().getByRole('alert').filter({ hasText: 'Expected string, but received number' }).waitFor();
  assert.match(await editor().getByRole('alert').innerText(), /wrong-type\.json/);
  assert.equal(await editor().getByText('lectern-settings-', { exact: false }).count(), 0);
  await page.keyboard.press('Escape');

  console.log('检查四种配置组合和启动参数');
  for (const [name, base, extra] of [['A', false, false], ['B', true, false], ['C', false, true], ['D', true, true]]) {
    console.log('配置组合', name);
    if (base) await writeFile(defaults, JSON.stringify(defaultSample));
    else await rm(defaults, { force: true });
    await draft();
    if (name === 'C') {
      await page.locator('[data-setting-kind="model"]').click();
      await page.locator('[data-option-value="fixture-alpha"]').click();
    }
    if (extra) await apply(custom);
    const id = await launch('配置用例 ' + name, base || extra ? '接受' : undefined, name === 'D');
    const record = (await lines('launches.jsonl')).find(entry => entry.id === id);
    const flag = record.args[record.args.indexOf('--settings') + 1];
    if (extra) {
      assert.equal(flag, path.join(root, 'lectern-settings-' + process.getuid(), id + '.json'));
      assert.equal(record.fileMode, 0o600);
      assert.equal(record.dirMode, 0o700);
      assert.equal(record.settings.model, sample.model);
      assert.equal(record.args.includes('--model'), false, 'a model missing from the custom list is reset to default');
      assert.deepEqual(record.settings.env, sample.env);
      assert.deepEqual(record.settings.permissions, { ...sample.permissions, defaultMode: 'auto' });
      assert.equal(record.settings.promptSuggestionEnabled, true);
      await assert.rejects(readFile(flag), { code: 'ENOENT' });
    } else assert.ok(flag.startsWith('{"statusLine":'));
    const pid = Number(tmux('display-message', '-p', '-t', await chat.pane(), '#{pane_pid}').trim());
    const mockProcess = descendants(pid).find(process => process.command.includes(mock) && !process.command.startsWith('sh -c'));
    assert.ok(mockProcess, 'the Claude process is running in this pane');
    const args = execFileSync('ps', ['-ww', '-p', String(mockProcess.pid), '-o', 'args='], { encoding: 'utf8' });
    if (extra) { assert.ok(args.includes(flag)); assert.doesNotMatch(args, /EXAMPLE_CUSTOM/); }
    await closeChat();
  }

  console.log('检查取消、关闭全局提醒和恢复默认');
  await draft();
  const before = (await lines('launches.jsonl')).length;
  await chat.send('应保留的草稿');
  await overrides().getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await chat.composer.inputValue(), '应保留的草稿');
  assert.equal((await lines('launches.jsonl')).length, before);
  await launch('继续并关闭提醒', '接受且不再显示');
  await closeChat();
  await draft();
  await launch('不再显示提醒');
  await closeChat();
  await page.getByRole('button', { name: '界面与连接设置' }).click();
  const preferences = page.getByRole('dialog', { name: '设置', exact: true });
  await preferences.getByText('会话', { exact: true }).first().click();
  const toggle = preferences.getByRole('checkbox', { name: 'Lectern 覆盖我的设置时提醒' });
  assert.equal(await toggle.isChecked(), false);
  await preferences.getByRole('button', { name: '恢复默认', exact: true }).click();
  assert.equal(await toggle.isChecked(), true);
  await toggle.scrollIntoViewIfNeeded();
  await screenshot('zh-07-warning-preference');
  await page.keyboard.press('Escape');
  await draft();
  await chat.send('恢复提醒后的草稿');
  await overrides().getByRole('button', { name: '取消', exact: true }).click();
  await rm(defaults, { force: true });

  console.log('检查首次续接、侧栏三种排序和应用重启');
  await row(outside).click();
  const resume = () => page.locator('.resume-bar').getByRole('button', { name: '续接会话' });
  await resume().click();
  const first = page.getByRole('dialog', { name: '续接前设置配置文件', exact: true });
  await first.waitFor();
  await screenshot('zh-04-first-resume');
  await first.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(([id, sid]) => window.desktop.getConversationSettings(id, sid), [project.id, outside]), undefined);
  await resume().click();
  await field(first).fill(custom);
  await first.getByRole('button', { name: '续接', exact: true }).click();
  await overrides().getByRole('button', { name: '接受', exact: true }).click();
  await page.getByRole('button', { name: '关闭当前对话', exact: true }).waitFor();
  for (const sort of ['按项目', '最近更新', '进行中优先']) {
    await page.getByRole('button', { name: '对话排序' }).click();
    await page.getByRole('menuitem', { name: sort, exact: true }).click();
    await row(outside).click({ button: 'right' });
    const settingsItem = page.getByRole('menuitem', { name: '自定义配置文件…' });
    if (sort === '按项目') {
      await settingsItem.waitFor();
      await screenshot('zh-06a-sidebar-menu');
    }
    await settingsItem.click();
    const edit = page.locator('dialog.settings-file-dialog[open]');
    await edit.getByText('正在运行的对话下次续接时生效。').waitFor();
    assert.equal(await field(edit).inputValue(), custom);
    if (sort === '按项目') {
      await edit.getByText('配置文件格式有效。', { exact: true }).waitFor();
      await edit.getByText('statusLine.command', { exact: true }).waitFor();
      await screenshot('zh-06b-running-settings');
    }
    if (sort === '进行中优先') {
      await field(edit).fill(nextFile);
      await edit.getByRole('button', { name: '保存', exact: true }).click();
    } else await edit.getByRole('button', { name: '取消', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
  }
  await closeChat();
  await rm(nextFile);
  const beforeMissing = (await lines('launches.jsonl')).length;
  await resume().click();
  await page.getByRole('alert').filter({ hasText: '配置文件不存在' }).waitFor();
  assert.equal((await lines('launches.jsonl')).length, beforeMissing);
  await writeFile(nextFile, JSON.stringify({ env: { EXAMPLE_CUSTOM: 'next' } }));
  await app.close(); app = undefined;
  await startApp();
  await row(outside).click();
  await resume().click();
  await page.getByRole('button', { name: '关闭当前对话', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: '续接前设置配置文件', exact: true }).count(), 0);
  assert.equal((await lines('launches.jsonl')).filter(entry => entry.id === outside).at(-1).settings.env.EXAMPLE_CUSTOM, 'next');
  await closeChat();

  console.log('拍摄英文界面');
  await app.close(); app = undefined;
  const englishProfile = paths('english-profile');
  const englishProject = { ...project, name: 'Settings example', cwd: paths('english-project') };
  const englishHistory = randomUUID();
  await Promise.all([englishProfile, englishProject.cwd].map(dir => mkdir(dir)));
  await writeWorkspaces({ profile: englishProfile }, [englishProject]);
  await writeHistory(englishProject, englishHistory, 'Example saved conversation');
  await writeFile(defaults, JSON.stringify(defaultSample));
  await startApp('en', englishProfile);

  await draft(englishProject.name);
  await page.locator('[data-setting-kind="file"]').click();
  await field(editor(), 'en').fill(homeSettingsPath);
  await editor().getByText('Lectern will override these settings', { exact: true }).waitFor();
  await assertFooterVisible(editor(), 2);
  await screenshot('en-02-draft-configured');
  await resizeWindow(app, page, windowSize.width, 600);
  await page.waitForFunction(() => {
    const body = document.querySelector('.settings-file-menu .settings-file-content');
    return body && body.scrollHeight > body.clientHeight;
  });
  await assertFooterVisible(editor(), 2);
  await resizeWindow(app, page, windowSize.width, windowSize.height);
  await editor().getByRole('button', { name: 'Apply', exact: true }).click();
  await page.locator('[data-setting-kind="file"]').getByText(path.basename(custom)).waitFor();
  await editor().getByRole('button', { name: 'Close settings menu' }).click();
  await chat.send('Example first message');
  await captureOverrides('en', homeSettingsPath);
  await overrides().getByRole('button', { name: 'Cancel', exact: true }).click();

  await row(englishHistory).click();
  await page.locator('.resume-bar').getByRole('button', { name: 'Resume', exact: true }).click();
  const englishResume = page.getByRole('dialog', { name: 'Set the configuration file before resuming', exact: true });
  await englishResume.waitFor();
  await screenshot('en-04-first-resume');
  await englishResume.getByRole('button', { name: 'Cancel', exact: true }).click();
  console.log('PASS: conversation settings, overrides, replacement and persistence');
} finally {
  await app?.close();
  privateServer.cleanup();
}
