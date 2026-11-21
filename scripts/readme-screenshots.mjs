#!/usr/bin/env node
// Regenerates the screenshots in docs/images/ that README.md and README.zh-CN.md
// show. It drives the offline demo (`--demo`: real tmux, the mock Claude from
// scripts/mock-claude.mjs, no model requests) through Playwright, writes generic
// sample conversations and project files into the demo's temporary folder, and
// captures the window at 1440×900 in English and Simplified Chinese.
//
//   npm run build
//   node scripts/readme-screenshots.mjs [--locale en|zh-CN] [--out docs/images]
//
// Needs tmux, and git for the activity card's changes. On Linux without a display
// it re-runs itself under xvfb-run. Two touches make the pictures look like a real
// session: the demo's "isolated demo" notice is hidden, and the status bar gets the
// values a real Claude Code reports (the mock has no status line). Nothing outside
// the demo's temporary folders is written, apart from the PNG files in --out.
// Check every picture by eye before committing it.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const locales = option('--locale') ? [option('--locale')] : ['en', 'zh-CN'];
if (locales.some(locale => !['en', 'zh-CN'].includes(locale))) throw new Error('--locale is en or zh-CN');
const out = path.resolve(option('--out', 'docs/images'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  const run = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, fileURLToPath(import.meta.url), ...args],
    { stdio: 'inherit' });
  if (run.error) console.error('No display and xvfb-run is missing: install xvfb or set DISPLAY.');
  process.exit(run.status ?? 1);
}

