// node scripts/saved-history-ui-e2e.mjs [packaged-executable]
// Saved conversations only: temporary JSONL histories in one local folder. No Claude process,
// no remote, no model request. One launch for four parts; each prints "PASS <part>", and a
// failure names its part (formerly task-notice-ui-e2e, archive-ui-e2e and transcript-render-e2e):
//   notice   a background task notification folds to one line in the command rows' style and
//            without a grey surface; the keyboard opens its full text and file reference, the mouse
//            folds it again; the notice sits between the call and the reply it triggers
//            (screenshot test-results/task-notice-expanded.png)
//   archive  archiving a conversation from the sidebar leaves its file untouched, survives a reload
//            and is restored from Settings → 回收站
//   timing   each reply ends with its end time in the reset time zone and how long it took; an interrupted
//            one with the time to the interruption (screenshots test-results/turn-timing-{light,dark}.png)
//   render   switch between folded thinking and reply Markdown, check styles, grouping, motion and copy,
//            show sed -i edits as diffs, and list only background shells in the activity panel
// Set LECTERN_THINKING_SCREENSHOTS to save a pair of reply screenshots per theme in that directory.
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-saved-history-')));
const privateServer = createPrivateTmux(root);
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const project = path.join(config, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
/** Runs one part; a failure names it. */
async function part(name, run) {
  try { await run(); } catch (error) { error.message = `[${name}] ${error.message}`; throw error; }
}

// ── notice: prose and a tool call, then a task notification that triggers more prose ──
const noticeChat = { sid: randomUUID(), title: '后台检查已完成', filename: 'result.txt' };
noticeChat.detail = `共检查 3 个文件。\n结果见 ${noticeChat.filename}`;
function noticeHistory() {
  const { sid, title, detail } = noticeChat;
  let parentUuid = null;
  function row(type, content, extra = {}) {
    const uuid = randomUUID();
    const r = { type, cwd, sessionId: sid, uuid, parentUuid, timestamp: new Date().toISOString(), ...extra,
      message: { role: type, content, ...(type === 'assistant' && { id: uuid }) } };
    parentUuid = uuid;
    return JSON.stringify(r);
  }
  return [row('user', '检查项目文件'),
    row('assistant', '开始检查文件。'),
    row('assistant', [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'ls' } }]),
    row('user', [{ type: 'tool_result', tool_use_id: 'check', content: '已启动检查' }]),
    row('user', `<task-notification>\n<summary>${title}</summary>\n<result>${detail}</result>\n</task-notification>`, { origin: { kind: 'task-notification' } }),
    row('assistant', '已收到检查结果。')].join('\n') + '\n';
}

// ── archive: two finished conversations, one to keep and one to archive ──
const kept = randomUUID(), archived = randomUUID();
const archiveHistory = (sid, prompt) => [
  { type: 'user', uuid: `${sid}-u`, parentUuid: null, message: { role: 'user', content: prompt } },
  { type: 'assistant', uuid: `${sid}-a`, parentUuid: `${sid}-u`, message: { id: `${sid}-m`, role: 'assistant', content: [{ type: 'text', text: '好的。' }], stop_reason: 'end_turn' } },
].map(r => JSON.stringify({ ...r, cwd, sessionId: sid, timestamp: new Date().toISOString() })).join('\n') + '\n';

// ── timing: replies end with their time in the chosen zone and how long they took ──
const timing = { sid: randomUUID() };
function timingHistory() {
  const now = Date.now(), noon = new Date(now); noon.setDate(noon.getDate() - 1); noon.setHours(12, 0, 0, 0);
  const yesterday = noon.getTime(), today = now - 60_000;
  let parentUuid = null;
  function row(ms, type, content, extra = {}) {
    const uuid = randomUUID();
    const r = { type, cwd, sessionId: timing.sid, uuid, parentUuid, timestamp: new Date(ms).toISOString(), version: '2.1.332', ...extra,
      ...(content !== undefined && { message: { role: type, content, ...(type === 'assistant' && { id: uuid, model: 'claude-opus-5-5', stop_reason: 'end_turn' }) } }) };
    parentUuid = uuid;
    return JSON.stringify(r);
  }
  const done = (ms, durationMs) => row(ms, 'system', undefined, { subtype: 'turn_duration', durationMs, messageCount: 2, isMeta: false });
  timing.ends = [yesterday, today, now - 20_000];
  return [row(yesterday - 45_000, 'user', '整理一下测试清单'), row(yesterday - 1_000, 'assistant', [{ type: 'text', text: '清单已按模块分组。' }]), done(yesterday, 44_600),
    // 28 s of this one waited on a permission prompt: Claude Code's durationMs leaves it out.
    row(today - 220_000, 'user', '把失败的用例修好'), row(today - 1_000, 'assistant', [{ type: 'text', text: '两个用例都修好了，全部通过。' }]), done(today, 192_000),
    row(now - 50_000, 'user', '顺便重构一下解析器'), row(now - 30_000, 'assistant', [{ type: 'text', text: '先看一下现有结构。' }]),
    row(now - 20_000, 'user', [{ type: 'text', text: '[Request interrupted by user]' }])].join('\n') + '\n';
}

