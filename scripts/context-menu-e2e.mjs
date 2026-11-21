// node scripts/context-menu-e2e.mjs [packaged-executable]
// Right-click menus in the demo workspace (mock Claude, private tmux). No model request.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'lectern-menu-'));
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'logs'), LECTERN_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app;
try {
  const executablePath = process.argv[2];
  app = await _electron.launch({ args: executablePath ? ['--demo'] : ['.', '--demo'], ...(executablePath && { executablePath: path.resolve(executablePath) }), env, timeout: 60000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const menu = page.locator('.context-menu:popover-open');
  const items = () => menu.getByRole('menuitem').evaluateAll(nodes => nodes.map(node => `${node.textContent}${node.disabled ? ' [disabled]' : ''}`));
  const choose = async label => { await menu.getByRole('menuitem', { name: label, exact: false }).first().click(); await menu.waitFor({ state: 'detached' }).catch(() => menu.waitFor({ state: 'hidden' })); };
  await page.locator('.message-assistant').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.getAttribute('data-status') === 'idle');

  // Conversation: copy, plain text and quoting into the composer.
  await page.locator('.message-assistant .message-content').first().click({ button: 'right' });
  assert.deepEqual((await items()).filter(label => label.startsWith('复制') || label.startsWith('引用')), ['复制全文（Markdown）', '复制纯文本', '引用到输入框']);
  await choose('复制全文');
  const reply = await clipboard();
  assert.ok(reply.trim().length > 0, 'the reply was copied');
  await page.locator('.context-toast').getByText('已复制').waitFor();
  await page.locator('.message-assistant .message-content').first().click({ button: 'right' });
  await page.keyboard.press('ArrowDown');
  assert.equal(await menu.evaluate(node => node.contains(document.activeElement) && document.activeElement.textContent), '复制纯文本', 'arrow keys move through the menu');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await page.locator('.message-assistant .message-content').first().click({ button: 'right' });
  await choose('引用到输入框');
  const draft = await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).inputValue();
  assert.match(draft, /^> /, 'quoted into the composer');
  await page.getByRole('textbox', { name: '发送给 Claude 的消息' }).fill('');

  // Sidebar: conversation, folder and machine rows.
  const row = page.locator('.session-row.active');
  const sessionId = await row.getAttribute('data-session-id');
  await row.click({ button: 'right' });
  const sessionItems = await items();
  for (const label of ['打开', '在旁边分屏打开', '重命名…F2', '复制会话 ID', '复制续接命令', '归档对话运行中 [disabled]']) assert.ok(sessionItems.includes(label), `${label} in ${sessionItems}`);
  await choose('复制会话 ID');
  assert.equal(await clipboard(), sessionId);
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  await page.locator('.workspace-row').first().click({ button: 'right' });
  const folderItems = await items();
  assert.ok(folderItems.includes('重命名… [disabled]') && folderItems.includes('从侧栏移除… [disabled]'), 'the demo folder cannot be changed');
  await choose('复制路径');
  assert.equal(await clipboard(), workspace.cwd);
  await page.locator('.machine-heading').first().click({ button: 'right' });
  assert.deepEqual(await items(), ['添加项目文件夹 [disabled]', '发现本机会话 [disabled]']);
  await page.keyboard.press('Escape');

  // File preview: directory entries and the panel itself.
  await writeFile(path.join(workspace.cwd, 'menu-note.txt'), 'right-click fixture\n');
  await page.getByRole('button', { name: '浏览工作目录' }).click();
  const entry = page.locator('.artifact-entry').first();
  await entry.waitFor();
  const entryPath = await entry.getAttribute('data-entry-path');
  await entry.click({ button: 'right' });
  assert.ok((await items()).includes('复制路径'));
  await choose('复制路径');
  assert.equal(await clipboard(), entryPath);
  await page.locator('.artifact-heading h2').click({ button: 'right' });
  const panelItems = await items();
  for (const label of ['复制路径', '复制名称', '重新读取', '关闭预览']) assert.ok(panelItems.includes(label), `${label} in ${panelItems}`);
  await choose('关闭预览');
  await page.locator('.artifact-drawer').waitFor({ state: 'detached' });

  // Right-clicking empty space shows nothing. A real right-click on macOS
  // also selects the word under the pointer and opens the native Copy menu,
  // whose modal tracking would then hold up quitting; dispatch the event
  // so only Lectern's own handling is exercised here.
  await page.locator('.topbar-title').dispatchEvent('contextmenu', { button: 2 });
  assert.equal(await menu.count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, copiedReplyChars: reply.length, sessionItems, folderItems }));
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