const started = Date.now();
const log = message => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${message}`);
const at = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const tr = (locale, zh, en) => (locale === 'en' ? en : zh);
const toggleSidebar = (page, locale, show) => page.getByRole('button',
  { name: show ? tr(locale, '展开侧栏', 'Show sidebar') : tr(locale, '收起侧栏', 'Hide sidebar'), exact: true }).click();

// One demo window per locale, in its own profile; the demo makes its own
// temporary folder, tmux socket and live mock session, and removes them on exit.
async function launch(locale) {
  const profile = await mkdtemp(path.join(tmpdir(), 'lectern-shots-'));
  const env = { ...process.env, LECTERN_LOCALE: locale, LECTERN_USER_DATA: profile, LECTERN_NODE_BINARY: process.execPath,
    LECTERN_LOG_DIR: path.join(profile, 'logs'), LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_SHOW_TEST_WINDOWS: '1',
    TZ: 'UTC' }; // quota reset times show a time zone; keep the machine's own out of the pictures
  for (const name of ['ELECTRON_RUN_AS_NODE', 'LECTERN_DEV_URL', 'TMUX', 'TMUX_PANE']) delete env[name];
  const app = await _electron.launch({ args: [root, '--demo'], cwd: root, env, timeout: 60_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.locator('.message-assistant').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-session-live') === 'true');
  await page.waitForFunction(() => document.querySelector('.session-settings')?.getAttribute('data-setting-initialization') === 'ready'
    && !document.querySelector('form.composer textarea')?.disabled, null, { timeout: 30_000 });
  const sessionId = await page.locator('.session-row.active').getAttribute('data-session-id');
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  const project = path.join(workspace.claudeDir, 'projects', workspace.cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  return {
    app, page, errors, sessionId, workspace, project,
    async close() { await app.close().catch(() => {}); await rm(profile, { recursive: true, force: true }); },
  };
}

async function shoot(page, name, locale) {
  await page.mouse.move(1430, 890); // no hover effects or tooltips
  await page.waitForTimeout(700); // messages and panels fade in
  const file = path.join(out, `${name}-${locale}.png`);
  await page.screenshot({ path: file });
  log(`wrote ${path.relative(process.cwd(), file)}`);
}

// A small sample project in the demo's folder, committed and then changed, so file
// references resolve, the preview has content and the activity card has git changes.
const files = {
  'package.json': '{\n  "name": "notes-app",\n  "private": true,\n  "scripts": { "dev": "vite", "test": "vitest run" }\n}\n',
  'README.md': '# Notes\n\nA small note-taking app.\n\n```bash\nnpm install\nnpm run dev\n```\n',
  'docs/dark-mode.md': '# Dark mode\n\n- Light, dark and system (default) themes\n- Remember the choice between launches\n- Follow the system theme live\n',
  'src/theme.ts': "export type Theme = 'light' | 'dark';\n\nexport function applyTheme(theme: Theme) {\n  document.documentElement.dataset.theme = theme;\n}\n",
  'src/settings/SettingsPage.tsx': "import { Section } from '../ui/Section';\n\nexport function SettingsPage() {\n  return (\n    <main className=\"settings\">\n      <Section title=\"Account\" />\n      <Section title=\"Notifications\" />\n    </main>\n  );\n}\n",
  'src/api/client.ts': "export async function request(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {\n  const response = await fetch(path, init);\n  if (response.status >= 500 && attempt < 3) return request(path, init, attempt + 1);\n  return response;\n}\n",
};
const changes = {
  'src/theme.ts': "export type Theme = 'light' | 'dark' | 'system';\n\nconst media = window.matchMedia('(prefers-color-scheme: dark)');\n\nexport function resolveTheme(theme: Theme): 'light' | 'dark' {\n  return theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;\n}\n\nexport function applyTheme(theme: Theme) {\n  document.documentElement.dataset.theme = resolveTheme(theme);\n}\n",
  'src/settings/useTheme.ts': [
    "import { useEffect, useState } from 'react';",
    "import { applyTheme, type Theme } from '../theme';",
    '',
    "const key = 'notes.theme';",
    '',
    '/** The saved theme; "system" follows the operating system and updates live. */',
    'export function useTheme() {',
    "  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(key) as Theme) ?? 'system');",
    '  useEffect(() => {',
    '    localStorage.setItem(key, theme);',
    '    applyTheme(theme);',
    "    if (theme !== 'system') return;",
    "    const media = window.matchMedia('(prefers-color-scheme: dark)');",
    "    const update = () => applyTheme('system');",
    "    media.addEventListener('change', update);",
    "    return () => media.removeEventListener('change', update);",
    '  }, [theme]);',
    '  return [theme, setTheme] as const;',
    '}',
    '',
  ].join('\n'),
  'src/settings/SettingsPage.tsx': "import { Section } from '../ui/Section';\nimport { ThemeToggle } from './ThemeToggle';\nimport { useTheme } from './useTheme';\n\nexport function SettingsPage() {\n  const [theme, setTheme] = useTheme();\n  return (\n    <main className=\"settings\">\n      <Section title=\"Appearance\">\n        <ThemeToggle value={theme} onChange={setTheme} />\n      </Section>\n      <Section title=\"Account\" />\n      <Section title=\"Notifications\" />\n    </main>\n  );\n}\n",
  'tests/theme.test.ts': "import { describe, expect, it } from 'vitest';\nimport { resolveTheme } from '../src/theme';\n\ndescribe('resolveTheme', () => {\n  it('keeps an explicit choice', () => {\n    expect(resolveTheme('dark')).toBe('dark');\n  });\n});\n",
};
async function writeTree(cwd, tree) {
  for (const [name, content] of Object.entries(tree)) {
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await writeFile(path.join(cwd, name), content);
  }
}
const git = (cwd, ...rest) => spawnSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', '-c', 'init.defaultBranch=main',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...rest], { cwd, stdio: 'ignore' });

// JSONL records in the shapes Claude Code writes, chained by parentUuid.
function transcript(sessionId, cwd, { parent = null, minutesAgo = 30 } = {}) {
  const rows = [];
  let minute = minutesAgo;
  const push = (type, fields) => {
    const uuid = randomUUID();
    rows.push({ type, uuid, parentUuid: parent, sessionId, cwd, timestamp: at(minute), version: '2.1.330', ...fields });
    parent = uuid;
    minute = Math.max(0, minute - 0.25);
    return uuid;
  };
  const usage = { input_tokens: 1840, cache_read_input_tokens: 41200, cache_creation_input_tokens: 2300, output_tokens: 420 };
  return {
    rows,
    title: customTitle => rows.push({ type: 'custom-title', customTitle, sessionId }),
    ask: text => push('user', { origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } }),
    say: (content, stop = 'end_turn') => push('assistant', { message: { id: `msg_${randomUUID().slice(0, 12)}`, role: 'assistant',
      model: 'claude-opus-5-5', stop_reason: stop, usage, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content } }),
    result: (id, content, extra = {}) => push('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra }),
    raw: (type, fields) => push(type, fields),
  };
}
const text = value => ({ type: 'text', text: value });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
// A Claude Code structured patch for a one-hunk edit.
const patch = (filePath, oldStart, lines) => ({ toolUseResult: { filePath, structuredPatch: [{ oldStart, newStart: oldStart,
  oldLines: lines.filter(line => !line.startsWith('+')).length, newLines: lines.filter(line => !line.startsWith('-')).length, lines }] } });

// Everything the screenshots say, in both languages. Generic sample content only.
function story(locale) {
  const pick = (zh, en) => tr(locale, zh, en);
  return {
    title: pick('设置页加入深色模式', 'Add a dark mode toggle'),
    ask: pick('在设置页加一个深色模式开关，默认跟随系统主题。', 'Add a dark mode toggle to settings that follows the system by default.'),
    look: pick('先看看设置页和主题现在是怎么实现的。', "I'll check how the settings page and theming work today."),
    plan: pick('目前主题固定为浅色，也没有保存任何偏好。计划如下：', 'The theme is fixed to light and nothing is saved yet. Here is the plan:'),
    todos: [pick('新增 useTheme，保存选择并跟随系统', 'Add useTheme to save the choice and follow the system'),
      pick('在设置页加入「外观」分区', 'Add an Appearance section to the settings page'),
      pick('补充测试并运行', 'Add tests and run them')],
    testCommand: pick('运行主题相关测试', 'Run the theme tests'),
    done: pick([
      '深色模式已经加好，测试全部通过。改动如下：', '',
      '- **src/settings/useTheme.ts**（新文件）：保存 `light`、`dark` 或 `system`，选 `system` 时跟随系统并实时更新。',
      '- **src/settings/SettingsPage.tsx**：新增「外观」分区，用三段开关切换主题。'].join('\n'), [
      'Dark mode is in, and all tests pass. What changed:', '',
      '- **src/settings/useTheme.ts** (new): saves `light`, `dark` or `system`; `system` follows the OS and updates live.',
      '- **src/settings/SettingsPage.tsx**: a new *Appearance* section with a three-way toggle.'].join('\n')),
    // An earlier exchange in the same conversation, above the turn the screenshots show.
    earlier: { ask: pick('用户偏好现在存在哪里？', 'Where are user preferences stored?'),
      answer: pick('都在 `localStorage` 里，键名以 `notes.` 开头，目前还没有跨设备同步。',
        'In `localStorage`, under keys that start with `notes.`. Nothing syncs between devices yet.') },
    history: [
      { title: pick('重构 API 客户端', 'Refactor the API client'), minutesAgo: 95,
        ask: pick('解释一下 src/api/client.ts 里的重试逻辑，再给个更清晰的写法。', 'Explain the retry logic in src/api/client.ts and suggest a cleaner structure.'),
        answer: pick([
          '`request` 遇到 5xx 时立即递归重试，最多 3 次：', '',
          '| 情况 | 现在的行为 | 问题 |', '| --- | --- | --- |',
          '| 5xx | 立即重试 | 没有退避，容易压垮服务 |', '| 网络错误 | 直接抛出 | 不会重试 |', '| 429 | 当作成功返回 | 忽略了 `Retry-After` |', '',
          '建议把重试策略单独拿出来，按指数退避等待：', '',
          '```ts', 'const delays = [250, 1000, 4000];', '', 'export async function request(path: string, init: RequestInit = {}) {',
          '  for (const delay of [...delays, null]) {', '    const response = await fetch(path, init).catch(() => null);',
          '    if (response && response.status < 500 && response.status !== 429) return response;',
          "    if (delay === null) throw new Error(`Request failed: ${path}`);", '    await sleep(delay);', '  }', '}', '```', '',
          '要我按这个思路改吗？'].join('\n'), [
          '`request` retries a 5xx response right away, recursively, up to 3 times:', '',
          '| Case | Today | Problem |', '| --- | --- | --- |',
          '| 5xx | Retries at once | No backoff, can overload the server |', '| Network error | Throws | Never retried |', '| 429 | Returned as success | Ignores `Retry-After` |', '',
          'I suggest a separate retry policy with exponential backoff:', '',
          '```ts', 'const delays = [250, 1000, 4000];', '', 'export async function request(path: string, init: RequestInit = {}) {',
          '  for (const delay of [...delays, null]) {', '    const response = await fetch(path, init).catch(() => null);',
          '    if (response && response.status < 500 && response.status !== 429) return response;',
          "    if (delay === null) throw new Error(`Request failed: ${path}`);", '    await sleep(delay);', '  }', '}', '```', '',
          'Shall I go ahead with this?'].join('\n')) },
      { title: pick('修复偶发失败的登录测试', 'Fix the flaky login test'), minutesAgo: 60 * 26,
        ask: pick('login.test.ts 偶尔会失败，帮我找找原因。', 'login.test.ts fails now and then. Can you find out why?'),
        answer: pick('测试在会话 cookie 写入之前就跳转了。我改成等待 `/api/session` 返回后再断言，连续运行 50 次都通过。',
          'The test navigated before the session cookie was written. It now waits for `/api/session` before asserting, and passed 50 runs in a row.') },
      { title: pick('起草 1.4 版本更新说明', 'Draft release notes for 1.4'), minutesAgo: 60 * 50,
        ask: pick('根据上次发布以来的提交，起草 1.4 的更新说明。', 'Draft the 1.4 release notes from the commits since the last release.'),
        answer: pick('已按新功能、改进和问题修复分组整理，写在 CHANGELOG.md 顶部。', 'Done: grouped into features, improvements and fixes at the top of CHANGELOG.md.') },
      { title: pick('加快搜索索引', 'Speed up the search index'), minutesAgo: 60 * 75,
        ask: pick('笔记多了以后搜索变慢，有什么办法？', 'Search gets slow with many notes. What can we do?'),
        answer: pick('索引现在每次按键都整体重建。改成增量更新后，1 万条笔记的搜索从 180 ms 降到 9 ms。',
          'The index was rebuilt on every keystroke. Updating it incrementally brings search over 10,000 notes from 180 ms to 9 ms.') },
    ],
    review: pick('让两个子代理分头检查新的设置页：一个看无障碍，一个看测试覆盖。',
      'Have two agents review the new settings page: one for accessibility, one for test coverage.'),
    reviewStarted: pick('两个检查已在后台运行，有结果后我来汇总。', "Both reviews are running in the background. I'll sum up when they report back."),
    a11y: { description: pick('检查主题开关的无障碍', 'Check theme toggle accessibility'),
      prompt: pick('检查 src/settings/SettingsPage.tsx 里的主题开关：标签、键盘操作和对比度。',
        'Review the theme toggle in src/settings/SettingsPage.tsx for labels, keyboard use and contrast.'),
      thinking: pick('先读设置页，再看开关组件。', 'Read the settings page first, then the toggle component.'),
      intro: pick('先读一下设置页。', "I'll read the settings page first."),
      report: pick([
        '主题开关整体可用，有两处需要改：', '',
        '1. 三个选项组成 `radiogroup`，但缺少 `aria-label`，读屏软件只会念出「组」。',
        '2. 深色模式下焦点框是 `#3b3b3b`，与背景的对比度只有 1.6:1，低于 3:1 的要求。', '',
        '方向键切换和 Tab 顺序都正常。'].join('\n'), [
        'The toggle mostly works. Two things need fixing:', '',
        '1. The three options form a `radiogroup` without an `aria-label`, so screen readers only announce "group".',
        '2. In dark mode the focus ring is `#3b3b3b`, a 1.6:1 contrast against the background, below the required 3:1.', '',
        'Arrow keys and the tab order work as expected.'].join('\n')) },
    coverage: { description: pick('检查 useTheme 的测试覆盖', 'Review useTheme test coverage'),
      prompt: pick('看看 useTheme 和 resolveTheme 还缺哪些测试。', 'Find what useTheme and resolveTheme are missing in tests.'),
      intro: pick('先找出所有用到主题的测试。', "I'll find every test that touches the theme."),
      progress: pick('目前只测了显式选择。还缺跟随系统、切换系统主题和读取已保存值这几种情况，接着看 useTheme 的实现。',
        'Only explicit choices are tested so far. Following the system, a system theme change and reading a saved value are missing; checking useTheme next.') },
  };
}

