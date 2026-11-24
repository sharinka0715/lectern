// Run after npm run build. Pass a packaged executable as the optional first argument.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, resizeWindow } from './fixtures/electron.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-titlebar-')));
const profile = path.join(root, 'profile');
const output = path.resolve('test-results', 'titlebar-' + Date.now());
const env = {
  ...process.env, LECTERN_LOCALE: 'zh-CN',
  LECTERN_USER_DATA: profile,
  TMUX_TMPDIR: root,
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  LECTERN_DIAGNOSTIC_CONTENT: '0',
  LECTERN_LOG_DIR: path.join(root, 'logs'),
};
delete env.TMUX;
delete env.LECTERN_DEV_URL;
delete env.ELECTRON_RUN_AS_NODE;

const projects = [
  { name: '设计项目', reply: '设计对话的历史回复' },
  { name: '开发项目', reply: '开发对话的历史回复' },
  { name: '长名称工作目录 · 跨项目协作和分屏会话的标题栏导航验证', reply: '分屏对话的历史回复' },
  { name: '空白项目' },
];
const newProject = { name: '从分屏添加的目录', reply: '新目录里的历史回复' };
let app, page;
const errors = [];
const pane = view => page.locator('.desk-pane[data-view="' + view + '"]');
const titlebar = () => page.locator('.window-titlebar');
const button = (parent, name) => parent.getByRole('button', { name, exact: true });
const switcher = () => button(titlebar(), '切换工作目录');