// ── render: narration and folded thinking, a sed -i edit, a foreground and a background shell ──
const render = { sid: randomUUID() };
const narration = '先改样式，再启动开发服务器。';
const thinking = '**检查结果**\n\n确认 `app.css` 的按钮样式，再运行测试。';
const answer = '已改成红色。';
// A thinking signature names its purpose (protobuf field 2 → 1 → 8), as Claude Code reads it.
function signature(purpose) {
  const field = (number, bytes) => { const out = []; for (let n of [number * 8 + 2, bytes.length]) { while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); } return [...out, ...bytes]; };
  return Buffer.from(field(2, field(1, field(8, [...Buffer.from(purpose)])))).toString('base64');
}
function renderHistory() {
  const { sid } = render;
  let parentUuid = null;
  function row(type, content, extra = {}, messageId) {
    const uuid = randomUUID();
    const r = { type, cwd, sessionId: sid, uuid, parentUuid, timestamp: new Date().toISOString(), version: '2.1.328', ...extra,
      message: { role: type, content, ...(type === 'assistant' && { id: messageId ?? uuid, stop_reason: null }) } };
    parentUuid = uuid;
    return JSON.stringify(r);
  }
  const updates = { thinkingDisplay: 'updates' };
  return [row('user', '把按钮改成红色'),
    row('assistant', [{ type: 'thinking', thinking: narration + '\n\n', signature: signature('narration') }], updates, 'm1'),
    row('assistant', [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'app.css' } }], updates, 'm1'),
    row('user', [{ type: 'tool_result', tool_use_id: 'read1', content: '.button { color: blue; }' }]),
    row('assistant', [{ type: 'tool_use', id: 'sed1', name: 'Bash', input: { command: "sed -i '' -e 's/color: blue/color: red/g' app.css", description: 'Recolor' } }], updates, 'm1'),
    row('user', [{ type: 'tool_result', tool_use_id: 'sed1', content: '' }]),
    row('assistant', [{ type: 'thinking', thinking, signature: signature('thinking') }], { ...updates, thinkingDurationMs: 8300 }, 'm2'),
    row('assistant', [{ type: 'tool_use', id: 'fg1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }], updates, 'm2'),
    row('user', [{ type: 'tool_result', tool_use_id: 'fg1', content: 'ok' }]),
    row('assistant', [{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }], updates, 'm3'),
    row('user', [{ type: 'tool_result', tool_use_id: 'bg1', content: 'Command running in background with ID: b1' }], { toolUseResult: { backgroundTaskId: 'b1' } }),
    row('assistant', [{ type: 'text', text: answer }], updates, 'm4')].join('\n') + '\n';
}

let app;
try {
  await Promise.all([profile, cwd, project].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'fixture', name: '历史记录检查', kind: 'local', cwd }]));
  await writeFile(path.join(cwd, noticeChat.filename), '验证文件引用');
  await writeFile(path.join(cwd, 'app.css'), '.button { color: blue; }\n');
  await writeFile(path.join(project, `${noticeChat.sid}.jsonl`), noticeHistory());
  await writeFile(path.join(project, `${kept}.jsonl`), archiveHistory(kept, '保留这条'));
  await writeFile(path.join(project, `${archived}.jsonl`), archiveHistory(archived, '归档这条'));
  const archivedBefore = await readFile(path.join(project, `${archived}.jsonl`), 'utf8');
  await writeFile(path.join(project, `${render.sid}.jsonl`), renderHistory());
  await writeFile(path.join(project, `${timing.sid}.jsonl`), timingHistory());
  const env = { ...privateServer.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, CLAUDE_CONFIG_DIR: config, LECTERN_DIAGNOSTIC_CONTENT: '0' };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);

  await part('notice', async () => {
    const { sid, title, filename, detail } = noticeChat;
    await page.locator(`[data-session-id="${sid}"]`).first().click();
    const notice = page.locator('.message details').filter({ has: page.locator('summary', { hasText: '后台任务通知' }) });
    const summary = notice.locator(':scope > summary');
    const tool = page.locator('[data-tool-id="check"]');
    const style = el => { const s = getComputedStyle(el); return [s.fontSize, s.padding, s.lineHeight, s.color]; };
    const surface = el => { const s = getComputedStyle(el); return [s.backgroundColor, s.borderTopWidth]; };
    await summary.waitFor();
    const reply = page.locator('.message-assistant .message-content');
    const order = await reply.locator(':scope > .markdown, :scope > [data-tool-id], :scope > .task-notice').evaluateAll(nodes =>
      nodes.map(el => el.getAttribute('data-tool-id') ?? el.querySelector('.activity-subject')?.textContent ?? el.textContent.trim()));
    assert.deepEqual(order, ['开始检查文件。', 'check', title, '已收到检查结果。']);
    assert.equal(await notice.evaluate(el => el.open), false);
    assert.ok((await summary.innerText()).includes(title), '折叠时应能看到具体任务摘要');
    assert.deepEqual(await summary.evaluate(style), await tool.locator('summary').evaluate(style));
    assert.deepEqual(await notice.evaluate(surface), ['rgba(0, 0, 0, 0)', '0px']);
    await summary.focus(); await page.keyboard.press('Enter');
    const body = notice.locator('.task-notice-content');
    await body.waitFor();
    assert.deepEqual(await body.evaluate(surface), ['rgba(0, 0, 0, 0)', '0px']);
    assert.equal(await body.innerText(), `${title}\n\n${detail}`);
    await body.getByRole('button', { name: filename, exact: true }).waitFor();
    await mkdir('test-results', { recursive: true });
    await notice.locator('xpath=ancestor::article[1]').screenshot({ path: 'test-results/task-notice-expanded.png' });
    await summary.click(); await body.waitFor({ state: 'detached' });
    assert.equal(await notice.evaluate(el => el.open), false);
    console.log('PASS notice：通知位于工具调用和后续正文之间，默认单行收起，沿用命令行样式，可展开全文和文件引用。');
  });

  await part('archive', async () => {
    const row = sid => page.locator(`.session-row[data-session-id="${sid}"]`);
    await row(archived).click();
    await page.locator('.message-assistant').getByText('好的。').waitFor();
    await row(archived).click({ button: 'right' });
    await page.locator('.context-menu:popover-open').getByRole('menuitem', { name: '归档对话' }).click();
    await row(archived).waitFor({ state: 'detached' });
    await row(kept).waitFor();
    await page.locator('.context-toast').getByText(/已归档/).waitFor();
    assert.equal(await readFile(path.join(project, `${archived}.jsonl`), 'utf8'), archivedBefore, 'the conversation file is untouched');
    // Survives a reload, then comes back from Settings → 回收站.
    await page.reload();
    await row(kept).waitFor();
    assert.equal(await row(archived).count(), 0);
    await page.getByRole('button', { name: '界面与连接设置' }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '回收站' }).click();
    const entry = settings.locator(`[data-archived-session="${archived}"]`);
    assert.match(await entry.innerText(), /归档这条|新对话|对话/);
    await entry.getByRole('button', { name: /^恢复/ }).click();
    await settings.locator('[data-trash-empty]').waitFor();
    await settings.getByRole('button', { name: '关闭设置' }).click();
    await row(archived).waitFor();
    console.log('PASS archive: ' + JSON.stringify({ archived, fileUntouched: true, restored: true }));
  });

  // Last: it switches the reply detail setting to individual rows.
  await part('timing', async () => {
    await page.locator(`[data-session-id="${timing.sid}"]`).first().click();
    const labels = page.locator('.message-assistant .turn-timing');
    await labels.nth(2).waitFor();
    const clock = (ms, zone) => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).formatToParts(ms);
      const get = type => parts.find(part => part.type === type)?.value ?? '';
      return { time: `${get('hour')}:${get('minute')}`, offset: /^(?:GMT|UTC)?$/u.test(get('timeZoneName')) ? 'GMT+0' : get('timeZoneName').replace(/^UTC/u, 'GMT') };
    };
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [yesterday, today, stopped] = timing.ends.map(ms => clock(ms));
    const texts = await labels.allInnerTexts();
    // Only the time on the line; the zone and its offset are on hover.
    assert.equal(texts[0], `昨天 ${yesterday.time} · 用时 45秒`);
    assert.match(texts[1], new RegExp(`^(?:昨天 )?${escape(today.time)} · 用时 3分12秒$`));
    assert.match(texts[2], new RegExp(`^(?:昨天 )?${escape(stopped.time)} · 用时 30秒$`));
    const titles = await labels.evaluateAll(nodes => nodes.map(node => node.getAttribute('title')));
    assert.ok(titles[1].includes(`（本机时区，${today.offset}）`), titles[1]);
    assert.match(titles[1], /^结束于 \d{4}\/\d{1,2}\/\d{1,2} 周.+（本机时区，GMT[^）]*）\n用时取自 Claude Code 的记录，不含等你确认权限或回答问题的时间\n从提问到结束共 3分40秒$/u);
    assert.match(titles[2], /^中断于 .+\n从提问到中断共 30秒，含等你操作的时间$/u);
    assert.doesNotMatch(titles[0], /从提问到结束/u, 'no second duration when the two agree');
    assert.equal(await page.locator('.message-assistant').nth(2).locator('.message-interrupted').innerText(), '已中断');
    for (const box of await labels.evaluateAll(nodes => nodes.map(node => [node.scrollWidth, node.clientWidth]))) assert.ok(box[0] <= box[1], 'the label is not cut off');

    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    const openSettings = () => page.getByRole('button', { name: '界面与连接设置' }).click();
    const closeSettings = () => settings.getByRole('button', { name: '关闭设置' }).click();
    const shot = async name => {
      const latest = page.locator('.scroll-latest:not([data-leaving])');
      if (await latest.isVisible()) await latest.click();
      await page.waitForTimeout(400);
      await page.locator('.conversation-stage').screenshot({ path: `test-results/${name}.png` });
    };
    await openSettings();
    await settings.getByLabel('界面主题').selectOption('light');
    await closeSettings();
    await shot('turn-timing-light');
    // The same zone as the 7d reset: another one moves the clock and its offset.
    await openSettings();
    await settings.getByLabel('时间显示的时区').selectOption('Asia/Tokyo');
    await closeSettings();
    const tokyo = clock(timing.ends[1], 'Asia/Tokyo');
    await page.waitForFunction(() => document.querySelectorAll('.message-assistant .turn-timing')[1]?.getAttribute('title')?.includes('Asia/Tokyo'));
    assert.match(await labels.nth(1).innerText(), new RegExp(`^(?:昨天 |\\d+/\\d+ )?${escape(tokyo.time)} · 用时 3分12秒$`));
    assert.match(await labels.nth(1).getAttribute('title'), /（Asia\/Tokyo，GMT\+9）/u);
    await openSettings();
    await settings.getByLabel('时间显示的时区').selectOption('');
    await settings.getByLabel('界面主题').selectOption('dark');
    await closeSettings();
    await shot('turn-timing-dark');
    console.log('PASS timing: ' + JSON.stringify({ labels: texts, zones: ['local', 'Asia/Tokyo'], screenshots: ['turn-timing-light', 'turn-timing-dark'] }));
  });

  await part('render', async () => {
    const { sid } = render;
    await page.locator(`[data-session-id="${sid}"]`).first().click();
    const reply = page.locator('.message-assistant:not([data-leaving])').last();
    const body = reply.locator('.message-content');
    const paragraph = body.locator(':scope > .markdown.reply-thought');
    const groups = body.locator(':scope > .activity-group');
    await reply.getByText(answer).waitFor();
    assert.ok((await reply.innerText()).includes(narration), 'progress notes are shown');
    assert.ok(!(await reply.innerText()).includes('检查结果'), 'other thinking is folded by default');
    assert.equal(await paragraph.count(), 0);
    const shots = process.env.LECTERN_THINKING_SCREENSHOTS;
    if (shots) await mkdir(shots, { recursive: true });
    async function screenshot(theme, state) {
      if (!shots) return;
      const latest = page.locator('.scroll-latest:not([data-leaving])');
      if (await latest.isVisible()) await latest.click();
      await reply.screenshot({ path: path.join(shots, `thinking-${theme}-${state}.png`) });
    }
    async function expandFoldedThought() {
      // Compact: the thought joins the neighbouring operations' summary, like "Thought for 8s, …".
      const group = groups.filter({ hasText: '思考 8 秒' });
      const summary = group.locator(':scope > summary');
      assert.match(await summary.innerText(), /思考 8 秒/);
      if (!await group.evaluate(node => node.open)) await summary.click();
      const folded = group.locator('[data-thought]');
      assert.match(await folded.locator('summary').innerText(), /思考\s*8 秒/);
      if (!await folded.evaluate(node => node.open)) await folded.locator('summary').click();
      await folded.getByText('检查结果', { exact: true }).waitFor();
      await folded.getByRole('button', { name: 'app.css', exact: true }).waitFor();
    }
    async function assertThoughtStyle(theme) {
      const style = await paragraph.evaluate(node => {
        const root = document.documentElement;
        const sample = document.createElement('span');
        sample.hidden = true;
        sample.style.cssText = 'color: var(--secondary-text); font-size: var(--text-ui); border-inline-start: 2px solid var(--line-strong)';
        document.body.append(sample);
        const expected = getComputedStyle(sample);
        const thought = getComputedStyle(node);
        const prose = getComputedStyle(node.parentElement.querySelector(':scope > .markdown:not(.reply-thought)'));
        const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(channel => Number(channel) / 255)
          .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
          .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        const foreground = luminance(thought.color), paper = luminance(getComputedStyle(root).backgroundColor);
        const result = {
          theme: root.dataset.theme, font: parseFloat(thought.fontSize), proseFont: parseFloat(prose.fontSize), expectedFont: parseFloat(expected.fontSize),
          color: thought.color, secondary: expected.color, strong: getComputedStyle(node.querySelector('strong')).color,
          background: thought.backgroundColor, line: thought.borderInlineStart, expectedLine: expected.borderInlineStart,
          indent: parseFloat(thought.paddingInlineStart), lineHeight: parseFloat(thought.lineHeight) / parseFloat(thought.fontSize),
          proseLineHeight: parseFloat(prose.lineHeight) / parseFloat(prose.fontSize),
          contrast: (Math.max(foreground, paper) + .05) / (Math.min(foreground, paper) + .05),
        };
        sample.remove();
        return result;
      });
      assert.equal(style.theme, theme);
      assert.equal(style.font, style.expectedFont);
      assert.ok(style.font < style.proseFont);
      assert.equal(style.color, style.secondary);
      assert.equal(style.strong, style.secondary);
      assert.ok(style.contrast >= 4.5, `${theme} thinking contrast: ${style.contrast.toFixed(2)}:1`);
      assert.equal(style.background, 'rgba(0, 0, 0, 0)');
      assert.equal(style.line, style.expectedLine);
      assert.ok(style.indent > 0);
      assert.ok(Math.abs(style.lineHeight - style.proseLineHeight) < .01, 'thinking and prose use the same line-height setting');
      return style;
    }

    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    const toggle = settings.getByRole('checkbox', { name: '将思考展示为正文' });
    const theme = settings.getByLabel('界面主题');
    const openSettings = () => page.getByRole('button', { name: '界面与连接设置' }).click();
    const closeSettings = () => settings.getByRole('button', { name: '关闭设置' }).click();
    await openSettings();
    assert.equal(await toggle.isChecked(), false);
    await theme.selectOption('light');
    await closeSettings();
    await expandFoldedThought();
    await screenshot('light', 'off');
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
    const originalClipboard = await clipboard();
    async function expectCopy(control, expected) {
      await app.evaluate(({ clipboard }) => clipboard.writeText('clipboard fixture'));
      await control.click();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await clipboard() === expected) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(await clipboard(), expected);
    }
    const menu = page.locator('.context-menu:popover-open');
    async function expectMarkdownCopy(expected) {
      await body.dispatchEvent('contextmenu', { button: 2 });
      await expectCopy(menu.getByRole('menuitem', { name: '复制全文（Markdown）' }), expected);
    }
    try {
      await expectMarkdownCopy([narration, answer].join('\n\n'));
      await openSettings();
      assert.equal(await toggle.isChecked(), false);
      // Wait past the transcript's first-open settle window so a replay would be observable.
      await page.waitForTimeout(650);
      await reply.evaluate(node => {
        window.thinkingLayout = { reply: node, fades: [] };
        node.addEventListener('animationstart', event => window.thinkingLayout.fades.push(event.animationName));
      });
      async function assertQuietLayout() {
        const state = await reply.evaluate(async node => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { sameReply: node === window.thinkingLayout.reply,
            fades: [...window.thinkingLayout.fades, ...node.getAnimations({ subtree: true }).map(animation => animation.animationName)]
              .filter(name => /^lectern-(?:fade|text)-in$/.test(name)) };
        });
        assert.deepEqual(state, { sameReply: true, fades: [] }, 'reflow keeps the existing reply and does not replay fades');
      }
      await toggle.check();
      assert.equal(await paragraph.locator('p > strong').innerText(), '检查结果');
      assert.equal(await paragraph.locator('p code').innerText(), 'app.css');
      assert.equal(await body.locator('[data-thought]').count(), 0);
      const order = await body.locator(':scope > .markdown, :scope > .activity-group').evaluateAll(nodes =>
        nodes.map(el => el.querySelector(':scope > summary .activity-label, p')?.textContent.trim()));
      assert.deepEqual(order, [narration, '读取 1 个文件，修改 1 个文件', '检查结果', '执行 2 条命令', answer]);
      await assertQuietLayout();
      const light = await assertThoughtStyle('light');
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('lectern.desktop.preferences.v1')).showThinkingAsText === true);
      await closeSettings();
      await paragraph.getByRole('button', { name: 'app.css', exact: true }).waitFor();
      await screenshot('light', 'on');
      const expected = [narration, thinking, answer].join('\n\n');
      await expectCopy(reply.getByRole('button', { name: '复制回复' }), expected);
      await expectMarkdownCopy(expected);

      await openSettings();
      assert.equal(await toggle.isChecked(), true);
      await toggle.uncheck();
      await paragraph.waitFor({ state: 'detached' });
      await groups.locator(':scope > summary').filter({ hasText: '思考 8 秒' }).waitFor({ state: 'attached' });
      await assertQuietLayout();
      await theme.selectOption('dark');
      await closeSettings();
      await expandFoldedThought();
      await screenshot('dark', 'off');

      await openSettings();
      await toggle.check();
      const dark = await assertThoughtStyle('dark');
      assert.equal(dark.font, light.font, 'theme changes the palette without changing the font size');
      await closeSettings();
      await paragraph.getByRole('button', { name: 'app.css', exact: true }).waitFor();
      await screenshot('dark', 'on');

      await openSettings();
      await settings.getByRole('slider', { name: '界面字号' }).press('End');
      await settings.getByRole('button', { name: '聊天排版' }).click();
      await settings.getByRole('slider', { name: '对话行高' }).press('End');
      const larger = await assertThoughtStyle('dark');
      assert.ok(larger.font > dark.font, 'thinking follows the interface font size');
      assert.ok(larger.lineHeight > dark.lineHeight, 'thinking follows the chat line height');
      await settings.getByRole('button', { name: '外观' }).click();
      await toggle.uncheck();
      // Individual rows still show the thought folded, and the sed command as an edit.
      await settings.getByLabel('回复详细程度').selectOption('individual');
      await closeSettings();
      await expectCopy(reply.getByRole('button', { name: '复制回复' }), [narration, answer].join('\n\n'));
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard);
    }
    // Individual rows: the thought is its own folded row.
    const thought = body.locator('[data-thought]');
    assert.equal(await thought.count(), 1);
    assert.equal(await thought.evaluate(node => node.open), false);
    assert.ok(!(await reply.innerText()).includes('检查结果'));
    const sed = page.locator('[data-tool-id="sed1"]');
    await sed.locator('summary').click();
    const diff = sed.locator('.edit-diff');
    await diff.waitFor();
    assert.match(await diff.innerText(), /按 sed 命令还原的修改/);
    assert.equal(await diff.locator('.edit-diff-line.removed code').innerText(), '-color: blue');
    assert.equal(await diff.locator('.edit-diff-line.added code').innerText(), '+color: red');
    // The activity card floats over the chat; it may already be open, and lists a kind once that part is opened.
    const panel = page.locator('.activity-float');
    if (!await panel.count()) await page.getByRole('button', { name: '查看会话活动' }).click();
    await panel.waitFor();
    await panel.getByRole('button', { name: /^终端/ }).click();
    assert.deepEqual(await panel.locator('[data-activity-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-activity-id'))), ['bg1'],
      'only the background shell is a task in the panel');
    console.log('PASS render: ' + JSON.stringify({ progressNotes: true, thinkingToggle: true, themes: ['light', 'dark'], scalesWithSettings: true,
      quietReflow: true, copy: true, sedDiff: true, panel: ['bg1'] }));
  });
} finally { await app?.close(); privateServer.killAll(); await rm(root, { recursive: true, force: true }); }
