import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron, resizeWindow } from './fixtures/electron.mjs';
import { refreshFolderUntil } from './fixtures/sidebar-refresh.mjs';
import { spawnSync } from 'node:child_process';
import { ZipFile } from 'yazl';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-artifacts-ui-'));
// Workspace thumbnails come from the target: sips on macOS, python3 with Pillow elsewhere.
const workspaceThumbnails = process.platform === 'darwin' || spawnSync('python3', ['-I', '-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, LECTERN_NODE_BINARY: process.execPath, LECTERN_DIAGNOSTIC_CONTENT: '0' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;

function redPage() {
  const stream = '1 0 0 rg 8 8 184 184 re f\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
  let file = '%PDF-1.4\n';
  const offsets = objects.map((value, index) => {
    const at = file.length;
    file += `${index + 1} 0 obj\n${value}\nendobj\n`;
    return at;
  });
  const xref = file.length;
  return file + 'xref\n0 5\n0000000000 65535 f \n' + offsets.map(at => String(at).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer << /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

/** Claude Code records each line with its working directory: after `cd sub`, a reply's relative paths are from there. */
async function verifyReplyCwd(page, row, appendRows, cwd) {
  const sub = path.join(cwd, 'sub');
  await mkdir(sub, { recursive: true });
  const gif = data => Buffer.from(data, 'base64');
  await Promise.all([
    writeFile(path.join(cwd, 'notes.md'), '根目录的笔记'), writeFile(path.join(sub, 'notes.md'), '子目录的笔记'),
    writeFile(path.join(cwd, 'pic.gif'), gif('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==')),
    writeFile(path.join(sub, 'pic.gif'), gif('R0lGODlhAgABAPABAP8AAP///yH5BAAAAAAALAAAAAACAAEAAAICBAoAOw==')),
  ]);
  const text = value => ({ type: 'text', text: value }), inSub = { cwd: sub };
  await appendRows([
    row('user', { role: 'user', content: '对比两个目录的笔记。' }),
    row('assistant', { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content: [text('启动目录里的 notes.md。'),
      { type: 'tool_use', id: 'cd-sub', name: 'Bash', input: { command: 'cd sub && ls' } }] }),
    // The call is written in the old directory, its result and everything after in the new one.
    row('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cd-sub', content: 'notes.md\npic.gif' }] }, inSub),
    row('assistant', { id: randomUUID(), role: 'assistant', stop_reason: 'end_turn', content: [text('进入 sub 后的 notes.md。')] }, inSub),
    row('user', { role: 'user', content: '再看一次。' }, inSub),
    row('assistant', { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content: [text('第二条回复：notes.md 与 ../notes.md\n\n![子目录图片](pic.gif)'),
      { type: 'tool_use', id: 'read-sub', name: 'Read', input: { file_path: 'notes.md' } }] }, inSub),
    row('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-sub', content: '子目录的笔记' }] }, inSub),
    row('assistant', { id: randomUUID(), role: 'assistant', stop_reason: 'end_turn', content: [text('两份笔记都看过了。')] }, inSub),
  ]);
  const first = page.locator('.message-assistant').filter({ hasText: '启动目录里的 notes.md' });
  const second = page.locator('.message-assistant').filter({ hasText: '第二条回复' });
  await second.getByText('两份笔记都看过了。').waitFor();
  const link = (reply, text) => reply.locator('.markdown').filter({ hasText: text }).getByRole('button', { name: 'notes.md', exact: true });
  assert.equal(await link(first, '启动目录里').getAttribute('data-file-path'), 'notes.md');
  assert.equal(await link(first, '进入 sub 后').getAttribute('data-file-path'), 'sub/notes.md');
  assert.equal(await link(second, '第二条回复').getAttribute('data-file-path'), 'sub/notes.md');
  assert.equal(await second.getByRole('button', { name: '../notes.md', exact: true }).getAttribute('data-file-path'), 'notes.md');
  assert.equal(await second.locator('[data-tool-id="read-sub"] summary [data-file-path]').getAttribute('data-file-path'), 'sub/notes.md');
  // `cd sub && ls` lists files where the command left it.
  const cd = first.locator('[data-tool-id="cd-sub"]');
  await cd.locator('summary').click();
  assert.equal(await cd.locator('.tool-output').getByRole('button', { name: 'notes.md', exact: true }).getAttribute('data-file-path'), 'sub/notes.md');
  await cd.locator('summary').click();
  const drawer = page.getByRole('complementary', { name: '文件预览' });
  for (const [reply, text, body, file] of [[first, '启动目录里', '根目录的笔记', 'notes.md'], [first, '进入 sub 后', '子目录的笔记', 'sub/notes.md'], [second, '第二条回复', '子目录的笔记', 'sub/notes.md']]) {
    await link(reply, text).click();
    await drawer.getByText(body, { exact: true }).waitFor();
    assert.equal(await drawer.getAttribute('data-artifact-path'), file);
    await drawer.getByRole('button', { name: '关闭文件预览' }).click();
    await drawer.waitFor({ state: 'detached' });
  }
  // The picture is sub's (2×1), not the root's (1×1), in the thumbnail's dialog too.
  await second.getByRole('button', { name: '放大 子目录图片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '图片预览 · 子目录图片' });
  assert.equal(await dialog.getByRole('img', { name: '子目录图片', exact: true }).evaluate(async img => { await img.decode(); return img.naturalWidth; }), 2);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
}

async function verifyToolGroups(page, row, appendRows) {
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const result = (id, content, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
  const text = text => ({ type: 'text', text });
  const start = '检查本轮工具的排列。';
  const middle = '继续读取。';
  const end = '检查完毕。';
  const read = { file_path: 'NOTICE' };
  const edit = { file_path: 'a.txt', old_string: 'old', new_string: 'new' };
  await appendRows([
    row('user', { role: 'user', content: '验证两种工具展示方式。' }),
    row('assistant', { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content: [
      text(start), use('r1', 'Read', read), use('r2', 'Read', read),
      use('sh1', 'Bash', { command: 'pwd' }), use('sh2', 'PowerShell', { command: 'Get-Location' }),
      use('send1', 'SendMessage', { to: '核对代理', message: '请核对读写记录' }),
    ] }),
    row('user', { role: 'user', content: '已核对读写记录' }, { origin: { kind: 'peer', name: '核对代理', msg_id: 'peer1', senderTaskId: 'agent-1' } }),
    row('assistant', { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content: [
      use('r3', 'Read', read), text(middle), use('r4', 'Read', read),
      use('e1', 'Edit', edit), use('e2', 'MultiEdit', { file_path: 'a.txt', edits: [edit] }),
      use('e3', 'NotebookEdit', { notebook_path: 'notes.ipynb', new_source: 'notes' }),
    ] }),
    row('user', { role: 'user', content: [result('sh2', '命令失败', true)] }),
  ]);

  const reply = page.locator('.message-assistant').filter({ hasText: start });
  const layout = () => reply.locator('.message-content > *').evaluateAll(nodes => nodes.map(node =>
    node.matches('.tool-group') ? Array.from(node.querySelectorAll('[data-tool-id], [data-peer-id]'), item => item.dataset.toolId ?? item.dataset.peerId) :
      node.matches('.tool-live') ? `live:${node.dataset.liveTool}` :
      node.dataset.toolId ?? node.dataset.peerId ?? node.textContent.trim()));
  const compact = [start, ['r1', 'r2', 'sh1', 'sh2', 'send1', 'peer1', 'r3'], middle, ['r4', 'e1', 'e2', 'e3']];
  const group = id => reply.locator('.tool-group').filter({ has: page.locator(`[data-tool-id="${id}"]`) });
  const card = id => reply.locator(`[data-tool-id="${id}"]`);
  const summary = locator => locator.locator(':scope > summary');
  const shells = group('sh1');
  const firstShell = card('sh1');
  await summary(shells).getByText('1 次失败 · 5 次进行中').waitFor();
  await summary(shells).getByText(/执行 2 条命令，发送消息 1 次，收到 1 条消息/).waitFor();
  // The still-running foreground command (sh1) shows below its collapsed group, as in Claude Code.
  assert.deepEqual(await layout(), [compact[0], compact[1], 'live:sh1', ...compact.slice(2)], 'Tools and peer deliveries merge only at the same position, in recorded order');
  assert.equal(await reply.locator('details[open]').count(), 0);
  await summary(shells).click();
  await summary(card('sh2')).getByText('执行失败').waitFor();
  await summary(firstShell).getByText('进行中').waitFor();
  await summary(firstShell).click();
  await firstShell.locator('pre').filter({ hasText: 'pwd' }).waitFor();
  const peer = reply.locator('[data-peer-id="peer1"]');
  await summary(peer).getByText('核对代理').click();
  await peer.getByText('已核对读写记录', { exact: true }).waitFor();
  await summary(card('send1')).getByText('核对代理').waitFor();
  await appendRows([
    row('user', { role: 'user', content: ['e3', 'e2', 'r4', 'r3', 'r2', 'r1', 'send1', 'sh1'].map(id => result(id, `完成 ${id}`)) }),
    row('user', { role: 'user', content: [result('e1', '完成 e1')] }, { toolUseResult: { structuredPatch: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
    ] } }),
    row('assistant', { role: 'assistant', content: end, stop_reason: 'end_turn' }),
  ]);
  await firstShell.getByText('完成 sh1', { exact: true }).waitFor();
  assert.equal(await summary(shells).locator('.tool-state').innerText(), '1 次失败');
  assert.deepEqual(await layout(), [...compact, end]);
  assert.equal(await firstShell.evaluate(node => node.open), true);
  assert.equal(await shells.evaluate(node => node.open), true);
  const edits = group('e1');
  await summary(edits).getByText('读取 1 个文件，修改 2 个文件', { exact: true }).waitFor();
  await summary(edits).getByText('已知', { exact: true }).waitFor();
  await summary(edits).getByText('+1', { exact: true }).waitFor();
  await summary(edits).getByText('−1', { exact: true }).waitFor();
  await summary(edits).click();
  assert.equal(await edits.locator('[data-tool-id][open]').count(), 0);
  assert.equal(await card('e1').getByRole('region', { name: '编辑差异' }).isVisible(), false);
  await summary(card('e1')).click();
  await card('e1').getByRole('region', { name: '编辑差异' }).getByText('+new', { exact: true }).waitFor();
  await summary(card('e1')).click();
  await summary(shells).click();
  await reply.screenshot({ path: path.join(results, 'desktop-mixed-activities.png') });

  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const openSettings = () => page.getByRole('button', { name: '界面与连接设置' }).click();
  const closeSettings = () => settings.getByRole('button', { name: '关闭设置' }).click();
  const detail = settings.getByLabel('回复详细程度');
  const individual = [...compact.flat(), end];
  await openSettings();
  assert.equal(await detail.inputValue(), 'compact');
  await detail.selectOption({ label: '逐条（单独列出工具）' });
  await closeSettings();
  assert.deepEqual(await layout(), individual);
  assert.equal(await card('e1').evaluate(node => node.open), false);
  await page.reload();
  await reply.waitFor();
  assert.deepEqual(await layout(), individual, 'The renderer loads the saved detail level');
  assert.equal(await reply.locator('details[open]').count(), 0);
  await openSettings();
  assert.equal(await detail.inputValue(), 'individual');
  await settings.getByRole('button', { name: '恢复默认外观' }).click();
  assert.equal(await detail.locator('option:checked').textContent(), '精简（汇总连续操作）');
  await closeSettings();
  assert.deepEqual(await layout(), [...compact, end]);
  await page.reload();
  await reply.waitFor();
  assert.deepEqual(await layout(), [...compact, end], 'Restoring default appearance also persists');
}

async function verifyWrappedFileLinks(app, page, row, appendRows, cwd) {
  const file = 'demo/fixtures/format_examples/example_documentation/nested/example_path.py';
  const missing = file.replace('example_path', 'example_text');
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), '# Wrapped path fixture\n');
  const markdown = [
    '| 路径 | 示例说明 |',
    '| --- | --- |',
    '| `' + file + '` | `-1` 开 / `+1` 闭（Bridge 5.0 Hz / Google Robot 3.0 Hz） |',
    '| `' + missing + '` | 普通行内代码 |',
    '',
    '段落中的路径 `' + file + '`。',
  ].join('\n');
  const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
  await resizeWindow(app, page, 920, 760);
  await appendRows([
    row('user', { role: 'user', content: '检查示例路径。' }),
    row('assistant', { id: randomUUID(), role: 'assistant', content: markdown, stop_reason: 'end_turn' }),
  ]);
  const reply = page.locator('.message-assistant:not([data-leaving])').filter({ hasText: '段落中的路径' });
  const table = reply.locator('table');
  const tableLink = table.getByRole('button', { name: file, exact: true });
  const paragraphLink = reply.locator('p').getByRole('button', { name: file, exact: true });
  await tableLink.waitFor();
  await paragraphLink.waitFor();
  await reply.locator('[data-fade="in"], [data-text-fade]').first().waitFor({ state: 'hidden' });

  const decoration = locator => locator.evaluate(code => {
    const style = getComputedStyle(code);
    const fragments = [...code.getClientRects()];
    const range = document.createRange();
    range.selectNodeContents(code.querySelector('[data-file-path]') ?? code);
    const text = [...range.getClientRects()].filter(rect => rect.width > 0);
    return {
      style: [style.backgroundColor, style.boxShadow, style.borderRadius, style.boxDecorationBreak],
      fragments: fragments.length,
      lines: new Set(text.map(rect => rect.top)).size,
      coversText: text.every(rect => fragments.some(box => box.top <= rect.top && box.bottom >= rect.bottom &&
        box.left <= rect.left + 0.5 && box.right >= rect.right - 0.5)),
    };
  });
  const plain = await decoration(table.locator('td code').filter({ hasText: missing }));
  assert.notEqual(plain.style[0], 'rgba(0, 0, 0, 0)');
  assert.notEqual(plain.style[1], 'none');
  for (const code of [table.locator('td code').filter({ hasText: file }), reply.locator('p code')]) {
    const decorated = await decoration(code);
    assert.ok(decorated.lines > 1, 'The code-style file path wraps');
    assert.equal(decorated.fragments, decorated.lines, 'Each text line gets a decorated code fragment');
    assert.ok(decorated.coversText, 'The code fragments enclose all lines of text');
    assert.deepEqual(decorated.style, plain.style, 'The link uses the same code decoration as plain inline code');
  }
  const description = table.locator('tbody tr').first().locator('td').last();
  assert.equal(await description.textContent(), '-1 开 / +1 闭（Bridge 5.0 Hz / Google Robot 3.0 Hz）');
  assert.equal(await description.locator('[data-file-path]').count(), 0, 'Slash separators stay plain text');

  const drawer = page.getByRole('complementary', { name: '文件预览' });
  await tableLink.focus();
  await page.keyboard.press('Tab');
  assert.equal(await paragraphLink.evaluate(link => link === document.activeElement), true);
  for (const [link, key] of [[paragraphLink, 'Enter'], [tableLink, 'Space']]) {
    await link.press(key);
    await drawer.getByText('# Wrapped path fixture', { exact: true }).waitFor();
    assert.equal(await drawer.getAttribute('data-artifact-path'), file);
    await drawer.getByRole('button', { name: '关闭文件预览' }).click();
    await drawer.waitFor({ state: 'detached' });
  }
  assert.ok((await tableLink.getAttribute('title'))?.includes(file));
  const menu = page.locator('.context-menu:popover-open');
  await tableLink.dispatchEvent('contextmenu', { button: 2 });
  await menu.getByRole('menuitem', { name: '预览文件' }).waitFor();
  await menu.getByRole('menuitem', { name: '复制全文（Markdown）' }).click();
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(await clipboard(), markdown);
  await tableLink.dispatchEvent('contextmenu', { button: 2 });
  await menu.getByRole('menuitem', { name: '复制纯文本' }).click();
  const copied = await clipboard();
  assert.equal(copied.split(file).length - 1, 2, 'Copying plain text preserves both paths verbatim');
  assert.ok(!copied.includes('`'), 'Plain text excludes Markdown markers');
  await resizeWindow(app, page, width, height);
}

