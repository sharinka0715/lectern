// Normal Electron + isolated, native-format JSONL. No account or Claude process required.
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, appendFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, resizeWindow } from "./fixtures/electron.mjs";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "lectern-history-pages-")));
const privateServer = createPrivateTmux(root);
const profile = path.join(root, "profile");
const config = path.join(root, "claude");
const cwd = path.join(root, "work");
const project = path.join(config, "projects", cwd.replace(/[^a-z0-9-]/gi, "-"));
const output = path.resolve("test-results", "history-pagination-" + Date.now());
const logs = path.join(output, "diagnostics");
const workspace = { id: "project", name: "历史分页", cwd, kind: "local" };
const env = { ...privateServer.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, CLAUDE_CONFIG_DIR: config,
  LECTERN_LOG_DIR: logs, LECTERN_DIAGNOSTIC_CONTENT: "0" };
delete env.LECTERN_DEV_URL;
delete env.ELECTRON_RUN_AS_NODE;
await Promise.all([profile, cwd, project, output].map(dir => mkdir(dir, { recursive: true })));
await writeFile(path.join(profile, "workspaces.json"), JSON.stringify([workspace]));

async function makeFixture(name, initialTurns, boundaryAt, metadataRows = 0, lastTurnToolCount = 0) {
  const sessionId = randomUUID(), file = path.join(project, sessionId + ".jsonl");
  const expected = [];
  let parentUuid = null, sequence = 0;
  function row(fields) {
    const result = { cwd, sessionId, uuid: randomUUID(), parentUuid,
      timestamp: new Date(Date.UTC(2026, 0, 1) + sequence++ * 1000).toISOString(), ...fields };
    parentUuid = result.uuid;
    return JSON.stringify(result) + "\n";
  }
  function turn(index) {
    const prompt = name + " 提问 " + index, answer = name + " 回复 " + index;
    expected.push(prompt, answer);
    let content = row({ type: "user", message: { role: "user", content: prompt } });
    if (index >= initialTurns - 2) for (let n = 0; n < lastTurnToolCount; n++) {
      const id = randomUUID();
      content += row({ type: "assistant", message: { id: randomUUID(), role: "assistant", stop_reason: "tool_use",
        content: [{ type: "tool_use", id, name: "Read", input: { file_path: `fixture-${n}` } }] } });
      content += row({ type: "user", message: { role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(160 * 1024) }] } });
    }
    return content + row({ type: "assistant", message: { id: randomUUID(), role: "assistant", stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "x".repeat(4200) }, { type: "text", text: answer }] } });
  }
  let content = "";
  for (let i = 0; i < initialTurns; i++) {
    if (i === boundaryAt) {
      const anchorUuid = randomUUID();
      content += row({ type: "system", subtype: "compact_boundary", parentUuid: null, logicalParentUuid: parentUuid,
        compactMetadata: { preservedMessages: { anchorUuid, uuids: [] } } });
      content += row({ type: "user", uuid: anchorUuid, isCompactSummary: true, isVisibleInTranscriptOnly: true,
        message: { role: "user", content: "Internal compact summary, excluded from chat messages" } });
    }
    content += turn(i);
  }
  for (let i = 0; i < metadataRows; i++)
    content += row({ type: "progress", data: { type: "hook_progress" } });
  await writeFile(file, content);
  return { sessionId, expected, file, initialBytes: Buffer.byteLength(content),
    append: () => appendFile(file, turn(expected.length / 2)) };
}

const tools = await makeFixture("长工具回执", 70, undefined, 0, 32);
const metadata = await makeFixture("元数据会话", 35, undefined, 350);
// A short third conversation for switching a pane while it reads older pages.
const swap = await makeFixture("切换会话", 6);
const compact = await makeFixture("压缩会话", 119, 60);
const long = await makeFixture("普通会话", 180);
let app, page;
const report = { fixtures: { longBytes: long.initialBytes, compactBytes: compact.initialBytes }, pages: [] };
const pane = view => page.locator('.desk-pane[data-view="' + view + '"]');
const viewport = view => pane(view).locator(".conversation-scroll");
const row = id => page.locator('.session-row[data-session-id="' + id + '"]');
const older = view => pane(view).getByRole("button", { name: "加载更早的消息", exact: true });
const labels = view => pane(view).locator(".message .user-text, .message .markdown").allTextContents();

