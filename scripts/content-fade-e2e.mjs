// npm run build && node scripts/content-fade-e2e.mjs [packaged-executable]
// New content fades in, removed content fades out (src/renderer/content-fade.ts), offline with
// the demo's mock Claude: a first open, another chat, the cache again and an older page show at
// once; a streamed reply fades in block by block and never twice; a sent bubble becomes the saved
// one in place; a rewound turn, the resume bar, a permission card and the progress pill fade out
// where they were while the conversation keeps its latest line (or the line being read) in place;
// with reduced motion nothing fades. Frames in test-results/content-fade-*/.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "tcf-")));
const output = path.resolve("test-results", "content-fade-" + Date.now());
await mkdir(output, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: "zh-CN", TMPDIR: root, TMUX_TMPDIR: root,
  LECTERN_USER_DATA: path.join(root, "profile"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: path.join(output, "diagnostics"), LECTERN_DIAGNOSTIC_CONTENT: "0" };
delete env.TMUX; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app, page;
const report = {};

/** A finished conversation of 40 turns (long replies), as Claude Code saves it. */
async function seedArchive(workspace) {
  const project = path.join(workspace.claudeDir, "projects", workspace.cwd.replace(/[^a-z0-9-]/gi, "-"));
  const sessionId = randomUUID(), lines = [];
  let parentUuid = null;
  for (let i = 0; i < 40; i++) for (const role of ["user", "assistant"]) {
    const uuid = randomUUID();
    const text = role === "user" ? "问题 " + i : `回复 ${i}：` + "这一段文字足够长，窗口变窄时会折成更多行。".repeat(6 + (i % 4));
    const message = role === "user" ? { role, content: text } : { role, id: uuid, content: [{ type: "text", text }], stop_reason: "end_turn" };
    lines.push(JSON.stringify({ type: role, uuid, parentUuid, sessionId, cwd: workspace.cwd,
      timestamp: new Date(1700000000000 + lines.length * 1000).toISOString(), message }));
    parentUuid = uuid;
  }
  const file = path.join(project, sessionId + ".jsonl");
  await writeFile(file, lines.join("\n") + "\n", { flag: "wx" });
  return { sessionId, file };
}

/** In the page: every element that starts fading in (`data-fade`) or out (`data-leaving`), and
 * when a leaving one goes. Elements get a number; `mark()` numbers what is shown now. */
function installRecorder() {
  return page.evaluate(() => {
    const ids = new WeakMap();
    let next = 0;
    const id = el => ids.get(el) ?? (ids.set(el, ++next), next);
    const name = el => el ? el.tagName.toLowerCase() + [...el.classList].map(c => "." + c).join("") : "";
    const log = { entered: [], leaving: [], gone: [] }, counts = new Map();
    new MutationObserver(records => {
      for (const r of records) {
        if (r.type === "attributes" && r.oldValue === null && r.target.hasAttribute(r.attributeName)) {
          const el = r.target, entry = { id: id(el), el: name(el), parent: name(el.parentElement), text: el.textContent.slice(0, 30), t: performance.now() };
          if (r.attributeName === "data-fade") { log.entered.push(entry); counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1); }
          else log.leaving.push({ ...entry, mode: el.getAttribute("data-leaving") });
        }
        if (r.type === "childList") for (const node of r.removedNodes)
          // React's removal comes first, with the element already put back: only the final one counts.
          if (node instanceof Element && node.hasAttribute("data-leaving") && !node.isConnected) log.gone.push({ id: id(node), t: performance.now() });
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-fade", "data-leaving"] });
    let marked = new Set();
    window.__fade = {
      log, id,
      twice: () => [...counts].filter(([, count]) => count > 1).map(([key]) => key),
      reset() { log.entered.length = log.leaving.length = log.gone.length = 0; },
      /** Numbers the messages and blocks shown now: none of them may fade in later. */
      mark() { marked = new Set([...document.querySelectorAll(".message, .message-content > *, .markdown > *, .markdown li")].map(id)); return marked.size; },
      remarked: () => log.entered.filter(entry => marked.has(entry.id)),
    };
  });
}
const fades = () => page.evaluate(() => ({ entered: window.__fade.log.entered, leaving: window.__fade.log.leaving, gone: window.__fade.log.gone,
  twice: window.__fade.twice(), remarked: window.__fade.remarked() }));
const reset = () => page.evaluate(() => window.__fade.reset());

/** In the page, once per painted frame: how far the conversation is from its end, the input area's
 * height, how far the line being read (`window.__anchor`) is above the input area, the leaving
 * elements and the opacity of those fading in. */
function startFrames() {
  return page.evaluate(() => {
    const v = document.querySelector(".conversation-scroll"), dock = document.querySelector(".composer-area");
    const frames = [], anchor = window.__anchor;
    let run = true;
    const sample = () => {
      const dockTop = dock.getBoundingClientRect().top;
      const ghosts = [...document.querySelectorAll("[data-leaving]")].map(el => {
        const box = el.getBoundingClientRect();
        return { id: window.__fade.id(el), mode: el.dataset.leaving, top: box.top, bottom: box.bottom, height: box.height, opacity: +getComputedStyle(el).opacity };
      });
      const fading = [...document.querySelectorAll('[data-fade="in"]')].map(el => ({ id: window.__fade.id(el), opacity: +getComputedStyle(el).opacity }));
      frames.push({ t: performance.now(), gap: v.scrollHeight - v.scrollTop - v.clientHeight, dock: dock.getBoundingClientRect().height,
        read: anchor?.isConnected ? dockTop - anchor.getBoundingClientRect().top : null, top: anchor?.isConnected ? anchor.getBoundingClientRect().top : null, ghosts, fading });
    };
    // After the frame is painted: what the reader saw (ResizeObserver corrections included).
    const tick = () => { if (run) requestAnimationFrame(() => setTimeout(() => { sample(); tick(); }, 0)); };
    tick();
    window.__frames = { stop() { run = false; return frames; } };
  });
}
const stopFrames = () => page.evaluate(() => window.__frames.stop());
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120)))));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** The message at the bottom edge of the visible conversation (above the input area), as scroll-anchor-e2e reads it. */
const readLine = () => page.evaluate(() => {
  const bottom = document.querySelector(".composer-area").getBoundingClientRect().top;
  const el = [...document.querySelectorAll(".conversation-scroll .message:not([data-leaving])")].filter(node => node.getBoundingClientRect().top < bottom - 40).at(-1);
  window.__anchor = el;
  const top = el.getBoundingClientRect().top;
  return { id: el.dataset.messageId, text: el.textContent.slice(0, 12), top, offset: bottom - top };
});
/** Where the message read before (`readLine`) is now, looked up again by its id: whether it is still
 * the same element, its top on screen and how far that is above the input area. */