/** Formulas: KaTeX's fonts load, `$$…$$` alone is a display formula that scrolls on its own, a path in
 * a formula is not a file link, and copying gives each formula's TeX once (Ctrl+C and the menu). */
async function verifyFormulas(app, page, row, appendRows, cwd) {
  const file = 'demo/formula-input.txt';
  await mkdir(path.join(cwd, 'demo'), { recursive: true });
  await writeFile(path.join(cwd, file), 'formula input\n');
  const display = String.raw`g=\frac1N\sum_i \hat A_i\sum_{t,k}\Big[\underbrace{\nabla_\theta\log\pi_\theta(y^k_{i,t}\mid c^k_{i,t})}_{\text{第一项：实际采到的 token 的 score}}-\underbrace{\mathbb E_{v\sim\mu(\cdot\mid c^k_{i,t})}\nabla_\theta\log\pi_\theta(v\mid c^k_{i,t})}_{\text{第二项：score 在 rollout 策略 }\mu\text{ 下的期望}}\Big]`;
  const markdown = ['论文公式 (2) 是：', '', '$$ ' + display + ' $$', '',
    String.raw`第二项是 $\nabla_\theta \log \pi_\theta$ 在 $\mu$ 下的期望，输入写在 $` + file + '$ 和 ' + file + '，费用 $5 到 $10。'].join('\n');
  await appendRows([
    row('user', { role: 'user', content: '解释公式。' }),
    row('assistant', { id: randomUUID(), role: 'assistant', content: markdown, stop_reason: 'end_turn' }),
  ]);
  const reply = page.locator('.message-assistant:not([data-leaving])').filter({ hasText: '论文公式 (2) 是' });
  await reply.locator('.katex-display').waitFor();
  await reply.getByRole('button', { name: file, exact: true }).waitFor();
  await reply.locator('[data-fade="in"], [data-text-fade]').first().waitFor({ state: 'hidden' });
  const shape = await reply.evaluate(node => {
    const content = node.querySelector('.message-content'), block = node.querySelector('.katex-display');
    return { formulas: node.querySelectorAll('.katex').length, displays: node.querySelectorAll('.katex-display').length,
      emphasis: node.querySelectorAll('.katex-display em, p em').length, linksInFormulas: node.querySelectorAll('.katex [data-file-path]').length,
      overflow: getComputedStyle(block).overflowX, contentFits: content.scrollWidth <= content.clientWidth + 1,
      katexFonts: [...document.fonts].filter(face => face.family.includes('KaTeX') && face.status === 'loaded').length };
  });
  assert.deepEqual({ ...shape, katexFonts: shape.katexFonts > 0 },
    { formulas: 4, displays: 1, emphasis: 0, linksInFormulas: 0, overflow: 'auto', contentFits: true, katexFonts: true });
  await reply.screenshot({ path: path.join(results, 'desktop-formula.png') });
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  // Ctrl+C on a selection from the first paragraph through the formula into the next paragraph.
  await reply.evaluate(node => {
    const paragraphs = node.querySelectorAll('.message-content p'), range = document.createRange();
    range.setStart(paragraphs[0].firstChild, 0);
    range.setEnd(paragraphs[paragraphs.length - 1].firstChild, 3);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
  await page.waitForFunction(() => true);
  const copied = await clipboard();
  assert.equal(copied.trim().split('\n').filter(Boolean).join('\n'), '论文公式 (2) 是：\n$$' + display + '$$\n第二项', copied);
  const menu = page.locator('.context-menu:popover-open');
  await reply.locator('.message-content p').last().dispatchEvent('contextmenu', { button: 2 });
  await menu.getByRole('menuitem', { name: '复制纯文本' }).click();
  const plain = await clipboard();
  assert.equal(plain.split(display).length - 1, 1, 'The display formula once, as TeX');
  assert.ok(plain.includes(String.raw`$\nabla_\theta \log \pi_\theta$`) && plain.includes('$' + file + '$') && plain.includes('费用 $5 到 $10'), plain);
  assert.ok(!/[∑∇μ]/u.test(plain), 'No KaTeX glyphs or MathML text');
  await page.evaluate(() => getSelection().removeAllRanges());
}

/** A cited path opens at its lines, Claude's configuration opens like any file, and a large text file asks first. */
async function verifyLinesAndLargeFiles(app, page, row, appendRows, cwd) {
  await mkdir(path.join(cwd, '.claude'), { recursive: true });
  await writeFile(path.join(cwd, 'demo/lines.ts'), Array.from({ length: 400 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  await writeFile(path.join(cwd, '.claude/CLAUDE.md'), '# 项目规则\n\n只用相对路径。\n');
  const big = Array.from({ length: 70_000 }, (_, i) => `{"entry": ${i + 1}, "ok": true}`).join('\n') + '\n';
  await writeFile(path.join(cwd, 'demo/big.jsonl'), big);
  await appendRows([
    row('user', { role: 'user', content: '在哪里改？' }),
    row('assistant', { id: randomUUID(), role: 'assistant', content: '改 `demo/lines.ts:262-281`，规则见 `.claude/CLAUDE.md`，日志在 demo/big.jsonl 。', stop_reason: 'end_turn' }),
  ]);
  const reply = page.locator('.message-assistant:not([data-leaving])').filter({ hasText: '规则见' });
  const drawer = page.getByRole('complementary', { name: '文件预览' });
  const cited = reply.getByRole('button', { name: 'demo/lines.ts:262-281', exact: true });
  assert.equal(await cited.getAttribute('data-file-lines'), '262-281');
  await cited.click();
  await drawer.locator('.code-line[data-focus]').first().waitFor();
  const focus = await drawer.evaluate(node => {
    const lines = [...node.querySelectorAll('.code-line[data-focus]')], box = node.querySelector('.artifact-content').getBoundingClientRect();
    const first = lines[0].getBoundingClientRect();
    return { count: lines.length, first: lines[0].textContent.trim(), last: lines.at(-1).textContent.trim(), visible: first.top >= box.top && first.bottom <= box.bottom };
  });
  assert.deepEqual(focus, { count: 20, first: 'export const line262 = 262;', last: 'export const line281 = 281;', visible: true });
  await drawer.screenshot({ path: path.join(results, 'desktop-cited-lines.png') });
  await drawer.getByRole('button', { name: '关闭文件预览' }).click();
  await reply.getByRole('button', { name: '.claude/CLAUDE.md', exact: true }).click();
  await drawer.getByRole('heading', { name: '项目规则' }).waitFor();
  await drawer.getByRole('button', { name: '关闭文件预览' }).click();
  await reply.getByRole('button', { name: 'demo/big.jsonl', exact: true }).click();
  const question = drawer.getByRole('group', { name: `文件较大（${(Buffer.byteLength(big) / 1024 / 1024).toFixed(1)} MB），是否打开？` });
  await question.waitFor();
  assert.equal(await drawer.locator('.code-line').count(), 0, 'Nothing is shown before the user chooses');
  await drawer.screenshot({ path: path.join(results, 'desktop-large-file.png') });
  const saved = path.join(profile, 'saved big.jsonl');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, saved);
  await question.getByRole('button', { name: '下载到本地' }).click();
  await drawer.getByText('已保存').waitFor();
  assert.equal(await readFile(saved, 'utf8'), big);
  await question.getByRole('button', { name: '仍然打开' }).click();
  await drawer.locator('.code-line').nth(69_999).waitFor({ state: 'attached' });
  assert.equal(await drawer.locator('.code-preview').getAttribute('data-highlighted'), null, 'No syntax highlighting over 1 MiB');
  await drawer.getByRole('button', { name: '关闭文件预览' }).click();
  await drawer.waitFor({ state: 'detached' });
}

async function verifyCachedLinks(app, page, workspace, project) {
  const file = 'cached-example.md', marker = '缓存链接示例';
  const [first, second] = [randomUUID(), randomUUID()];
  for (const [sessionId, reply] of [[first, marker + '：`' + file + '`'], [second, '另一个对话的正文']]) {
    const timestamp = new Date().toISOString(), prompt = randomUUID(), answer = randomUUID();
    const records = [
      { type: 'user', uuid: prompt, parentUuid: null, sessionId, cwd: workspace.cwd, timestamp, message: { role: 'user', content: '离线测试提问' } },
      { type: 'assistant', uuid: answer, parentUuid: prompt, sessionId, cwd: workspace.cwd, timestamp,
        message: { id: answer, role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' } },
    ];
    await writeFile(path.join(project, sessionId + '.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
  await refreshFolderUntil(page, workspace.id, row(first));
  await row(second).waitFor();
  await app.evaluate(({ ipcMain }, file) => {
    globalThis.artifactResolutionCalls = [];
    ipcMain.removeHandler('lectern:resolveArtifactReferences');
    ipcMain.handle('lectern:resolveArtifactReferences', async (_event, _id, references) => {
      globalThis.artifactResolutionCalls.push(references);
      return references.map(ref => (typeof ref === 'string' ? ref : ref.path) === file ? { path: file } : null);
    });
  }, file);
  const calls = () => app.evaluate(() => globalThis.artifactResolutionCalls);
  const link = page.locator(`.message-assistant:not([data-leaving]) [data-file-path="${file}"]`);
  await row(first).click();
  await link.waitFor();
  const originalCalls = await calls();
  assert.deepEqual(originalCalls.flat().filter(ref => ref.path === file), [{ path: file, cwd: workspace.cwd }]);
  await row(second).click();
  await page.getByText('另一个对话的正文', { exact: true }).waitFor();
  assert.equal(await link.count(), 0);
  await page.evaluate(({ marker, file }) => {
    const frames = [];
    const observer = new MutationObserver(() => {
      const message = [...document.querySelectorAll('.message-assistant:not([data-leaving])')].find(node => node.textContent.includes(marker));
      if (!message) return;
      frames.push({
        linked: !!message.querySelector(`[data-file-path="${file}"]`),
        faded: message.matches('[data-fade="in"]') || !!message.querySelector('[data-fade="in"], [data-text-fade]'),
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-fade', 'data-text-fade'] });
    window.readCachedLinkFrames = () => { observer.disconnect(); return frames; };
  }, { marker, file });
  await row(first).click();
  await link.waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const frames = await page.evaluate(() => window.readCachedLinkFrames());
  assert.ok(frames.length > 0, 'Observed the returning transcript');
  assert.ok(frames.every(frame => frame.linked && !frame.faded), 'The returning link is present in the first commit and never fades in');
  assert.deepEqual(await calls(), originalCalls, 'Returning to the conversation did not look up its links again');
}

let app;
try {
  const executablePath = process.argv[2];
  app = await electron.launch({ ...(executablePath && { executablePath: path.resolve(executablePath) }), args: [...(executablePath ? [] : ['.']), '--demo'], env, timeout: 60000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const browserErrors = [];
  const remoteRequests = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('request', request => { if (/^https?:\/\//.test(request.url())) remoteRequests.push(request.url()); });
  await page.locator('.message-assistant').first().waitFor();
  const { workspace, session } = await page.evaluate(async () => {
    const [workspace] = await window.desktop.listWorkspaces();
    const session = (await window.desktop.discover(workspace.id)).sessions[0];
    return { workspace, session };
  });
  const { cwd } = workspace;
  assert.ok(session.path);
  const image = Buffer.from('R0lGODlhAgABAPABAP8AAP///yH5BAAAAAAALAAAAAACAAEAAAICBAoAOw==', 'base64');
  const bytes = Buffer.from([0, 128, 255, 22, 0]);
  const docx = new ZipFile();
  docx.addBuffer(Buffer.from('<w:document xmlns:w="test"><w:p><w:r><w:t>离线文档正文</w:t></w:r></w:p></w:document>'), 'word/document.xml');
  docx.end();
  const folder = path.join(cwd, 'preview files');
  await mkdir(folder);
  await mkdir(path.join(cwd, 'src', 'panels'), { recursive: true });
  await mkdir(path.join(cwd, 'manual'));
  await mkdir(path.join(cwd, 'paged'));
  await Promise.all(Array.from({ length: 251 }, (_, i) => writeFile(path.join(cwd, 'paged', String(i).padStart(3, '0')), '')));
  await Promise.all([
    writeFile(path.join(folder, 'guide.md'), '# Lectern 手册\n\n[源文件](demo.ts) ![外链图片](https://example.invalid/no-network.png)'),
    writeFile(path.join(folder, 'demo.ts'), 'export const answer = 42;\n'),
    writeFile(path.join(folder, 'pixel.gif'), image),
    writeFile(path.join(folder, 'sample.pdf'), redPage()),
    ...['tiny.webm', 'tiny.mp4', 'tiny.mp3'].map(name => copyFile(path.resolve('tests/fixtures/media', name), path.join(folder, name))),
    writeFile(path.join(folder, 'sample.docx'), docx.outputStream),
    writeFile(path.join(folder, 'unknown.blob'), bytes),
    writeFile(path.join(cwd, 'NOTICE'), 'extensionless fixture'),
    writeFile(path.join(cwd, 'src/panels/ProxyPanel.tsx'), 'export const located = true;'),
    writeFile(path.join(cwd, 'src/panels/中文ProxyPanel.tsx'), 'export const localized = true;'),
    writeFile(path.join(cwd, 'src/index.ts'), 'first index'),
    writeFile(path.join(cwd, 'index.ts'), 'second index'),
    writeFile(path.join(cwd, 'usage.current'), 'not a prose link'),
    writeFile(path.join(cwd, 'manual/startup'), 'not a prose link'),
    writeFile(path.join(cwd, 'volatile.txt'), 'delete after link is resolved'),
    writeFile(path.join(profile, 'outside.md'), 'private outside fixture'),
  ]);
  const row = (type, message, extra = {}) => ({ type, message, uuid: randomUUID(), sessionId: session.id, cwd, ...extra });
  const noise = '400/429 3000/3010 usage.current manual/startup';
  const outside = path.join(profile, 'outside.md');
  const rows = [
    row('user', { role: 'user', content: [{ type: 'text', text: `请检查 <literal> @preview/hello.ts 和 [笔记](<preview files/guide.md>)。普通文本：ProxyPanel.tsx ${noise} index.ts` },
      { type: 'image', title: '粘贴图片.gif', source: { type: 'base64', media_type: 'image/gif', data: image.toString('base64') } }] }),
    row('assistant', { id: randomUUID(), role: 'assistant', content: [
      { type: 'text', text: ['打开 [文件夹](<preview files>)、![图像](<preview files/pixel.gif>) 和 [PDF](<preview files/sample.pdf>)。',
        '找不到的路径：`missing.txt`。测试重试：`volatile.txt`。', `[跨目录](${outside}) ${outside} [失效](not-here.md)`,
        `普通文本：ProxyPanel.tsx ${noise} index.ts。改了ProxyPanel.tsx和index.ts。中文ProxyPanel.tsx。`, '`ProxyPanel.tsx:42` `index.ts` `usage.current` `manual/startup`',
        '```ts\nimport "./src/index.ts"; // ProxyPanel.tsx index.ts ' + noise + '\n```', '![外链图片](https://example.invalid/tracking.png)',
        '参考 [Lectern 文档](https://example.invalid/docs?from=reply) 和 https://example.invalid/bare-link'].join('\n\n') },
      { type: 'tool_use', id: 'read-file', name: 'Read', input: { file_path: 'NOTICE' } },
      { type: 'text', text: '已读取说明，接下来修改示例。' },
      { type: 'tool_use', id: 'edit-file', name: 'Edit', input: { file_path: 'preview files/demo.ts', old_string: '41', new_string: '42' } },
    ], stop_reason: 'tool_use' }),
    row('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-file', content: [
      { type: 'text', text: 'See also "preview files/guide.md"' },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: image.toString('base64') } },
    ] }] }),
    row('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-file', content: 'Updated file.' }] },
      { toolUseResult: { filePath: 'preview files/demo.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-export const answer = 41;', '+export const answer = 42;'] }] } }),
  ];
  rows.push(row('assistant', { role: 'assistant', content: '示例已经修改。', stop_reason: 'end_turn' }));
  const appendRows = batch => appendFile(session.path, batch.map(record => JSON.stringify(record)).join('\n') + '\n');
  await appendRows(rows.slice(0, 2));
  const pending = page.locator('[data-tool-id="read-file"][data-tool-state="pending"]');
  await pending.locator('summary').click();
  await appendRows(rows.slice(2));
  const reply = page.locator('.message-assistant').filter({ hasText: '示例已经修改。' });
  await reply.waitFor();
  const order = await reply.locator('.message-content > *').evaluateAll(nodes => nodes.map(node =>
    node.dataset.toolId ?? node.dataset.chatImage ?? node.textContent.trim()));
  assert.deepEqual(order.slice(1), ['read-file', '已读取说明，接下来修改示例。', 'edit-file', '图片-1.gif', '示例已经修改。']);
  assert.equal(await reply.locator('details .chat-image').count(), 0);
  await reply.locator('[data-chat-image="图像"]').scrollIntoViewIfNeeded();
  if (workspaceThumbnails) {
    assert.equal(await reply.getByRole('img', { name: '图像', exact: true }).evaluate(async img => { await img.decode(); return img.naturalWidth; }), 2);
  } else {
    // Linux without Pillow has no thumbnail converter: the image stays a clickable placeholder.
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(await reply.getByRole('button', { name: '放大 图像', exact: true }).locator('img').count(), 0);
    console.log('NOTE: python3 Pillow is not installed, so workspace thumbnails were checked as placeholders.');
  }
  assert.match(order[0], /打开/);
  // 网址交给系统浏览器打开：应用窗口不跳转，也不开新窗口。
  await app.evaluate(({ shell }) => { globalThis.openedLinks = []; shell.openExternal = async url => { globalThis.openedLinks.push(url); }; });
  const [pageUrl, windowCount] = [page.url(), app.windows().length];
  await reply.getByRole('link', { name: 'Lectern 文档', exact: true }).click();
  await reply.getByRole('link', { name: 'https://example.invalid/bare-link', exact: true }).click();
  const openedLinks = () => app.evaluate(() => globalThis.openedLinks);
  for (let i = 0; i < 50 && (await openedLinks()).length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await openedLinks(), ['https://example.invalid/docs?from=reply', 'https://example.invalid/bare-link']);
  assert.equal(page.url(), pageUrl);
  assert.equal(app.windows().length, windowCount);
  assert.equal(await reply.locator('[data-tool-id="read-file"][data-tool-state="completed"]').evaluate(node => node.open), true);
  const editCard = reply.locator('[data-tool-id="edit-file"]');
  assert.equal(await editCard.evaluate(node => node.open), false, 'A native Edit patch arrives without opening the card');
  await editCard.locator('summary').click();
  const edit = editCard.getByRole('region', { name: '编辑差异' });
  await edit.waitFor();
  assert.match(await edit.innerText(), /已应用的修改/);
  assert.match(await edit.innerText(), /\+export const answer = 42/);
  assert.match(await page.locator('.user-text').last().innerText(), /<literal>/);
  const drawer = page.getByRole('complementary', { name: '文件预览' });
  const close = () => drawer.getByRole('button', { name: '关闭文件预览' }).click();
  const pick = (name) => drawer.getByRole('button', { name, exact: true }).click();
  const userText = page.locator('.user-text').last();
  const panelPath = 'src/panels/ProxyPanel.tsx';
  await userText.locator(`[data-file-path="${panelPath}"]`).waitFor();
  for (const source of [reply, userText]) {
    for (const term of [...noise.split(' '), ...source === userText ? ['index.ts'] : [], 'missing.txt', '失效']) {
      assert.equal(await source.getByRole('button', { name: term, exact: true }).count(), 0, `Unverified text must not link: ${term}`);
    }
  }
  // index.ts is in two places; the reply was written at the root (its records' cwd), so it names the root's.
  assert.deepEqual(new Set(await reply.getByRole('button', { name: 'index.ts', exact: true }).evaluateAll(nodes => nodes.map(node => node.dataset.filePath))), new Set(['index.ts']));
  // An existing file outside the folder, named explicitly, links and opens without a consent dialog.
  const outsideReal = await realpath(outside); // macOS: /var is /private/var
  assert.equal(await reply.locator(`[data-file-path="${outsideReal}"]`).count(), 2, 'the Markdown link and the bare absolute path');
  await reply.getByRole('button', { name: '跨目录', exact: true }).click();
  await drawer.getByText('private outside fixture').waitFor();
  assert.equal(await drawer.getAttribute('data-artifact-path'), outsideReal);
  await close();
  const prose = reply.locator('p').filter({ hasText: '改了ProxyPanel.tsx和index.ts。' });
  await prose.getByRole('button', { name: 'ProxyPanel.tsx', exact: true }).nth(1).waitFor();
  assert.equal(await prose.getByRole('button', { name: '中文ProxyPanel.tsx', exact: true }).getAttribute('data-file-path'), 'src/panels/中文ProxyPanel.tsx');
  const literal = reply.locator('pre code');
  await literal.getByRole('button', { name: 'ProxyPanel.tsx', exact: true }).click();
  await drawer.getByText('export const located = true;').waitFor();
  assert.equal(await drawer.getAttribute('data-artifact-path'), panelPath);
  await close();
  await reply.locator('p code').getByRole('button', { name: 'ProxyPanel.tsx:42' }).waitFor();
  assert.equal(await literal.locator('[data-file-path="src/index.ts"]').count(), 1, 'Explicit ./src/index.ts is exact even when index.ts is ambiguous');
  const block = reply.locator('.code-block');
  assert.deepEqual(await block.locator('pre').evaluate(pre => ({ wrap: getComputedStyle(pre).whiteSpace, fits: pre.scrollWidth <= pre.clientWidth + 1 })),
    { wrap: 'pre-wrap', fits: true }, 'Code lines fold inside the column');
  await block.hover();
  const copyCode = block.getByRole('button', { name: '复制代码', exact: true });
  await copyCode.evaluate(node => new Promise(resolve => {
    const check = () => getComputedStyle(node).opacity === '1' ? resolve() : requestAnimationFrame(check); check();
  }));
  await copyCode.click();
  await block.getByRole('button', { name: '已复制代码', exact: true }).waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'import "./src/index.ts"; // ProxyPanel.tsx index.ts ' + noise);
  await edit.getByRole('button', { name: 'preview files/demo.ts' }).click();
  await drawer.getByText('export const answer = 42;', { exact: true }).waitFor();
  const code = drawer.locator('.code-preview[data-language="typescript"][data-line-numbers="true"][data-wrap="true"]');
  await code.locator('.hljs-keyword').first().waitFor();
  assert.deepEqual(await code.locator('.hljs-keyword').allTextContents(), ['export', 'const']);
  assert.equal(await code.locator('.hljs-number').textContent(), '42');
  assert.equal(await code.locator('.code-line').count(), 1, 'The final newline adds no empty line');
  // The left edge resizes the panel like the sidebar; the width is kept for the next file.
  const edge = drawer.getByRole('separator', { name: '调整文件预览宽度' });
  const initialWidth = (await drawer.boundingBox()).width;
  const grip = await edge.boundingBox();
  await page.mouse.move(grip.x + 3, grip.y + grip.height / 2);
  await page.mouse.down();
  // The preview sits in the chat pane, which keeps 500px for the chat.
  await page.mouse.move(grip.x - 57, grip.y + grip.height / 2, { steps: 6 });
  await page.mouse.up();
  const widened = (await drawer.boundingBox()).width;
  assert.ok(Math.abs(widened - initialWidth - 60) <= 2, `dragged ${initialWidth} → ${widened}`);
  await close();
  await edit.getByRole('button', { name: 'preview files/demo.ts' }).click();
  await drawer.getByText('export const answer = 42;', { exact: true }).waitFor();
  assert.ok(Math.abs((await drawer.boundingBox()).width - widened) <= 1, 'the width survives reopening');
  await edge.focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(Math.abs((await drawer.boundingBox()).width - (widened - 24)) <= 1, 'arrow keys resize too');
  await edge.dblclick();
  assert.ok(Math.abs((await drawer.boundingBox()).width - initialWidth) <= 1, 'double click restores the default width');
  await page.screenshot({ path: path.join(results, 'desktop-edit-file-preview.png') });
  await close();
  const tool = page.locator('[data-tool-id="read-file"]');
  await tool.locator('summary [data-file-path="NOTICE"]').click();
  await drawer.getByText('extensionless fixture').waitFor();
  await close();
  if (!await tool.evaluate(node => node.open)) await tool.locator('summary').click();
  await tool.locator('[data-file-path="preview files/guide.md"]').click();
  await drawer.getByRole('heading', { name: 'Lectern 手册' }).waitFor();
  await pick('源码');
  await drawer.locator('.code-preview[data-language="markdown"]').getByText('# Lectern 手册', { exact: true }).waitFor();
  await pick('渲染');
  await pick('源文件');
  await drawer.getByText('export const answer = 42;', { exact: true }).waitFor();
  await pick('返回上一项');
  await drawer.getByRole('heading', { name: 'Lectern 手册' }).waitFor();
  await close();
  await page.getByRole('button', { name: '文件夹', exact: true }).click();
  await pick('pixel.gif');
  await page.waitForFunction(() => document.querySelector('.artifact-image img')?.naturalWidth === 2);
  await pick('打开上级目录');
  // Real VP8, H.264 and MP3 files play from memory in the native player.
  for (const [name, tag] of [['tiny.webm', 'video'], ['tiny.mp4', 'video'], ['tiny.mp3', 'audio']]) {
    await pick(name);
    const player = drawer.locator(`.artifact-content ${tag}`);
    await player.waitFor();
    const loaded = await player.evaluate(media => new Promise(resolve => {
      const done = () => resolve({ ready: media.readyState >= 1, width: media.videoWidth ?? 0, duration: Math.round(media.duration * 10) / 10, blob: media.src.startsWith('blob:') });
      if (media.readyState >= 1) done(); else { media.addEventListener('loadedmetadata', done, { once: true }); media.addEventListener('error', () => resolve({ error: media.error?.code }), { once: true }); }
    }));
    assert.deepEqual(loaded, tag === 'video' ? { ready: true, width: 16, duration: 1, blob: true } : { ready: true, width: 0, duration: loaded.duration, blob: true }, name);
    if (tag === 'audio') assert.ok(loaded.duration >= 0.4 && loaded.duration <= 0.7, `${name} duration ${loaded.duration}`);
    assert.equal(await drawer.getAttribute('data-artifact-kind'), tag);
    await pick('打开上级目录');
  }
  await pick('sample.docx');
  await drawer.getByText('离线文档正文').waitFor();
  await pick('打开上级目录');
  await pick('unknown.blob');
  await drawer.getByText('此格式暂不支持预览').waitFor();
  // Only the native picker is replaced. IPC, target read, write and atomic rename stay live.
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
  await pick('下载原文件');
  const downloadPath = path.join(profile, 'saved unknown.blob');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, downloadPath);
  await pick('下载原文件');
  await drawer.getByText('已保存').waitFor();
  assert.deepEqual(await readFile(downloadPath), bytes);
  await close();
  const attached = page.getByRole('button', { name: '放大 粘贴图片.gif', exact: true });
  await attached.scrollIntoViewIfNeeded();
  await attached.click();
  const enlarged = page.getByRole('dialog', { name: '图片预览 · 粘贴图片.gif' });
  const enlargedImage = enlarged.getByRole('img', { name: '粘贴图片.gif', exact: true });
  await enlargedImage.evaluate(async img => { await img.decode(); });
  assert.ok((await enlargedImage.boundingBox()).width > (await attached.boundingBox()).width);
  await enlarged.getByRole('button', { name: '原始尺寸' }).click();
  assert.equal((await enlargedImage.boundingBox()).width, 2);
  await app.evaluate(({ clipboard }) => {
    clipboard.write = async ([item]) => {
      const png = await item.getType('image/png');
      globalThis.copiedChatPng = Buffer.from(await png.arrayBuffer());
    };
  });
  await enlargedImage.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制图片' }).click();
  const copied = await app.evaluate(async ({ nativeImage }) => {
    for (let i = 0; i < 80 && !globalThis.copiedChatPng; i++) await new Promise(resolve => setTimeout(resolve, 50));
    const img = nativeImage.createFromBuffer(globalThis.copiedChatPng);
    return { size: img.getSize(), pixels: [...img.toBitmap()] };
  });
  assert.deepEqual(copied, { size: { width: 2, height: 1 }, pixels: [0,0,255,255,0,0,255,255] });
  await page.keyboard.press('Escape');
  await enlarged.waitFor({ state: 'detached' });
  await attached.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '下载原图' }).click();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(await readFile(downloadPath)).equals(image)) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await readFile(downloadPath), image);
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await drawer.locator('iframe').waitFor();
  // Check actual red page pixels in the native PDF surface, not the existence of an iframe or PDF toolbar.
  const rect = await drawer.locator('iframe').boundingBox();
  assert.ok(rect);
  let red = 0;
  for (let i = 0; i < 40 && red < 700; i++) {
    red = await app.evaluate(async ({ BrowserWindow }, rect) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
      const bitmap = image.toBitmap();
      let count = 0;
      for (let i = 0; i < bitmap.length; i += 16) if (bitmap[i + 2] > 230 && bitmap[i + 1] < 30 && bitmap[i] < 30) count++;
      return count;
    }, Object.fromEntries(Object.entries(rect).map(([k, n]) => [k, Math.floor(n)])));
    if (red < 700) await page.waitForTimeout(150);
  }
  assert.ok(red >= 700, 'Native PDF viewer rendered the red vector page');
  await page.screenshot({ path: path.join(results, 'desktop-pdf-preview.png') });
  await close();
  await rm(path.join(cwd, 'volatile.txt'));
  await page.getByRole('button', { name: 'volatile.txt', exact: true }).click();
  await drawer.getByText('无法打开此项').waitFor();
  await writeFile(path.join(cwd, 'volatile.txt'), 'now exists');
  await pick('重试');
  await drawer.getByText('now exists').waitFor();
  await close();
  await page.getByRole('button', { name: '浏览工作目录' }).click();
  await pick('paged');
  await drawer.getByRole('button', { name: '000', exact: true }).waitFor();
  assert.equal(await drawer.locator('.artifact-entry').count(), 250);
  await pick('加载更多');
  await drawer.getByRole('button', { name: '250', exact: true }).waitFor();
  assert.equal(await drawer.locator('.artifact-entry').count(), 251);
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  await verifyReplyCwd(page, row, appendRows, cwd);
  await verifyWrappedFileLinks(app, page, row, appendRows, cwd);
  await verifyFormulas(app, page, row, appendRows, cwd);
  await verifyLinesAndLargeFiles(app, page, row, appendRows, cwd);
  // Control response order after the filesystem round trips to make late responses deterministic.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('lectern:previewArtifact');
    ipcMain.handle('lectern:previewArtifact', async (_event, _id, path) => {
      const reply = { path, kind: 'text', name: path, text: 'response for ' + path, mime: 'text/plain', truncated: false, size: 3 };
      if (path !== 'volatile.txt') return reply;
      await new Promise(resolve => { globalThis.finishDelayedArtifact = resolve; });
      return reply;
    });
  });
  const delayed = page.getByRole('button', { name: 'volatile.txt', exact: true });
  await delayed.click();
  await drawer.getByText('正在读取…').waitFor();
  await edit.getByRole('button', { name: 'preview files/demo.ts' }).click();
  await drawer.getByText('response for preview files/demo.ts').waitFor();
  await app.evaluate(() => globalThis.finishDelayedArtifact());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.doesNotMatch(await drawer.innerText(), /response for volatile/);
  await delayed.click();
  await drawer.getByText('正在读取…').waitFor();
  await page.locator('.session-row.active').click();
  await drawer.waitFor({ state: 'detached' });
  await app.evaluate(() => globalThis.finishDelayedArtifact());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await drawer.count(), 0);
  await verifyToolGroups(page, row, appendRows);
  await verifyCachedLinks(app, page, workspace, path.dirname(session.path));
  assert.deepEqual(remoteRequests, [], 'Transcript and Markdown links never fetch external resources');
  assert.deepEqual(browserErrors, []);
  console.log('PASS: offline Electron replies resolved from their records\' working directories, cached file links, mixed tool and peer groups, delivery order, recorded line counts, collapsed Edit diffs, delayed results, persisted reply detail and reset, Markdown navigation, directory pagination, GIF, PDF pixels, embedded attachment and binary save.');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
