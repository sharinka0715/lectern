import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const root = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "lectern-desk-")),
);
const profile = path.join(root, "profile"),
  config = path.join(root, "claude");
const output = path.resolve("test-results", "workbench-" + Date.now());
await mkdir(output, { recursive: true });
await mkdir(profile);
const env = {
  ...process.env, LECTERN_LOCALE: 'zh-CN',
  LECTERN_USER_DATA: profile,
  TMUX_TMPDIR: root,
  CLAUDE_CONFIG_DIR: config,
  LECTERN_DIAGNOSTIC_CONTENT: "0",
  LECTERN_LOG_DIR: path.join(root, "logs"),
};
delete env.TMUX;
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
const ids = [randomUUID(), randomUUID(), randomUUID()];
const workspaces = [];
for (const [i, name] of ["设计稿", "开发笔记"].entries()) {
  const cwd = path.join(root, "work" + i);
  const ws = { id: "work" + i, name, kind: "local", cwd, claudeDir: config };
  workspaces.push(ws);
  const project = path.join(
    config,
    "projects",
    cwd.replace(/[^a-z0-9-]/gi, "-"),
  );
  await mkdir(cwd);
  await mkdir(project, { recursive: true });
  for (const index of i === 0 ? [0, 1] : [2]) {
    const sid = ids[index],
      ts = new Date().toISOString(),
      uuid = randomUUID(), toolCall = randomUUID(), toolResult = randomUUID();
    const records = [
      {
        type: "user",
        uuid,
        sessionId: sid,
        cwd,
        timestamp: ts,
        message: { role: "user", content: "测试项目 " + index },
      },
      {
        type: "assistant", uuid: toolCall, parentUuid: uuid, sessionId: sid, cwd, timestamp: ts,
        message: { id: randomUUID(), role: "assistant", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } }] },
      },
      {
        type: "user", uuid: toolResult, parentUuid: toolCall, sessionId: sid, cwd, timestamp: ts,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "项目说明" }] },
      },
      {
        type: "assistant",
        uuid: randomUUID(),
        parentUuid: toolResult,
        sessionId: sid,
        cwd,
        timestamp: ts,
        message: {
          id: randomUUID(),
          role: "assistant",
          content: [{ type: "text", text: "独立历史回复 " + index }],
          stop_reason: "end_turn",
        },
      },
    ];
    await writeFile(
      path.join(project, sid + ".jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }
}
await writeFile(
  path.join(profile, "workspaces.json"),
  JSON.stringify(workspaces),
);
let app, page;
const errors = [],
  results = {};
const pane = (view) => page.locator('.desk-pane[data-view="' + view + '"]');
const row = (i) =>
  page.locator('.session-row[data-session-id="' + ids[i] + '"]');
async function launch() {
  const exe = process.argv[2];
  app = await _electron.launch({
    env,
    args: exe ? [] : ["."],
    ...(exe && { executablePath: path.resolve(exe) }),
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(11000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 920),
  );
  await page.locator(".sidebar-tree .workspace-row").first().waitFor();
}
async function expectText(view, i) {
  await pane(view)
    .getByText("独立历史回复 " + i, { exact: true })
    .waitFor();
}
const defaultLayout = { chat: 130, composer: 135, tool: 13, width: 1000 };
const customLayout = { chat: 120, composer: 190, tool: 18, width: 800 };
async function checkChatLayout(view, expected) {
  const measured = await pane(view).evaluate(el => {
    const element = selector => el.querySelector(selector);
    const width = selector => element(selector).getBoundingClientRect().width;
    const style = selector => getComputedStyle(element(selector));
    const linePercent = selector => Math.round(100 * parseFloat(style(selector).lineHeight) / parseFloat(style(selector).fontSize));
    const scroll = element('.conversation-scroll');
    return {
      user: linePercent('.user-text'), chat: linePercent('.message-content .markdown'),
      composer: linePercent('.composer textarea'), tool: parseFloat(style('.tool-block summary').fontSize),
      width: width('.conversation'), formWidth: width('.composer'), available: scroll.clientWidth,
      overflow: scroll.scrollWidth - scroll.clientWidth,
    };
  });
  assert.deepEqual([measured.user, measured.chat, measured.composer, measured.tool],
    [expected.chat, expected.chat, expected.composer, expected.tool]);
  assert.equal(measured.overflow, 0, `${view} transcript exceeds its viewport`);
  assert.ok(measured.width <= expected.width && measured.width < measured.available);
  assert.ok(Math.abs(measured.formWidth - measured.width) <= 8, 'The transcript and composer columns align');
  if (measured.available >= expected.width + 72) assert.equal(measured.width, expected.width);
  return measured.width;
}
// Drag a sidebar conversation over the workspace; `inspect` reads the drop zones
// before releasing on `edge` (or anywhere, when no zone is offered).
async function dragChat(i, edge, inspect) {
  const src = await row(i).boundingBox(),
    dest = await page.locator(".split-workspace").first().boundingBox();
  const x = src.x + Math.min(src.width * 0.4, 60),
    y = src.y + src.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + 12, y + 1, { steps: 4 });
    await page.mouse.move(
      dest.x + dest.width * 0.55,
      dest.y + dest.height * 0.45,
      { steps: 12 },
    );
    await page.mouse.move(
      dest.x + dest.width * 0.56,
      dest.y + dest.height * 0.45,
    );
    if (!edge) {
      await page.locator(".split-drop-hint").waitFor();
      if (inspect) await inspect();
      return;
    }
    const zone = page.locator(".split-drop." + edge);
    await zone.waitFor();
    if (inspect) await inspect();
    const box = await zone.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      steps: 8,
    });
    await page.mouse.move(box.x + box.width * 0.51, box.y + box.height * 0.5);
  } finally {
    await page.mouse.up();
  }
}
try {
  await launch();
  await row(0).click();
  await expectText("primary", 0);
  // One conversation on screen: dragging it cannot split off a copy of itself.
  await dragChat(0, null, async () => {
    assert.equal(await page.locator(".split-drop").count(), 0);
    assert.match(await page.locator(".split-drop-hint").innerText(), /已经在显示/);
    await page.screenshot({ path: path.join(output, "drop-itself.png") });
  });
  await page.locator(".split-drop-hint").waitFor({ state: "detached" });
  assert.equal(await pane("secondary").count(), 0, "still one pane");
  await dragChat(1, "right");
  await expectText("primary", 0);
  await expectText("secondary", 1);
  // Two conversations: one of them on its own side changes nothing, on the other side merges back to it alone.
  const zones = async () => page.locator(".split-drop").evaluateAll(els => els.map(el => [el.dataset.dropPlan, el.textContent]));
  await dragChat(1, "right", async () => assert.deepEqual(await zones(), [["merge", "合并为单屏"], ["none", "已在右侧"]]));
  await expectText("primary", 0);
  await expectText("secondary", 1);
  await dragChat(0, "right", async () => {
    assert.deepEqual(await zones(), [["none", "已在左侧"], ["merge", "合并为单屏"]]);
    await page.screenshot({ path: path.join(output, "drop-merge.png") });
  });
  await pane("secondary").waitFor({ state: "detached" });
  await expectText("primary", 0);
  results.dragMerge = true;
  await dragChat(1, "right");
  await expectText("primary", 0);
  await expectText("secondary", 1);
  // Clicking a conversation the other pane shows moves the focus there instead of opening a copy.
  const activePane = () => page.locator('.desk-pane[data-active="true"]').getAttribute("data-view");
  assert.equal(await activePane(), "secondary");
  await row(0).click();
  await page.waitForFunction(() => document.querySelector('.desk-pane[data-view="primary"]')?.dataset.active === "true");
  await expectText("secondary", 1);
  await row(1).click();
  await page.waitForFunction(() => document.querySelector('.desk-pane[data-view="secondary"]')?.dataset.active === "true");
  await expectText("primary", 0);
  results.dragSplit = true;
  const handle = page.getByRole("separator", { name: "调整分屏比例" });
  const before = await handle.boundingBox();
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(before.x + 85, before.y + before.height / 2, {
    steps: 7,
  });
  await page.mouse.up();
  const ratio = +(await handle.getAttribute("aria-valuenow"));
  assert.ok(ratio > 53);
  results.dragRatio = ratio;
  await pane("secondary").getByRole("button", { name: "切换分屏方向" }).click();
  assert.equal(await handle.getAttribute("aria-orientation"), "horizontal");
  await pane("secondary").getByRole("button", { name: "切换分屏方向" }).click();
  await page
    .getByRole("button", { name: "展开 开发笔记", exact: true })
    .click();
  await row(2).click();
  await expectText("secondary", 2);
  await expectText("primary", 0);
  await page.getByLabel("筛选项目和对话").fill("设计稿");
  assert.equal(await page.locator(".workspace-row").count(), 1);
  await page.getByLabel("筛选项目和对话").fill("");
  await page.getByRole("button", { name: "界面与连接设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  // Every tab keeps the same, larger window; long tabs scroll inside the section.
  const tabSizes = [];
  for (const tab of ["外观", "聊天排版", "文件预览", "聊天记录", "会话", "项目目录", "SSH 连接", "回收站", "外观"]) {
    await settings.getByRole("button", { name: tab, exact: true }).click();
    tabSizes.push(await settings.evaluate(el => {
      const box = el.getBoundingClientRect(), section = el.querySelector(".pref-section");
      return { width: Math.round(box.width), height: Math.round(box.height), viewport: innerHeight,
        scrolls: getComputedStyle(section).overflowY === "auto" && section.getBoundingClientRect().bottom <= box.bottom + 1 };
    }));
  }
  assert.equal(new Set(tabSizes.map(size => `${size.width}x${size.height}`)).size, 1, JSON.stringify(tabSizes));
  assert.ok(tabSizes.every(size => size.scrolls), "the section scrolls within the dialog");
  assert.ok(tabSizes[0].width >= 900 && tabSizes[0].height >= Math.min(700, tabSizes[0].viewport - 60), JSON.stringify(tabSizes[0]));
  await settings.getByLabel("界面主题").selectOption("dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await settings.getByLabel("界面字号").focus();
  await page.keyboard.press("ArrowRight");
  await settings.getByLabel("输入框最大高度").focus();
  await page.keyboard.press("ArrowRight");
  await settings.getByRole("button", { name: "聊天排版" }).click();
  await checkChatLayout("primary", defaultLayout);
  const preview = settings.locator(".pref-preview-column");
  const initialPreviewWidth = (await preview.boundingBox()).width;
  await settings.getByRole("slider", { name: "对话行高" }).press("Home");
  await checkChatLayout("secondary", { ...defaultLayout, chat: 120 });
  await settings.getByRole("slider", { name: "输入框行高" }).press("End");
  await settings.getByRole("slider", { name: "工具提示字号" }).press("End");
  await settings.getByRole("slider", { name: "对话正文宽度" }).press("Home");
  assert.ok((await preview.boundingBox()).width < initialPreviewWidth);
  assert.equal(await preview.locator("summary").evaluate(el => getComputedStyle(el).fontSize), "18px");
  await checkChatLayout("primary", customLayout);
  await checkChatLayout("secondary", customLayout);
  await settings.getByRole("button", { name: "SSH 连接", exact: true }).click();
  await settings.getByRole("button", { name: "添加 SSH 连接" }).click();
  await settings.getByLabel("连接名称").fill("开发主机");
  await settings.getByLabel("SSH 主机", { exact: true }).fill("dev-lab");
  await settings.getByLabel("端口").fill("2222");
  await settings.getByRole("button", { name: "保存连接" }).click();
  await settings.getByRole("button", { name: "项目目录", exact: true }).click();
  assert.ok(await settings.getByRole("heading", { name: "本地", exact: true }).isVisible());
  await settings.getByRole("button", { name: "上移 开发笔记" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();
  assert.equal(
    await page
      .locator(".workspace-row")
      .first()
      .getAttribute("data-workspace-id"),
    "work1",
  );
  const machine = page.locator('.machine-section[aria-label="开发主机"]');
  await machine.getByText("尚未添加项目文件夹").waitFor();
  assert.equal(await machine.locator(".workspace-row").count(), 0);
  // A folder is added on that machine: the dialog is bound to it.
  await machine.getByRole("button", { name: "在 开发主机 添加项目文件夹", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加项目文件夹" });
  assert.equal(await dialog.locator(".machine-endpoint").innerText(), "开发主机");
  assert.equal(await dialog.getByLabel("SSH 主机").count(), 0, "host and port come from the machine");
  await page.keyboard.press("Escape");
  results.profileReused = true;
  await page.screenshot({ path: path.join(output, "split-dark.png") });
  await app.close();
  app = undefined;
  await launch();
  await expectText("primary", 0);
  await expectText("secondary", 2);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(
    Math.round(
      await page
        .locator("html")
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ),
    19,
  );
  assert.equal(
    await page
      .locator(".workspace-row")
      .first()
      .getAttribute("data-workspace-id"),
    "work1",
  );
  assert.equal(
    +(await page
      .getByRole("separator", { name: "调整分屏比例" })
      .getAttribute("aria-valuenow")),
    ratio,
  );
  await checkChatLayout("primary", customLayout);
  // 保持横向分屏，并让右侧实际更窄；再缩小会自动改成上下分屏。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1160, 740));
  await page.waitForFunction(() => window.innerWidth === 1160 && document.querySelector('.split-workspace')?.dataset.direction === 'columns');
  assert.ok(await checkChatLayout("secondary", customLayout) < customLayout.width, 'The narrow split must fit within its pane');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 920));
  await pane("secondary").getByRole("button", { name: "关闭此分屏" }).click();
  await expectText("primary", 0);
  assert.equal(await pane("secondary").count(), 0);
  results.restored = true;
  // A saved font size is restored; missing layout fields take their defaults
  // and invalid ones are bounded field by field.
  for (const saved of [16, 15]) {
    await page.evaluate(
      ({ saved }) => {
        const key = "lectern.desktop.preferences.v1";
        const prefs = JSON.parse(localStorage.getItem(key));
        prefs.fontSize = saved;
        if (saved === 16) {
          for (const field of ['chatLineHeight', 'composerLineHeight', 'toolSummaryFontSize', 'conversationWidth']) delete prefs[field];
        } else {
          Object.assign(prefs, { chatLineHeight: '160', composerLineHeight: 151, toolSummaryFontSize: 40, conversationWidth: -1 });
        }
        localStorage.setItem(key, JSON.stringify(prefs));
      },
      { saved },
    );
    await page.reload();
    await expectText("primary", 0);
    assert.equal(
      await page
        .locator("html")
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      saved,
    );
    await checkChatLayout('primary', saved === 16 ? defaultLayout :
      { chat: 130, composer: 150, tool: 18, width: 800 });
  }
  await page.getByRole("button", { name: "界面与连接设置" }).click();
  const layoutSettings = page.getByRole("dialog", { name: "设置", exact: true });
  await layoutSettings.getByRole("button", { name: "聊天排版" }).click();
  await layoutSettings.getByRole("button", { name: "恢复默认排版" }).click();
  await layoutSettings.getByRole("button", { name: "关闭设置" }).click();
  await page.reload();
  await expectText("primary", 0);
  await checkChatLayout("primary", defaultLayout);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  results.chatLayout = true;
  results.fontPreferences = true;
  assert.deepEqual(errors, []);
  results.success = true;
} catch (e) {
  results.success = false;
  results.error = String(e.stack || e);
  await page
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await app?.close();
  await rm(root, { force: true, recursive: true });
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify({ output, ...results }));
}