async function prepareProject({ workspace }) {
  await writeTree(workspace.cwd, files);
  git(workspace.cwd, 'init', '-q');
  git(workspace.cwd, 'add', '-A');
  git(workspace.cwd, 'commit', '-q', '-m', 'Initial notes app');
  await writeTree(workspace.cwd, changes);
}

// Older conversations in the same folder: history the sidebar lists and a split can open.
async function writeHistory({ workspace, project }, s) {
  const ids = [];
  for (const item of s.history) {
    const id = randomUUID();
    const chat = transcript(id, workspace.cwd, { minutesAgo: item.minutesAgo });
    chat.title(item.title);
    chat.ask(item.ask);
    chat.say(item.answer);
    await writeFile(path.join(project, `${id}.jsonl`), lines(chat.rows));
    ids.push(id);
  }
  return ids;
}

// The live demo conversation gets a title and one complete coding turn.
async function writeMainTurn({ workspace, project, sessionId }, s) {
  const file = path.join(project, `${sessionId}.jsonl`);
  const parent = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.uuid).at(-1)?.uuid ?? null;
  const chat = transcript(sessionId, workspace.cwd, { parent, minutesAgo: 6 });
  chat.title(s.title);
  chat.ask(s.earlier.ask);
  chat.say(s.earlier.answer);
  // The request comes with a design note, attached the way the input box sends it:
  // an @-mention after the text, which Claude Code records as an attachment row.
  chat.ask(`${s.ask} @docs/dark-mode.md`);
  chat.raw('attachment', { attachment: { type: 'file', filename: path.join(workspace.cwd, 'docs/dark-mode.md'), displayPath: 'docs/dark-mode.md' } });
  chat.say([text(s.look), tool('t-read-1', 'Read', { file_path: 'src/settings/SettingsPage.tsx' }), tool('t-read-2', 'Read', { file_path: 'src/theme.ts' }),
    tool('t-grep', 'Grep', { pattern: 'localStorage', path: 'src' })], 'tool_use');
  chat.result('t-read-1', files['src/settings/SettingsPage.tsx']);
  chat.result('t-read-2', files['src/theme.ts']);
  chat.result('t-grep', 'No matches found');
  const todos = status => s.todos.map((content, i) => ({ content, activeForm: content, status: status[i] }));
  chat.say([text(s.plan), tool('t-todo-1', 'TodoWrite', { todos: todos(['in_progress', 'pending', 'pending']) })], 'tool_use');
  chat.result('t-todo-1', 'Todos have been modified successfully.');
  chat.say([tool('t-write', 'Write', { file_path: 'src/settings/useTheme.ts', content: changes['src/settings/useTheme.ts'] }),
    tool('t-edit-1', 'Edit', { file_path: 'src/theme.ts', old_string: "'light' | 'dark';", new_string: "'light' | 'dark' | 'system';" }),
    tool('t-edit-2', 'Edit', { file_path: 'src/settings/SettingsPage.tsx', old_string: '<Section title="Account" />',
      new_string: '<Section title="Appearance">\n  <ThemeToggle value={theme} onChange={setTheme} />\n</Section>\n<Section title="Account" />' })], 'tool_use');
  chat.result('t-write', 'File created successfully at: src/settings/useTheme.ts');
  chat.result('t-edit-1', 'The file src/theme.ts has been updated.', patch('src/theme.ts', 1, [
    "-export type Theme = 'light' | 'dark';", "+export type Theme = 'light' | 'dark' | 'system';", ' ']));
  chat.result('t-edit-2', 'The file src/settings/SettingsPage.tsx has been updated.', patch('src/settings/SettingsPage.tsx', 3, [
    ' export function SettingsPage() {', '+  const [theme, setTheme] = useTheme();', '   return (', '     <main className="settings">',
    '+      <Section title="Appearance">', '+        <ThemeToggle value={theme} onChange={setTheme} />', '+      </Section>', '       <Section title="Account" />']));
  chat.say([tool('t-test', 'Write', { file_path: 'tests/theme.test.ts', content: changes['tests/theme.test.ts'] }),
    tool('t-bash', 'Bash', { command: 'npm test -- theme', description: s.testCommand })], 'tool_use');
  chat.result('t-test', 'File created successfully at: tests/theme.test.ts');
  const output = ' ✓ tests/theme.test.ts (6 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n   Duration  412ms';
  chat.result('t-bash', output, { toolUseResult: { stdout: output, stderr: '', interrupted: false } });
  chat.say([tool('t-todo-2', 'TodoWrite', { todos: todos(['completed', 'completed', 'completed']) })], 'tool_use');
  chat.result('t-todo-2', 'Todos have been modified successfully.');
  chat.say(s.done);
  await appendFile(file, lines(chat.rows));
  return chat;
}

