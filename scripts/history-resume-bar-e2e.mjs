// Real desktop window, native-format archives and the bundled offline tmux fixture.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { waitUntil } from "./fixtures/loopback-ssh.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "./fixtures/electron.mjs";
import { refreshFolderUntil } from "./fixtures/sidebar-refresh.mjs";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "tbr-")));
const output = path.resolve("test-results", "history-resume-bar-" + Date.now());
await mkdir(output, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', TMPDIR: root, TMUX_TMPDIR: root,
  LECTERN_USER_DATA: path.join(root, "profile"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: path.join(output, "diagnostics"),
  LECTERN_DIAGNOSTIC_CONTENT: "0" };
delete env.TMUX;
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
let app, page;
const report = {};

async function seedArchive() {
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  assert.ok(workspace.claudeDir.startsWith(root + path.sep) && workspace.cwd.startsWith(root + path.sep));
  const project = path.join(workspace.claudeDir, "projects", workspace.cwd.replace(/[^a-z0-9-]/gi, "-"));
  const sessionId = randomUUID(), lines = [];
  let parentUuid = null;
  for (let i = 0; i < 48; i++) {
    for (const role of ["user", "assistant"]) {
      const uuid = randomUUID(), text = role + " " + i;
      const message = role === "user" ? { role, content: text }
        : { role, id: uuid, content: [{ type: "text", text }], stop_reason: "end_turn" };
      lines.push(JSON.stringify({ type: role, uuid, parentUuid, sessionId, cwd: workspace.cwd,
        timestamp: new Date(1700000000000 + lines.length * 1000).toISOString(), message }));
      parentUuid = uuid;
    }
  }
  await writeFile(path.join(project, sessionId + ".jsonl"), lines.join("\n") + "\n", { flag: "wx" });
  return sessionId;
}

// 有缓存的目录静默刷新。用隔离环境的 IPC 完成事件计数，同时在页面内连续观测布局。
async function discoveryCount() {
  const dir = env.LECTERN_LOG_DIR;
  const names = (await readdir(dir)).filter(name => /^events\.\d+\.jsonl$/.test(name));
  const logs = await Promise.all(names.map(name => readFile(path.join(dir, name), 'utf8')));
  return logs.reduce((count, log) => count + log.split('\n').slice(0, -1)
    .filter(line => line.includes('"ipc.discover.complete"') && JSON.parse(line).event === 'ipc.discover.complete').length, 0);
}

async function observeRefreshes(cycles, expectBanner) {
  const probe = await page.evaluateHandle(expectBanner => {
    const viewport = document.querySelector(".conversation-scroll");
    const anchor = [...viewport.querySelectorAll(".message")].find(el =>
      el.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
    const top = anchor.getBoundingClientRect().top;
    // The visible conversation ends at the input area floating over its bottom.
    const dock = document.querySelector(".composer-area");
    const shown = () => dock.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const height = shown();
    const start = performance.now();
    const observed = { bannerChanges: [], maxHeightChangePx: 0, maxMessageShiftPx: 0 };
    let visible = expectBanner;
    function sample() {
      const nowVisible = !!document.querySelector(".resume-bar")?.getBoundingClientRect().height;
      if (visible !== nowVisible) {
        observed.bannerChanges.push({ ms: Math.round(performance.now() - start), visible: nowVisible });
        visible = nowVisible;
      }
      observed.maxHeightChangePx = Math.max(observed.maxHeightChangePx, Math.abs(shown() - height));
      observed.maxMessageShiftPx = Math.max(observed.maxMessageShiftPx, Math.abs(anchor.getBoundingClientRect().top - top));
    }
    const mutations = new MutationObserver(sample), resize = new ResizeObserver(sample);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
    resize.observe(viewport);
    resize.observe(dock);
    sample();
    return { finish: () => { sample(); mutations.disconnect(); resize.disconnect(); return observed; } };
  }, expectBanner);
  try {
    await page.evaluate(() => window.desktop.markDiagnosticIncident('开始观测续接栏刷新'));
    const baseline = await discoveryCount();
    const completeRefreshes = await waitUntil(async () => {
      const delta = await discoveryCount() - baseline;
      return delta >= cycles && delta;
    }, '未观察到预期次数的目录刷新', (cycles + 2) * 6000);
    return { ...await probe.evaluate(m => m.finish()), completeRefreshes };
  } finally { await probe.dispose(); }
}

// The transcript while 关闭对话 runs: a new scroll container, an empty pane or a lost
// anchor message is a problem; how far that message and the input area moved.
function observeClose() {
  return page.evaluateHandle(() => {
    const viewport = document.querySelector(".conversation-scroll"), dock = document.querySelector(".composer-area");
    const anchor = [...viewport.querySelectorAll(".message")].find(el =>
      el.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
    const top = anchor.getBoundingClientRect().top, dockTop = dock.getBoundingClientRect().top;
    const problems = new Set(), observed = { maxMessageShiftPx: 0, maxDockMovePx: 0 };
    function sample() {
      const shown = document.querySelector(".conversation-scroll");
      if (shown !== viewport) problems.add("remounted");
      if (!shown?.querySelector(".message-assistant")) problems.add("empty");
      if (!anchor.isConnected) problems.add("anchor message replaced");
      else observed.maxMessageShiftPx = Math.max(observed.maxMessageShiftPx, Math.abs(anchor.getBoundingClientRect().top - top));
      observed.maxDockMovePx = Math.max(observed.maxDockMovePx, Math.abs(dock.getBoundingClientRect().top - dockTop));
    }
    const mutations = new MutationObserver(sample), resize = new ResizeObserver(sample);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
    resize.observe(viewport);
    resize.observe(dock);
    viewport.addEventListener("scroll", sample);
    sample();
    return { finish: () => {
      sample(); mutations.disconnect(); resize.disconnect(); viewport.removeEventListener("scroll", sample);
      return { ...observed, problems: [...problems] };
    } };
  });
}

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? ["--demo"] : [".", "--demo"], env,
    ...(executable && { executablePath: path.resolve(executable) }) });
  report.app = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged }));
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 840));
  const resume = page.getByRole("button", { name: "续接会话", exact: true });
  const input = page.getByRole("textbox", { name: "发送给 Claude 的消息" });
  const row = id => page.locator('.session-row[data-session-id="' + id + '"]');
  // A 400 px wheel moved the transcript up and it has come to rest. Not exactly 400: while the
  // input area still eases to its new height (slower machines), the transcript keeps its bottom
  // line in place and moves the scroll position with it.
  const wheeledUp = top => page.waitForFunction(top => {
    const now = document.querySelector(".conversation-scroll").scrollTop, last = window.__lastScrollTop;
    window.__lastScrollTop = now;
    return top - now >= 300 && last === now;
  }, top, { polling: 150 });
  const liveId =await page.locator('.session-row.active[data-session-live="true"]').getAttribute("data-session-id");
  const archiveId = await seedArchive();
  await refreshFolderUntil(page, "demo-local", row(archiveId));
  await row(archiveId).click();
  await page.getByText("assistant 47", { exact: true }).waitFor();
  await resume.waitFor();
  assert.ok(await input.isDisabled());
  await page.waitForFunction(() => {
    const v = document.querySelector(".conversation-scroll");
    return v.scrollHeight - v.scrollTop - v.clientHeight <= 2 && v.scrollTop > v.clientHeight;
  });
  report.atLatest = await observeRefreshes(2, true);

  const viewport = page.locator(".conversation-scroll");
  const beforeWheel = await viewport.evaluate(el => el.scrollTop);
  await viewport.hover();
  await page.mouse.wheel(0, -400);
  // Composited wheel scrolling can finish after the jump-to-latest button appears.
  await wheeledUp(beforeWheel);
  await page.getByRole("button", { name: "滚动到最新消息" }).waitFor();
  report.readingEarlier = await observeRefreshes(2, true);

  await row(liveId).click();
  await page.waitForFunction(() => document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]') === false);
  await resume.waitFor({ state: "hidden" });
  report.live = await observeRefreshes(1, false);
  await row(archiveId).click();
  await resume.click();
  await page.waitForFunction(() => document.querySelector('.session-row.active')?.dataset.sessionLive === "true" &&
    document.querySelector('textarea')?.matches(':disabled, [aria-disabled="true"]') === false);
  await resume.waitFor({ state: "hidden" });
  // Closing while reading earlier messages, on a slow machine: the transcript stays
  // mounted, never empty, and in place (only the input area changes below it).
  const beforeCloseWheel = await viewport.evaluate(el => el.scrollTop);
  await viewport.hover();
  await page.mouse.wheel(0, -400);
  await wheeledUp(beforeCloseWheel);
  await page.getByRole("button", { name: "滚动到最新消息" }).waitFor();
  const closeProbe = await observeClose();
  await app.evaluate(() => { process.env.LECTERN_DEMO_LATENCY_MS = "300"; });
  try {
    await page.getByRole("button", { name: "关闭当前对话", exact: true }).click();
    await page.locator("dialog.confirm-action[open]").getByRole("button", { name: "关闭对话", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".resume-bar button")].some(b => b.textContent.includes("续接会话") && !b.disabled),
      null, { timeout: 40000 });
  } finally { await app.evaluate(() => { delete process.env.LECTERN_DEMO_LATENCY_MS; }); }
  report.closedReadingEarlier = await closeProbe.evaluate(probe => probe.finish());
  await closeProbe.dispose();
  const closed = report.closedReadingEarlier;
  assert.deepEqual(closed.problems, [], "Closing blanked or remounted the transcript");
  assert.ok(closed.maxMessageShiftPx <= closed.maxDockMovePx + 1, "Visible message moved more than the input area did while closing");
  assert.equal(await row(archiveId).getAttribute("data-session-live"), "false");
  assert.ok(await input.isDisabled());
  assert.ok(await page.getByRole("button", { name: "滚动到最新消息" }).isVisible(), "closing keeps the reading position");
  report.resumedAndClosed = true;
  assert.deepEqual(errors, []);
  for (const phase of [report.atLatest, report.readingEarlier, report.live]) {
    assert.deepEqual(phase.bannerChanges, [], "Resume bar changed during background refresh");
    assert.ok(phase.maxHeightChangePx <= 1, "Transcript viewport changed height during refresh");
    assert.ok(phase.maxMessageShiftPx <= 1, "Visible message moved during refresh");
  }
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = String(error.stack ?? error);
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, output }));
}