async function historySize(expected, value) {
  await page.getByRole('button', { name: '界面与连接设置' }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '聊天记录', exact: true }).click();
  const input = settings.getByRole('spinbutton', { name: '向上翻页读取大小' });
  assert.equal(Number(await input.inputValue()), expected);
  if (value !== undefined) await input.fill(String(value));
  await settings.getByRole('button', { name: '关闭设置' }).click();
}

async function expectLatest(view, fixture) {
  await pane(view).getByText(fixture.expected.at(-1), { exact: true }).waitFor();
  await page.waitForFunction(view => {
    const v = document.querySelector('.desk-pane[data-view="' + view + '"] .conversation-scroll');
    return v && v.scrollHeight - v.clientHeight - v.scrollTop <= 2;
  }, view);
}

async function assertPairedHead(view) {
  const messages = pane(view).locator('.message');
  assert.ok(await messages.nth(0).locator('.user-text').count(), 'The first visible turn must begin with its prompt');
  assert.ok(await messages.nth(1).locator('.markdown').count(), 'The prompt must have its recorded reply');
}

async function assertInitial(view, fixture) {
  await assertPairedHead(view);
  const visible = await labels(view);
  assert.ok(visible.length > 0 && visible.length <= 2 * 32 && visible.length < fixture.expected.length / 2,
    "Only a bounded suffix should reach the initial DOM");
  assert.deepEqual(visible, fixture.expected.slice(-visible.length));
  assert.equal(await older(view).count(), 1);
  return visible.length;
}

// Set scrollTop and measure synchronously in one frame, before the scroll
// event issues IPC. This records the reading offset at the actual trigger.
async function anchor(view, targetTop) {
  return viewport(view).evaluate((v, top) => {
    // A wheel event marks the scroll as the reader's own (others keep the latest message).
    if (top !== null) { v.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 0 })); v.scrollTop = top; }
    const bounds = v.getBoundingClientRect();
    const articles = [...v.querySelectorAll(".message")];
    const first = articles.find(article => article.getBoundingClientRect().bottom > bounds.top);
    return { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - bounds.top,
      count: articles.length, ids: articles.map(a => a.dataset.messageId) };
  }, targetTop ?? null);
}

async function assertAnchor(view, mark) {
  const after = await viewport(view).evaluate((v, id) => {
    const el = v.querySelector('[data-message-id="' + CSS.escape(id) + '"]');
    return el && el.getBoundingClientRect().top - v.getBoundingClientRect().top;
  }, mark.id);
  assert.ok(after !== null, "Previously visible message disappeared");
  const drift = Math.abs(after - mark.offset);
  assert.ok(drift <= 2, "Reading position shifted " + drift + " px");
  return drift;
}

async function earlier(view, method = "scroll") {
  const before = await anchor(view, method === "scroll" ? 70 : null);
  if (method === "keyboard") {
    await older(view).evaluate(el => el.focus({ preventScroll: true }));
    await page.keyboard.press("Enter");
  }
  await page.waitForFunction(({ view, count }) =>
    document.querySelectorAll('.desk-pane[data-view="' + view + '"] .message').length > count, { view, count: before.count });
  await assertPairedHead(view);
  const driftPx = await assertAnchor(view, before);
  const ids = await pane(view).locator(".message").evaluateAll(nodes => nodes.map(n => n.dataset.messageId));
  assert.equal(new Set(ids).size, ids.length, "Duplicate message ID after prepend");
  assert.deepEqual(ids.slice(-before.count), before.ids, "Existing messages changed ID or order after prepend");
  report.pages.push({ view, method, before: before.count, after: ids.length, driftPx });
  return before;
}