async function prepareProjects() {
  await Promise.all([profile, output].map(dir => mkdir(dir, { recursive: true })));
  const workspaces = [];
  for (const [index, project] of [...projects, newProject].entries()) {
    const id = 'project-' + index;
    const cwd = path.posix.join(root, id);
    const claudeDir = path.posix.join(root, 'claude');
    const dir = path.join(env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
    await Promise.all([path.join(root, id), dir].map(value => mkdir(value, { recursive: true })));
    workspaces.push({ id, name: project.name, kind: 'local', cwd, claudeDir });
    if (!project.reply) continue;
    const sessionId = randomUUID(), uuid = randomUUID(), timestamp = new Date().toISOString();
    const records = [
      { type: 'user', uuid, sessionId, cwd, timestamp, message: { role: 'user', content: '检查' + project.name } },
      { type: 'assistant', uuid: randomUUID(), parentUuid: uuid, sessionId, cwd, timestamp,
        message: { role: 'assistant', id: randomUUID(), content: [{ type: 'text', text: project.reply }], stop_reason: 'end_turn' } },
    ];
    await writeFile(path.join(dir, sessionId + '.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  const toAdd = workspaces.pop();
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify(workspaces));
  return toAdd;
}

async function activeProject(view, project) {
  await pane(view).getByText(project.reply, { exact: true }).waitFor();
  await switcher().getByText(project.name, { exact: true }).waitFor();
  assert.equal(await pane(view).getAttribute('data-active'), 'true');
}

async function chooseProject(project) {
  await switcher().click();
  const menu = page.getByRole('menu', { name: '工作目录' });
  await menu.getByRole('menuitemradio', { name: project.name, exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
}

async function checkLayout() {
  assert.equal(await titlebar().count(), 1, 'The entire window shares one title bar');
  const metrics = await titlebar().evaluate(bar => {
    const bounds = el => el.getBoundingClientRect().toJSON();
    function region(el) {
      for (; el; el = el.parentElement) {
        const value = getComputedStyle(el).getPropertyValue('-webkit-app-region');
        if (value === 'drag' || value === 'no-drag') return value;
      }
      return 'none';
    }
    const surface = bounds(bar);
    const controls = [...bar.querySelectorAll('button')].filter(el => el.getClientRects().length)
      .map(el => ({ label: el.getAttribute('aria-label') || el.textContent, region: region(el), box: bounds(el) }));
    const content = [...document.querySelectorAll('.sidebar, .main-area, .artifact-drawer, .activity-float')]
      .filter(el => el.getClientRects().length).map(el => ({ name: el.className, box: bounds(el) }));
    const overlay = navigator.windowControlsOverlay;
    const safe = overlay?.visible ? overlay.getTitlebarAreaRect().toJSON() : null;
    let dragRun = 0, longestDragRun = 0;
    for (let x = Math.ceil(safe?.left ?? 0); x < (safe?.right ?? innerWidth); x += 8) {
      const hit = document.elementFromPoint(x, surface.top + surface.height / 2);
      dragRun = hit && bar.contains(hit) && region(hit) === 'drag' ? dragRun + 8 : 0;
      longestDragRun = Math.max(longestDragRun, dragRun);
    }
    return { width: innerWidth, surface, controls, content, safe, longestDragRun };
  });
  const { width, surface, content, controls, safe } = metrics;
  assert.equal(surface.top, 0);
  assert.equal(surface.left, 0);
  assert.equal(surface.right, width, 'Title bar spans the window even with a drawer or second chat');
  assert.equal(surface.height, Math.max(44, safe?.height ?? 0));
  assert.ok(metrics.longestDragRun >= 80, 'A continuous part of the title bar must move the window');
  assert.ok(content.length > 0);
  for (const { name, box } of content) {
    assert.ok(box.top >= surface.bottom - 1, name + ' overlaps the title bar');
  }
  if (safe) {
    assert.ok(safe.width > 0 && safe.width < width, 'Native window controls reserve horizontal space');
    assert.ok(safe.bottom <= surface.bottom + 1, 'Native controls fit inside the title bar');
  } else if (process.platform !== 'darwin') {
    assert.fail('The native window controls overlay should be visible in a normal window');
  }
  const traffic = process.platform === 'darwin' && await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getWindowButtonPosition());
  for (const { label, box, region } of controls) {
    assert.equal(region, 'no-drag', label + ' must receive pointer input in the title bar');
    assert.ok(box.top >= 0 && box.bottom <= surface.bottom && box.width > 0, label + ' must be fully visible');
    assert.ok(box.left >= (safe?.left ?? 0) - 1 && box.right <= (safe?.right ?? width) + 1, label + ' overlaps the native controls');
    if (traffic) assert.ok(box.left >= traffic.x + 60, label + ' overlaps the macOS traffic lights');
  }
  return { width, height: surface.height, safe, longestDragRun: metrics.longestDragRun };
}

try {
  const toAdd = await prepareProjects();
  const executablePath = process.argv[2] && path.resolve(process.argv[2]);
  app = await _electron.launch({ args: executablePath ? [] : ['.'], executablePath, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  const [design, development, collaboration, empty] = projects;
  const back = button(titlebar(), '后退'), forward = button(titlebar(), '前进');
  await resizeWindow(app, page, 1280, 800);
  await activeProject('primary', design);
  const normal = await checkLayout();
  const projectX = (await switcher().boundingBox()).x;
  const resizer = page.getByRole('separator', { name: '调整侧栏宽度' });
  const sidebarWidth = (await page.locator('.sidebar').boundingBox()).width;
  await resizer.press('ArrowRight');
  const widerSidebar = (await page.locator('.sidebar').boundingBox()).width;
  assert.ok(widerSidebar > sidebarWidth);
  assert.equal((await switcher().boundingBox()).x - projectX, widerSidebar - sidebarWidth,
    'The project switcher follows the sidebar divider');
  await resizer.press('ArrowLeft');
  const projectMenu = page.getByRole('menu', { name: '工作目录' });
  await switcher().click();
  await projectMenu.waitFor();
  await switcher().click();
  await projectMenu.waitFor({ state: 'hidden' });
  await switcher().press('ArrowDown');
  await projectMenu.waitFor();
  await page.keyboard.press('Escape');
  await projectMenu.waitFor({ state: 'hidden' });
  await chooseProject(development);
  await activeProject('primary', development);
  await back.click();
  await activeProject('primary', design);
  await chooseProject(design);
  assert.ok(await back.isDisabled(), 'Selecting the current project preserves history');
  await forward.click();
  await activeProject('primary', development);
  assert.ok(await forward.isDisabled(), 'At the most recent chat, the forward button is disabled');

  await button(pane('primary'), '浏览工作目录').click();
  await page.locator('.artifact-drawer[data-artifact-kind="directory"]').waitFor();
  await checkLayout();
  await page.screenshot({ path: path.join(output, 'wide-file-drawer.png') });
  await button(page, '关闭文件预览').click();
  await button(pane('primary'), '查看会话活动').click();
  await page.locator('.activity-float').waitFor();
  // The machine is named beside the folder, as in the sidebar.
  assert.equal(await page.locator('.activity-float .activity-float-machine').innerText(), '本地');
  await checkLayout();
  await button(pane('primary'), '查看会话活动').click();
  await page.locator('.activity-float').waitFor({ state: 'detached' });

  await button(titlebar(), '收起侧栏').click();
  await page.locator('.sidebar').waitFor({ state: 'hidden' });
  await checkLayout();
  await button(titlebar(), '展开侧栏').click();
  await page.locator('.sidebar').waitFor();
  await button(pane('primary'), '并排打开对话').click();
  await pane('secondary').waitFor();
  await chooseProject(collaboration);
  await activeProject('secondary', collaboration);
  await pane('primary').getByText(development.reply, { exact: true }).click();
  await activeProject('primary', development);
  await pane('secondary').getByText(collaboration.reply, { exact: true }).click();
  await activeProject('secondary', collaboration);
  await page.locator('.session-row').filter({ hasText: '检查' + design.name }).click();
  await activeProject('secondary', design);
  await back.click();
  await activeProject('secondary', collaboration);
  await forward.click();
  await activeProject('secondary', design);
  await back.click();
  await activeProject('secondary', collaboration);
  await checkLayout();
  await page.screenshot({ path: path.join(output, 'split-projects.png') });
  // Each split pane has its own side panel, placed inside that pane.
  await button(pane('primary'), '浏览工作目录').click();
  await button(pane('secondary'), '查看会话活动').click();
  await pane('primary').locator('.artifact-drawer[data-artifact-kind="directory"]').waitFor();
  await pane('secondary').locator('.activity-float').waitFor();
  assert.equal(await page.locator('.artifact-drawer').count(), 1, 'The secondary pane keeps its own preview closed');
  assert.equal(await page.locator('.activity-float').count(), 1, 'The primary pane keeps its own activity closed');
  for (const [view, selector] of [['primary', '.artifact-drawer'], ['secondary', '.activity-float']]) {
    const [outer, inner] = await Promise.all([pane(view).boundingBox(), pane(view).locator(selector).boundingBox()]);
    assert.ok(inner.x >= outer.x - 1 && inner.x + inner.width <= outer.x + outer.width + 1, `${selector} stays within the ${view} pane`);
  }
  await checkLayout();
  await page.screenshot({ path: path.join(output, 'split-side-panels.png') });
  await button(pane('primary'), '关闭文件预览').click();
  // The activity card floats over its own chat; it folds from its own button.
  await button(pane('secondary'), '收起会话活动').click();
  await page.locator('.activity-float').waitFor({ state: 'detached' });

  await resizeWindow(app, page, 850, 600);
  await page.locator('.split-workspace.divided[data-direction="rows"]').waitFor();
  await activeProject('secondary', collaboration);
  await button(pane('secondary'), '浏览工作目录').click();
  await pane('secondary').locator('.artifact-drawer[data-artifact-kind="directory"]').waitFor();
  const minimum = await checkLayout();
  await page.screenshot({ path: path.join(output, 'minimum-split-drawer.png') });
  await button(pane('secondary'), '关闭文件预览').click();
  // Folders are added on a machine in the sidebar; the title bar's project menu only switches.
  await switcher().click();
  assert.equal(await projectMenu.getByRole('menuitem', { name: '添加工作目录…' }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '在 本地 添加项目文件夹', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加项目文件夹' });
  await dialog.getByLabel('名称', { exact: true }).fill(toAdd.name);
  const cwdInput = dialog.getByRole('textbox', {name:'工作目录', exact:true});
  await cwdInput.fill(path.posix.dirname(toAdd.cwd));
  await button(dialog, '选择文件夹').click();
  const picker = page.getByRole('dialog', {name:'选择工作目录', exact:true});
  await button(picker, path.posix.basename(toAdd.cwd)).click();
  await button(picker, '选择此目录').click();
  assert.equal(await cwdInput.inputValue(), toAdd.cwd);
  assert.equal(await dialog.getByLabel('名称', {exact:true}).inputValue(), toAdd.name);
  await dialog.getByText('高级选项', { exact: true }).click();
  await dialog.getByLabel('Claude 配置目录', { exact: true }).fill(toAdd.claudeDir);
  await button(dialog, '添加目录').click();
  await dialog.waitFor({ state: 'hidden' });
  // A new folder lists no saved conversations until asked.
  const folderToggle = page.locator('.sidebar').getByRole('button', { name: `展开 ${newProject.name}`, exact: true });
  if (await folderToggle.count()) await folderToggle.click();
  const added = page.getByRole('group', { name: `${newProject.name} 的会话`, exact: true });
  await added.getByText('尚未扫描此目录的对话', { exact: true }).waitFor();
  await button(added, '扫描所有对话').click();
  await activeProject('secondary', newProject);
  await pane('primary').getByText(development.reply, { exact: true }).waitFor();
  await button(pane('secondary'), '关闭此分屏').click();
  await activeProject('primary', development);
  await button(pane('primary'), '浏览工作目录').click();
  await page.locator('.artifact-drawer').waitFor();
  await checkLayout();
  await button(titlebar(), '收起侧栏').click();
  await page.locator('.sidebar').waitFor({ state: 'hidden' });
  await checkLayout();
  await button(titlebar(), '展开侧栏').click();
  await button(page, '关闭文件预览').click();
  await chooseProject(empty);
  await switcher().getByText(empty.name, { exact: true }).waitFor();
  // The card's title, not the same name among the folder switcher's options (shown once the draft settles).
  await pane('primary').locator('.welcome-workspace').getByText(empty.name, { exact: true }).and(page.locator('strong')).waitFor();
  await back.click();
  await activeProject('primary', development);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, platform: process.platform, normal, minimum, output }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error('Title bar test artifacts:', output);
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