// A second turn in the live conversation starts two background subagents, each with
// its own transcript under <session>/subagents/ as Claude Code writes them: one has
// finished with a report, the other is still working.
async function writeSubagentTurn({ workspace, project, sessionId }, s, main) {
  const done = 'a4c1e9b27d03f6a8', live = 'b7f2d06c19e4a351';
  const chat = transcript(sessionId, workspace.cwd, { parent: main.rows.filter(row => row.uuid).at(-1).uuid, minutesAgo: 3 });
  chat.ask(s.review);
  chat.say([tool('t-agent-1', 'Agent', { description: s.a11y.description, prompt: s.a11y.prompt, subagent_type: 'general-purpose', run_in_background: true }),
    tool('t-agent-2', 'Agent', { description: s.coverage.description, prompt: s.coverage.prompt, subagent_type: 'Explore', run_in_background: true })], 'tool_use');
  for (const [id, agent, description] of [['t-agent-1', done, s.a11y.description], ['t-agent-2', live, s.coverage.description]])
    chat.result(id, `Async agent launched successfully.\nagentId: ${agent}`, { toolUseResult: { isAsync: true, status: 'async_launched', agentId: agent, description } });
  chat.say(s.reviewStarted);
  const notice = `<task-notification>\n<task-id>${done}</task-id>\n<tool-use-id>t-agent-1</tool-use-id>\n<status>completed</status>\n`
    + `<summary>Agent "${s.a11y.description}" completed</summary>\n<result>${s.a11y.report}</result>\n</task-notification>`;
  chat.rows.push({ type: 'queue-operation', operation: 'enqueue', sessionId, timestamp: at(1), content: notice });
  chat.raw('user', { origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: notice } });
  await appendFile(path.join(project, `${sessionId}.jsonl`), lines(chat.rows));

  const folder = path.join(project, sessionId, 'subagents');
  await mkdir(folder, { recursive: true });
  const side = (agent, minutesAgo) => {
    let up = null, n = 0;
    return (type, message, extra = {}) => {
      const uuid = `${agent}-${++n}`;
      const row = { parentUuid: up, isSidechain: true, sessionId, agentId: agent, type, uuid, timestamp: at(minutesAgo - n * 0.1), message, ...extra };
      up = uuid;
      return row;
    };
  };
  // Folded thinking: a signature whose purpose field is empty (src/core/thinking.ts).
  const signature = Buffer.from([0x12, 4, 0x0a, 2, 0x08, 1]).toString('base64');
  const a = side(done, 3), b = side(live, 3);
  const assistant = (row, id, content, stop = 'tool_use', extra) => row('assistant', { id, role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, content }, extra);
  await writeFile(path.join(folder, `agent-${done}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: s.a11y.description, toolUseId: 't-agent-1', finished: true }));
  await writeFile(path.join(folder, `agent-${live}.meta.json`), JSON.stringify({ agentType: 'Explore', description: s.coverage.description, toolUseId: 't-agent-2' }));
  await writeFile(path.join(folder, `agent-${done}.jsonl`), lines([
    a('user', { role: 'user', content: s.a11y.prompt }),
    assistant(a, 'a1', [{ type: 'thinking', thinking: s.a11y.thinking, signature }], 'tool_use', { thinkingDurationMs: 4000 }),
    assistant(a, 'a1', [text(s.a11y.intro)]),
    assistant(a, 'a1', [tool('a-read', 'Read', { file_path: 'src/settings/SettingsPage.tsx' })]),
    a('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a-read', content: changes['src/settings/SettingsPage.tsx'] }] }),
    assistant(a, 'a2', [text(s.a11y.report)], 'end_turn'),
  ]));
  await writeFile(path.join(folder, `agent-${live}.jsonl`), lines([
    b('user', { role: 'user', content: s.coverage.prompt }),
    assistant(b, 'b1', [text(s.coverage.intro)]),
    assistant(b, 'b1', [tool('b-grep', 'Grep', { pattern: 'theme', path: 'tests' })]),
    b('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b-grep', content: 'tests/theme.test.ts' }] }),
    assistant(b, 'b2', [tool('b-read', 'Read', { file_path: 'tests/theme.test.ts' })]),
    b('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b-read', content: changes['tests/theme.test.ts'] }] }),
    assistant(b, 'b3', [text(s.coverage.progress)]),
    assistant(b, 'b3', [tool('b-read-2', 'Read', { file_path: 'src/settings/useTheme.ts' })]),
  ]));
  return { done, live };
}

// The mock Claude has no status line callback, so the status bar would read
// "unknown". Fill in what a live session launched by Lectern reports: model,
// effort, auto mode, context, prompt cache and subscription usage.
async function decorateLiveSnapshots({ app }, locale) {
  await app.evaluate(({ BrowserWindow }, { auto }) => {
    const web = BrowserWindow.getAllWindows()[0].webContents;
    const send = web.send.bind(web);
    web.send = (channel, snapshot, ...rest) => {
      if (channel === 'lectern:snapshot' && snapshot?.paneId) {
        const now = Math.floor(Date.now() / 1000);
        snapshot = { ...snapshot, cliVersion: '2.1.330', statusLineManaged: true, endpointBilling: 'subscription',
          executionMode: { mode: 'auto', label: auto, source: 'native-footer', evidence: 'auto mode on' },
          statusLine: { sessionId: snapshot.sessionId, modelId: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'high', version: '2.1.330',
            contextWindowSize: 1_000_000, usedPercentage: 9, inputTokens: 87_400,
            promptCache: { ttl: '1h', expiresAt: now + 53 * 60, warm: true },
            fiveHour: { usedPercentage: 21, resetsAt: now + 2 * 3600 + 15 * 60 }, sevenDay: { usedPercentage: 46, resetsAt: now + 3 * 86400 + 5 * 3600 } } };
      }
      return send(channel, snapshot, ...rest);
    };
  }, { auto: locale === 'en' ? 'Auto' : '自动' });
}

// The demo's own notice and badge say that replies come from a test program; the
// README shows the interface as it looks with a real Claude Code session.
const hideDemoMarks = page => page.addStyleTag({ content: '.demo-notice, .demo-badge { display: none !important; }' });

const primary = page => page.locator('.desk-pane[data-view="primary"]');
const settle = async page => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); };

async function chatShot(demo, s, locale) {
  const { page } = demo;
  await primary(page).locator('.message-assistant').filter({ hasText: s.done.split('\n')[0] }).waitFor();
  await page.waitForFunction(n => document.querySelectorAll('.sidebar-tree .session-row').length >= n, s.history.length + 1, { timeout: 30_000 });
  await page.locator('.session-row.active').filter({ hasText: s.title }).waitFor();
  await primary(page).locator('button[data-setting-kind="model"]').filter({ hasText: 'Opus' }).waitFor(); // the status line decoration applies
  await settle(page);
  await shoot(page, 'chat', locale);
}

// Two conversations side by side: drag one from the sidebar onto the right edge.
async function splitShot(demo, s, locale) {
  const { page } = demo;
  const row = await page.locator(`.session-row[data-session-id="${demo.history[0]}"]`).boundingBox();
  const area = await page.locator('.split-workspace').first().boundingBox();
  await page.mouse.move(row.x + 40, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 52, row.y + row.height / 2 + 1, { steps: 4 });
  await page.mouse.move(area.x + area.width * 0.55, area.y + area.height * 0.45, { steps: 12 });
  const zone = page.locator('.split-drop.right');
  await zone.waitFor();
  const box = await zone.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const secondary = page.locator('.desk-pane[data-view="secondary"]');
  await secondary.locator('.message-assistant').filter({ hasText: 'request' }).waitFor();
  await secondary.locator('table').waitFor();
  // Resume it, so both sides are live, and give the two panes the whole width.
  await secondary.getByRole('button', { name: tr(locale, '续接会话', 'Resume'), exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector('.desk-pane[data-view="secondary"] form.composer textarea')?.disabled, null, { timeout: 30_000 });
  await toggleSidebar(page, locale, false);
  await settle(page);
  await shoot(page, 'split', locale);
  await toggleSidebar(page, locale, true);
  await secondary.getByRole('button', { name: tr(locale, '关闭此分屏', 'Close this pane'), exact: true }).click();
  await secondary.waitFor({ state: 'detached' });
}

// A file named in the reply opens in the preview beside the chat.
async function previewShot(demo, s, locale) {
  const { page } = demo;
  await primary(page).locator('[data-file-path="src/settings/useTheme.ts"]').filter({ visible: true }).first().click();
  const drawer = page.getByRole('complementary', { name: tr(locale, '文件预览', 'File preview') });
  await drawer.getByText("const key = 'notes.theme';").waitFor();
  // A wider preview, so the code wraps less.
  const edge = await page.getByRole('separator', { name: tr(locale, '调整文件预览宽度', 'Resize file preview') }).boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x - 170, edge.y + edge.height / 2, { steps: 10 });
  await page.mouse.up();
  // Unfold the edits: each tool on its own row, with its diff counts.
  await primary(page).locator('details.tool-group > summary').filter({ hasText: tr(locale, '修改 4 个文件', 'Edited 4 files') }).click();
  await page.waitForTimeout(300);
  const latest = primary(page).locator('.scroll-latest');
  if (await latest.isVisible()) await latest.click();
  await settle(page);
  await shoot(page, 'preview', locale);
  await drawer.getByRole('button', { name: tr(locale, '关闭文件预览', 'Close file preview'), exact: true }).click();
}

// The activity card lists the subagents; "View conversation" opens the subagent
// column beside the chat with the finished one's thinking, tool call and report.
async function subagentShot(demo, s, locale, agents) {
  const { page } = demo;
  await primary(page).locator('.message-assistant').filter({ hasText: s.reviewStarted }).waitFor();
  await toggleSidebar(page, locale, false);
  const card = page.locator('.activity-float');
  if (!await card.isVisible()) await page.locator('.activity-float-pill').click();
  const section = card.locator('.activity-float-section').filter({ has: page.locator('.activity-float-title', { hasText: tr(locale, '子代理', 'Subagents') }) });
  await section.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.activity-float-dots i[data-state]').length >= 2);
  await section.locator('.activity-float-toggle').click();
  await page.locator('article.activity-card[data-activity-id="t-agent-1"] .activity-open-conversation').click();
  const column = page.locator('[data-subagent-column]');
  await column.waitFor();
  await column.locator(`.subagent-list button[data-agent-id="${agents.done}"]`).click();
  const detail = column.locator(`[data-subagent-detail="${agents.done}"]`);
  await detail.locator('article.message-assistant').filter({ hasText: s.a11y.report.split('\n')[0] }).waitFor();
  await detail.locator('details.thought-row[data-thought]').waitFor({ state: 'attached' });
  await settle(page);
  await shoot(page, 'subagents', locale);
  await page.getByRole('button', { name: tr(locale, '收起会话活动', 'Hide conversation activity'), exact: true }).first().click();
  await column.locator('.subagent-column-bar button').first().click();
  await column.waitFor({ state: 'detached' });
  await toggleSidebar(page, locale, true);
}

await mkdir(out, { recursive: true });
for (const locale of locales) {
  log(`${locale}: starting the demo`);
  const demo = await launch(locale);
  const s = story(locale);
  try {
    await hideDemoMarks(demo.page);
    await decorateLiveSnapshots(demo, locale);
    await prepareProject(demo);
    demo.history = await writeHistory(demo, s);
    const main = await writeMainTurn(demo, s);
    log(`${locale}: sample project and conversations written`);
    await chatShot(demo, s, locale);
    await previewShot(demo, s, locale);
    const agents = await writeSubagentTurn(demo, s, main);
    await subagentShot(demo, s, locale, agents);
    await splitShot(demo, s, locale);
    if (demo.errors.length) throw new Error(`Renderer errors: ${demo.errors.join('; ')}`);
  } catch (error) {
    const failure = path.join(root, 'test-results', `readme-screenshots-failure-${locale}.png`);
    await mkdir(path.dirname(failure), { recursive: true });
    await demo.page.screenshot({ path: failure }).catch(() => {});
    log(`failed; the window is in ${failure}`);
    throw error;
  } finally {
    await demo.close();
  }
}
log('done');