async function readEvents() {
  const files = (await readdir(logs)).filter(file => /^events\.\d+\.jsonl$/.test(file)).sort();
  const rows = await Promise.all(files.map(file => readFile(path.join(logs, file), "utf8")));
  return rows.flatMap(s => s.trim().split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }));
}

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? [] : ["."], env,
    ...(executable && { executablePath: path.resolve(executable) }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await resizeWindow(app, page, 1500, 950);
  await historySize(3, 0.125);
  await page.reload();
  await historySize(0.125);
  // A preceding watch may legitimately backfill its metadata-only tail. Make
  // that case deterministic, then measure only the newly selected long chat.
  await row(metadata.sessionId).click();
  await expectLatest('primary', metadata);
  const mark = await page.evaluate(() => window.desktop.markDiagnosticIncident('开始验证普通会话首屏'));
  const since = (await readEvents()).find(e => e.event === 'incident.mark' && e.data.incidentId === mark).seq;
  await row(long.sessionId).click();
  await expectLatest("primary", long);
  const initial = await assertInitial("primary", long);
  // Wait for the archive's real next poll to prove idle time never walks backwards.
  const deadline = Date.now() + 16000;
  let idle, firstRead;
  while (Date.now() < deadline && !idle) {
    const events = await readEvents();
    const reads = events.filter(e => e.seq > since && e.event === "backend.jsonl.read" && e.data.sessionId === long.sessionId);
    firstRead = reads.findLast(e => e.data.reset && e.data.bytes > 0);
    idle = firstRead && reads.some(e => e.context.watchId === firstRead.context.watchId && e.seq > firstRead.seq && e.data.bytes === 0);
    if (!idle) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(idle, "Did not observe an idle poll after opening the tail");
  assert.equal(await assertInitial("primary", long), initial);
  assert.ok(firstRead.data.bytes < long.initialBytes / 3 && firstRead.data.olderBefore > 0,
    "First read should contain only the latest portion of the file");
  assert.ok(!(await readEvents()).some(e => e.event === 'controller.history.prepend' && e.context.watchId === firstRead.context.watchId),
    'Opening and polling this ordinary transcript should not request older history');
  report.longInitial = { messages: initial, total: long.expected.length,
    tailJsonlBytes: firstRead.data.bytes, sourceBytes: long.initialBytes, idlePollsLoadedOlder: false };
  await page.evaluate(id => {
    window.desktop.onSnapshot(snapshot => {
      if (snapshot.sessionId === id) window.lastLongSnapshot = snapshot;
    });
  }, long.sessionId);

  // A new canonical turn at EOF arrives through normal polling while pinned.
  await long.append();
  await expectLatest("primary", long);
  assert.equal((await labels("primary")).length, initial + 2);
  await earlier("primary");
  await earlier("primary", "keyboard");
  assert.equal(await older("primary").count(), 1);

  // A reader looking at an older message stays there when the real file grows.
  const reading = await anchor("primary");
  // The account-free archive has no live TUI. Inject one preview over the
  // normal preload event, then let the real next JSONL append replace it.
  const streaming = await page.evaluate(() => {
    const snapshot = structuredClone(window.lastLongSnapshot);
    const last = snapshot.messages.at(-1);
    last.source = "preview";
    last.status = "streaming";
    last.text += "\n\n预览更新".repeat(30);
    return snapshot;
  });
  await app.evaluate(({ BrowserWindow }, snapshot) =>
    BrowserWindow.getAllWindows()[0].webContents.send("lectern:snapshot", snapshot), streaming);
  await pane("primary").locator('.message[data-source="preview"]').waitFor();
  report.streamingReadingDriftPx = await assertAnchor("primary", reading);
  await long.append();
  await pane("primary").getByText(long.expected.at(-1), { exact: true }).waitFor();
  report.appendReadingDriftPx = await assertAnchor("primary", reading);
  assert.equal(await pane("primary").getByRole("button", { name: "滚动到最新消息" }).isVisible(), true);

  await pane("primary").getByRole("button", { name: "并排打开对话" }).click();
  await row(compact.sessionId).click();
  await expectLatest("secondary", compact);
  report.compactInitial = await assertInitial("secondary", compact);
  const primaryAnchor = await anchor("primary");
  let compactPages = 0;
  while (await older("secondary").count()) {
    assert.ok(compactPages++ < 30, "Compacted transcript cursor did not terminate");
    await earlier("secondary");
  }
  assert.ok(compactPages >= 2);
  assert.deepEqual(await labels("secondary"), compact.expected,
    "Both sides of the compact boundary should contain every original prompt/reply exactly once");
  report.compactTotal = compact.expected.length;
  report.splitReadingDriftPx = await assertAnchor("primary", primaryAnchor);
  await page.screenshot({ path: path.join(output, "split-history.png") });

  // Launch an older read and switch the same pane in the very same renderer task.
  await pane("primary").locator(".topbar-title").click();
  await page.evaluate(id => {
    document.querySelector('.desk-pane[data-view="primary"] .history-page-control button').click();
    document.querySelector('.session-row[data-session-id="' + id + '"]').click();
  }, swap.sessionId);
  await expectLatest("primary", swap);
  assert.deepEqual(await labels("primary"), swap.expected);
  await pane("primary").getByRole("button", { name: "滚动到最新消息" }).waitFor({ state: "hidden" });
  assert.equal((await pane("primary").locator(".message").allTextContents()).some(text => text.includes("普通会话")), false);

  // Reopening a conversation keeps the pages it already loaded instead of
  // reading its newest page again.
  await row(long.sessionId).click();
  await expectLatest("primary", long);
  await assertPairedHead("primary");
  const reopened = await labels("primary");
  assert.ok(reopened.length > report.longInitial.messages, "A reopened conversation keeps the history it already loaded");
  assert.deepEqual(reopened, long.expected.slice(-reopened.length));
  // A conversation shows in one pane at most: with the right pane focused, clicking
  // the one on the left moves the focus there instead of opening a second copy.
  await pane("secondary").locator(".topbar-title").click();
  await row(long.sessionId).click();
  await page.waitForFunction(() => document.querySelector('.desk-pane[data-view="primary"]')?.dataset.active === "true");
  assert.deepEqual(await labels("secondary"), compact.expected);
  assert.deepEqual(await labels("primary"), reopened);
  report.onePanePerConversation = true;

  await pane("secondary").locator(".topbar-title").click();
  await row(metadata.sessionId).click();
  const metadataView = pane("secondary");
  const button = older("secondary");
  await button.waitFor();
  await expectLatest('secondary', metadata);
  assert.deepEqual(await labels('secondary'), metadata.expected.slice(-2));
  assert.ok(await viewport("secondary").evaluate(el => el.scrollHeight <= el.clientHeight));
  // Temporarily remove the fixture while retaining its original inode. This
  // exercises a real transport error and retry through the same history cursor.
  const savedFile = metadata.file + ".hold";
  await rename(metadata.file, savedFile);
  const retry = metadataView.getByRole("button", { name: "重试加载更早的消息" });
  try {
    await viewport("secondary").focus();
    await page.keyboard.press("ArrowUp");
    await retry.waitFor();
    assert.ok(await metadataView.locator(".history-page-error").innerText());
  } finally {
    await rename(savedFile, metadata.file);
  }
  await viewport("secondary").focus();
  await page.keyboard.press("PageUp");
  await metadataView.getByText(metadata.expected.at(-4), { exact: true }).waitFor();
  await assertPairedHead('secondary');
  assert.equal(await metadataView.locator(".history-page-error").count(), 0);
  report.metadataOnlyKeyboardRetry = true;

  await historySize(0.125, 3);
  await row(tools.sessionId).click();
  await expectLatest('secondary', tools);
  assert.deepEqual(await labels('secondary'), tools.expected.slice(-2));
  const started = await older('secondary').evaluate(button => { const time = performance.now(); button.click(); return time; });
  const previousPrompt = tools.expected.at(-4);
  const appeared = await page.waitForFunction(prompt => [...document.querySelectorAll('.desk-pane[data-view="secondary"] .user-text')]
    .some(el => el.textContent === prompt) && performance.now(), previousPrompt);
  const desktopMs = Math.round(await appeared.jsonValue() - started);
  assert.deepEqual(await labels('secondary'), tools.expected.slice(-4));
  assert.equal(await older('secondary').count(), 1);
  // 界面计时已结束。等待主进程写完诊断队列后，再按本次请求追踪读取批次。
  await page.evaluate(() => window.desktop.markDiagnosticIncident('长工具回执分页计时结束'));
  const events = (await readEvents()).sort((a, b) => a.seq - b.seq);
  const historyRead = events.find(event => event.event === 'controller.history.previous.complete' && event.context.sessionId === tools.sessionId);
  assert.ok(historyRead);
  const trace = events.filter(event => event.context.traceId === historyRead.context.traceId);
  const commands = trace.filter(event => event.event === 'transport.command.complete' && event.context.commandTag === 'session.history_page');
  const ranges = trace.filter(event => event.event === 'backend.history.older_page');
  assert.equal(ranges.length, 2, '3 MiB 两批应覆盖这份长回执样本');
  assert.ok(Math.abs(ranges[0].data.selectedBytes - 3 * 1024 * 1024) <= 170 * 1024, '首批即使用设置的大小并按记录边界对齐');
  assert.ok(commands.length >= ranges.length);
  report.toolHistory = { fileBytes: tools.initialBytes, clicks: 1, pageSizeMiB: 3, pageBytes: ranges.map(event => event.data.selectedBytes), commands: commands.length,
    transportMs: commands.reduce((sum, event) => sum + event.data.durationMs, 0), controllerMs: historyRead.data.durationMs, desktopMs, previousPrompt };
  assert.deepEqual(errors, []);
  report.success = true;
} catch (error) {
  report.error = String(error.stack ?? error);
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app?.close();
  privateServer.killAll();
  await rm(root, { recursive: true, force: true });
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, output }));
}