const findLine = id => page.evaluate(id => {
  const bottom = document.querySelector(".composer-area").getBoundingClientRect().top;
  const el = document.querySelector(`.conversation-scroll .message[data-message-id="${CSS.escape(id)}"]:not([data-leaving])`);
  const top = el?.getBoundingClientRect().top;
  return el ? { same: el === window.__anchor, top, offset: bottom - top } : null;
}, id);
const maxGap = frames => Math.max(0, ...frames.map(frame => frame.gap));
const shot = name => page.screenshot({ path: path.join(output, name) });

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? ["--demo"] : [".", "--demo"], env, ...(executable && { executablePath: path.resolve(executable) }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 840));
  const live = page.locator('.session-row.active[data-session-live="true"]');
  await live.waitFor();
  const liveId = await live.getAttribute("data-session-id");
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  const archive = await seedArchive(workspace);
  const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
  await installRecorder();

  // 1. A first open, another chat, and the cached one again: shown as they are, nothing fades.
  await row(archive.sessionId).click();
  await page.locator(".conversation-scroll").getByText("问题 39", { exact: true }).waitFor();
  await pause(800);
  await row(liveId).click();
  await page.locator(".message-assistant").first().waitFor();
  await pause(800);
  await row(archive.sessionId).click();
  await page.locator(".conversation-scroll").getByText("问题 39", { exact: true }).waitFor();
  await pause(800);
  let seen = await fades();
  report.opened = { entered: seen.entered.length, leaving: seen.leaving.length };
  assert.deepEqual(seen.entered, [], "opening a chat, another one, or the cached one again fades nothing in");
  assert.deepEqual(seen.leaving, [], "switching chats fades nothing out");
  await shot("opened.png");

  // 2. An older page: inserted as it is. Only the jump-to-latest button fades in (and out when used).
  const scroll = page.locator(".conversation-scroll");
  assert.equal(await scroll.getByText("问题 0", { exact: true }).count(), 0, "the oldest turn is not on the first page");
  await scroll.hover();
  for (let i = 0; i < 40 && !await scroll.getByText("问题 0", { exact: true }).count(); i++) {
    await page.mouse.wheel(0, -4000);
    await pause(150);
  }
  await scroll.getByText("问题 0", { exact: true }).waitFor();
  await settle();
  seen = await fades();
  assert.deepEqual(seen.entered.filter(entry => !entry.el.includes("scroll-latest")), [], "an older page fades nothing in");
  assert.ok(seen.entered.some(entry => entry.el.includes("scroll-latest")), "the jump-to-latest button fades in");
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".scroll-latest"));
  seen = await fades();
  assert.deepEqual(seen.leaving.map(entry => [entry.el, entry.mode]), [["button.scroll-latest", "fade"]], "the jump button fades out");
  assert.equal(seen.gone.length, 1);
  await reset();

  // 3. Resuming: the resume bar fades out where it was while the input area settles.
  const input = page.getByRole("textbox", { name: "发送给 Claude 的消息" });
  await page.getByRole("button", { name: "续接会话", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.matches(':disabled, [aria-disabled="true"]'), null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector(".resume-bar"));
  seen = await fades();
  assert.ok(seen.leaving.some(entry => entry.el.startsWith("div.resume-bar") && entry.mode === "pin"), JSON.stringify(seen.leaving));
  await reset();

  // 4. Above the input box: the progress pill and a permission card fade in, and when they go
  // they fade out where they were while the input area eases to its height (no jump below).
  const stateFile = path.join(workspace.claudeDir, "screen-state");
  /** Shows something in the input area, then removes it: what faded and how the area moved. */
  async function dockRoundTrip(show, selector, hide) {
    await reset();
    await show();
    await page.locator(selector).waitFor();
    await pause(300);
    await settle();
    const before = await page.evaluate(selector => {
      const box = document.querySelector(selector).getBoundingClientRect(), dock = document.querySelector(".composer-area").getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, dock: dock.height };
    }, selector);
    await startFrames();
    await hide();
    await page.waitForFunction(selector => !document.querySelector(selector), selector);
    await settle();
    const frames = await stopFrames(), after = await page.evaluate(() => document.querySelector(".composer-area").getBoundingClientRect().height);
    return { before, after, frames, seen: await fades() };
  }
  const pill = await dockRoundTrip(() => writeFile(stateFile, "progress"), ".turn-progress", () => writeFile(stateFile, "ready"));
  const card = await dockRoundTrip(async () => {
    await input.fill("运行标记命令 permission-late:600000");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  }, "section.permission-card", async () => {
    await shot("permission-card.png");
    await page.locator("section.permission-card [data-permission-option=\"1\"]").click();
  });
  for (const [name, { before, after, frames, seen }] of Object.entries({ pill, card })) {
    const ghost = frames.flatMap(frame => frame.ghosts.filter(item => item.mode === "pin"));
    const easing = frames.map(frame => frame.dock).filter(height => height < before.dock - 1 && height > after + 1);
    report[name] = { before, after, ghostTops: ghost.map(item => Math.round(item.top)), dock: frames.map(frame => Math.round(frame.dock)), maxGap: maxGap(frames),
      entered: seen.entered.map(entry => entry.el), leaving: seen.leaving.map(entry => [entry.el, entry.mode]) };
    assert.ok(seen.entered.some(entry => entry.parent.startsWith("div.composer-area")), `${name}: it fades in: ${report[name].entered}`);
    assert.ok(seen.leaving.some(entry => entry.mode === "pin"), `${name}: it fades out pinned: ${JSON.stringify(report[name].leaving)}`);
    assert.deepEqual(seen.leaving.filter(entry => entry.el.startsWith("article")), [], `${name}: no message left meanwhile`);
    assert.ok(ghost.length && Math.abs(ghost[0].top - before.top) <= 4, `${name}: where it was (${before.top} → ${ghost[0]?.top})`);
    assert.ok(after < before.dock - 1 && easing.length >= 2, `${name}: the input area eases to its new height: ${report[name].dock}`);
    assert.ok(maxGap(frames) <= 2, `${name}: the latest line stays just above the input area (${maxGap(frames)}px)`);
  }
  await page.locator(".message-assistant").filter({ hasText: "已允许并运行" }).waitFor();
  await reset();

  // 5. A reply streamed from the terminal, then saved: the sent bubble, the reply and each new
  // block fade in once; blocks already shown never again; the latest line stays in view.
  await settle();
  report.marked = await page.evaluate(() => window.__fade.mark());
  await startFrames();
  await input.fill("你好");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const preview = page.locator('.message-assistant[data-source="preview"]').last();
  await preview.locator(".markdown > p").nth(1).waitFor();
  await shot("streaming-1.png");
  await preview.locator(".markdown > p").nth(2).waitFor();
  await shot("streaming-2.png");
  await page.waitForFunction(() => [...document.querySelectorAll(".message-assistant")].at(-1)?.getAttribute("data-source") === "jsonl" &&
    [...document.querySelectorAll(".message-assistant")].at(-1).textContent.includes("继续这个会话"), null, { timeout: 30000 });
  await settle();
  let frames = await stopFrames();
  seen = await fades();
  report.streamed = { entered: seen.entered.map(entry => `${entry.el} < ${entry.parent}`), frames: frames.length, maxGap: maxGap(frames) };
  assert.deepEqual(seen.twice, [], "nothing fades in twice");
  assert.deepEqual(seen.remarked, [], "messages and blocks already shown do not fade in");
  assert.equal(seen.entered.filter(entry => entry.el.startsWith("article.message.message-user")).length, 1, "the sent bubble fades in once");
  assert.equal(seen.entered.filter(entry => entry.el.startsWith("article.message.message-assistant")).length, 1, "the reply fades in once");
  const blocks = seen.entered.filter(entry => entry.parent === "div.markdown" && entry.el === "p");
  assert.ok(blocks.length >= 2, "paragraphs streamed into the reply fade in one by one: " + JSON.stringify(report.streamed.entered));
  assert.ok(blocks.every((entry, i) => i === 0 || entry.t - blocks[i - 1].t > 50), "each block when it appears, not all at once");
  assert.deepEqual(seen.leaving.filter(entry => entry.el.startsWith("article")), [], "the sent bubble becomes the saved one in place; the preview becomes the saved reply in place");
  assert.ok(maxGap(frames) <= 2, `the latest line stays in view while blocks fade in (${maxGap(frames)}px)`);
  // The fade itself: a block starts nearly transparent and becomes opaque within the fade time.
  const opacities = new Map();
  for (const frame of frames) for (const { id, opacity } of frame.fading) opacities.set(id, [...opacities.get(id) ?? [], opacity]);
  const ramps = [...opacities.values()].filter(values => values.length >= 3);
  report.ramps = ramps.slice(0, 4);
  assert.ok(ramps.some(values => values[0] < 0.6 && values.at(-1) > values[0] + 0.2), "opacity rises over several frames: " + JSON.stringify(report.ramps));
  await reset();

  // 6. Reading older messages while a reply streams in and fades in below: the line being read
  // stays. (Sending goes to the latest message: scroll up once the reply has begun.)
  await input.fill("继续讲讲");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.locator('.message-assistant[data-source="preview"]').last().locator(".markdown > p").first().waitFor();
  await page.evaluate(() => {
    const v = document.querySelector(".conversation-scroll");
    v.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 0 }));
    v.scrollTop = v.scrollHeight / 2;
  });
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).waitFor();
  await settle();
  const reading = await readLine();
  await startFrames();
  await page.waitForFunction(() => [...document.querySelectorAll(".message-assistant")].at(-1)?.getAttribute("data-source") === "jsonl" &&
    [...document.querySelectorAll(".message-assistant")].at(-1).textContent.includes("已收到你的消息：继续讲讲"), null, { timeout: 30000 });
  await settle();
  frames = await stopFrames();
  // The input area also drops when the reply ends (its progress pill fades out): in the same update
  // as the reply's last text, the conversation keeps its first visible message where it is.
  const drift = Math.max(...frames.filter(frame => frame.top !== null).map(frame => Math.abs(frame.top - frames[0].top)));
  report.reading = { line: reading, drift, frames: frames.length, covered: Math.min(...frames.map(frame => frame.read)),
    dock: [frames[0].dock, frames.at(-1).dock].map(Math.round) };
  assert.ok(drift <= 4, `the line being read does not move on screen while new content fades in below (${drift}px)`);
  assert.ok(report.reading.covered >= 40, "the input area never covers it");
  // Afterwards it is still the same message, where it was. (Not "still the message at the bottom edge":
  // the input area drops by the pill's height and uncovers what was under it, so the next message may
  // now start above the edge, depending on fonts and line wrapping: on CI, without CJK fonts, it did.)
  const after = report.reading.after = await findLine(reading.id);
  assert.ok(after?.same && Math.abs(after.top - reading.top) <= 4 && after.offset >= 40,
    "the message being read stays where it was, above the input area: " + JSON.stringify(after));
  seen = await fades();
  assert.ok(seen.entered.some(entry => entry.parent === "div.markdown"), "blocks of the new reply faded in");
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".scroll-latest"));
  await reset();

  // 7. A rewound turn: its messages fade out where they were and give their height back, the
  // conversation following its end all along.
  const records = (await readFile(archive.file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  let parent = records.filter(record => record.uuid).at(-1).uuid;
  const turn = (question, answer) => [["user", question], ["assistant", answer]].map(([role, text]) => {
    const uuid = randomUUID(), message = role === "user" ? { role, content: text } : { role, id: uuid, content: [{ type: "text", text }], stop_reason: "end_turn" };
    const record = { type: role, uuid, parentUuid: parent, sessionId: archive.sessionId, cwd: workspace.cwd, timestamp: new Date().toISOString(), message };
    parent = uuid;
    return record;
  });
  const kept = turn("保留的提问", "保留的回复"), rewound = turn("将被回退的提问", "将被回退的回复：" + "这一段会淡出并收起。".repeat(30));
  await appendFile(archive.file, [...kept, ...rewound].map(record => JSON.stringify(record) + "\n").join(""));
  await page.getByText("将被回退的提问", { exact: true }).waitFor();
  await settle();
  await reset();
  await startFrames();
  await appendFile(archive.file, JSON.stringify({ type: "last-prompt", leafUuid: kept[1].uuid, explicit: true, rewound: true, cutUuid: rewound[0].uuid,
    sessionId: archive.sessionId, timestamp: new Date().toISOString() }) + "\n");
  await page.waitForFunction(() => document.querySelectorAll('.message[data-leaving="collapse"]').length === 2);
  await shot("rewound-leaving.png");
  await page.waitForFunction(() => !document.querySelector(".message[data-leaving]"));
  await settle();
  frames = await stopFrames();
  seen = await fades();
  assert.equal(await page.getByText("将被回退的提问", { exact: true }).count(), 0);
  assert.deepEqual(seen.leaving.map(entry => [entry.el.split(".").slice(0, 3).join("."), entry.mode]).sort().reverse(),
    [["article.message.message-user", "collapse"], ["article.message.message-assistant", "collapse"]], JSON.stringify(seen.leaving));
  const both = frames.find(frame => frame.ghosts.length === 2)?.ghosts, user = seen.leaving.find(entry => entry.el.includes("message-user"));
  assert.ok(both && both[0].id === user.id && both[0].bottom <= both[1].top + 1, "they stay in their order: the question above its reply");
  const lasted = seen.gone.map(gone => gone.t - seen.leaving.find(entry => entry.id === gone.id).t);
  const heights = frames.flatMap(frame => frame.ghosts.filter(ghost => ghost.mode === "collapse").map(ghost => ghost.height));
  report.rewound = { lasted, heights: heights.map(Math.round), maxGap: maxGap(frames) };
  assert.ok(lasted.length === 2 && lasted.every(ms => ms >= 150 && ms < 600), "they stay for the fade, then go: " + lasted);
  assert.ok(heights.some(height => height > 1 && height < Math.max(...heights) - 1), "the height collapses over several frames: " + report.rewound.heights);
  assert.ok(maxGap(frames) <= 2, `the latest line stays in view while they collapse (${maxGap(frames)}px)`);
  assert.equal(await page.getByText("保留的回复", { exact: true }).count(), 1);
  // The same while reading older messages: what is being read stays where it is.
  parent = kept[1].uuid;
  const kept2 = turn("又一个保留的提问", "又一个保留的回复"), rewound2 = turn("第二次回退的提问", "第二次回退的回复：" + "也会淡出。".repeat(40));
  await appendFile(archive.file, [...kept2, ...rewound2].map(record => JSON.stringify(record) + "\n").join(""));
  await page.getByText("第二次回退的提问", { exact: true }).waitFor();
  await page.evaluate(() => {
    const v = document.querySelector(".conversation-scroll");
    v.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 0 }));
    v.scrollTop = v.scrollHeight / 2;
  });
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).waitFor();
  await pause(800);
  await readLine();
  await reset();
  await startFrames();
  await appendFile(archive.file, JSON.stringify({ type: "last-prompt", leafUuid: kept2[1].uuid, explicit: true, rewound: true, cutUuid: rewound2[0].uuid,
    sessionId: archive.sessionId, timestamp: new Date().toISOString() }) + "\n");
  await page.waitForFunction(() => document.querySelectorAll('.message[data-leaving="collapse"]').length === 2);
  await page.waitForFunction(() => !document.querySelector(".message[data-leaving]"));
  await settle();
  frames = await stopFrames();
  const moved = Math.max(...frames.map(frame => Math.abs(frame.top - frames[0].top)));
  report.rewoundReading = { moved, leaving: (await fades()).leaving.map(entry => entry.mode) };
  assert.deepEqual(report.rewoundReading.leaving, ["collapse", "collapse"]);
  assert.ok(moved <= 1, `the line being read does not move while the rewound turn collapses below (${moved}px)`);
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".scroll-latest"));
  await reset();

  // 8. Reduced motion: everything appears and goes at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
  await page.waitForFunction(() => document.querySelector(".session-row.active")?.getAttribute("data-status") === "idle");
  const greeted = () => page.evaluate(() => [...document.querySelectorAll('.message-assistant[data-source="jsonl"]')].filter(node => node.textContent.includes("继续这个会话")).length);
  const greetings = await greeted();
  await input.fill("你好，再来一次");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(count => [...document.querySelectorAll('.message-assistant[data-source="jsonl"]')].filter(node => node.textContent.includes("继续这个会话")).length > count,
    greetings, { timeout: 30000 });
  await writeFile(stateFile, "progress");
  await page.locator(".turn-progress").waitFor();
  await writeFile(stateFile, "ready");
  await page.locator(".turn-progress").waitFor({ state: "detached" });
  await settle();
  seen = await fades();
  report.reducedMotion = { entered: seen.entered.length, leaving: seen.leaving.length };
  assert.deepEqual(seen.entered, [], "reduced motion: nothing fades in");
  assert.deepEqual(seen.leaving, [], "reduced motion: nothing fades out");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // 9. A new chat: its first message fades in once (not again when the chat opens), then the reply.
  await page.getByRole("button", { name: /^新建对话/ }).first().click();
  await page.waitForFunction(() => !document.querySelector("textarea")?.matches(':disabled, [aria-disabled="true"]') && document.querySelector(".draft-settings"));
  await reset();
  await input.fill("你好，新对话");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".message-assistant")?.getAttribute("data-source") === "jsonl" &&
    document.querySelector(".message-assistant").textContent.includes("继续这个会话"), null, { timeout: 30000 });
  await settle();
  seen = await fades();
  report.newChat = seen.entered.map(entry => `${entry.el} < ${entry.parent}`);
  assert.equal(seen.entered.filter(entry => entry.el.startsWith("article.message.message-user")).length, 1, "the first message fades in once: " + report.newChat);
  assert.equal(seen.entered.filter(entry => entry.el.startsWith("article.message.message-assistant")).length, 1, "the reply fades in: " + report.newChat);
  assert.deepEqual(seen.leaving.filter(entry => entry.el.startsWith("article")), [], "the sent bubble becomes the saved one in place");
  assert.deepEqual(seen.twice, []);
  assert.deepEqual(errors, []);
  await shot("done.png");
  console.log(JSON.stringify({ success: true, report, output }));
} catch (error) {
  console.error(JSON.stringify({ report }, null, 1));
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
