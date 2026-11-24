// npm run build && node scripts/content-fade-e2e.mjs [packaged-executable]
// New content fades in, removed content fades out (src/renderer/content-fade.ts), offline with
// the demo's mock Claude: a first open, another chat, the cache again and an older page show at
// once; a streamed reply fades in block by block and never twice, and text added to a paragraph
// already shown fades in as text (text-fade.ts), once, also when its Markdown changes shape, and copies
// as it is meanwhile (the system clipboard: one at a time in test-all); a sent bubble becomes the saved
// one in place; a rewound turn, the resume bar, a permission card and the progress pill fade out
// where they were while the conversation keeps its latest line (or the line being read) in place;
// with reduced motion nothing fades. Frames in test-results/content-fade-*/.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "./fixtures/electron.mjs";
import { refreshFolderUntil } from "./fixtures/sidebar-refresh.mjs";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "tcf-")));
const output = path.resolve("test-results", "content-fade-" + Date.now());
await mkdir(output, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: "zh-CN", TMPDIR: root, TMUX_TMPDIR: root,
  LECTERN_USER_DATA: path.join(root, "profile"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: path.join(output, "diagnostics"), LECTERN_DIAGNOSTIC_CONTENT: "0",
  // The mock's second paragraph starts 0.2 s into its reply at the usual pace: a slower machine (the
  // macOS runner, more so beside another test) may read the reply first only then, and see two
  // paragraphs arrive together. Even 0.5 s (250 ms) was not always enough there.
  LECTERN_MOCK_STREAM_MS: "500" };
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

/** In the page: every element that starts fading in (`data-fade`) or out (`data-leaving`), the
 * animations it got then, how they ended, and when a leaving one goes. Elements get a number;
 * `mark()` numbers what is shown now. The animations are read from the page's own records, not
 * from painted frames: a busy runner may paint none while one runs (see dockRoundTrip). */
function installRecorder() {
  return page.evaluate(() => {
    const ids = new WeakMap();
    let next = 0;
    const id = el => ids.get(el) ?? (ids.set(el, ++next), next);
    const name = el => el ? el.tagName.toLowerCase() + [...el.classList].map(c => "." + c).join("") : "";
    /** The CSS animations and transitions on the element now: name (or property), state, timing, first and last keyframe. */
    const animations = el => el.getAnimations().map(animation => {
      const timing = animation.effect.getTiming(), keyframes = animation.effect.getKeyframes();
      const values = frame => frame && Object.fromEntries(Object.entries(frame).filter(([key]) => !["offset", "computedOffset", "easing", "composite"].includes(key)));
      return { name: animation.animationName ?? animation.transitionProperty, state: animation.playState, duration: timing.duration,
        easing: keyframes[0]?.easing === "linear" ? timing.easing : keyframes[0]?.easing, from: values(keyframes[0]), to: values(keyframes.at(-1)) };
    });
    const log = { entered: [], leaving: [], gone: [], ended: [] }, counts = new Map();
    for (const type of ["animationend", "animationcancel"]) document.addEventListener(type, event => event.target instanceof Element &&
      log.ended.push({ id: id(event.target), type, name: event.animationName, elapsed: event.elapsedTime, t: performance.now() }), true);
    new MutationObserver(records => {
      for (const r of records) {
        if (r.type === "attributes" && r.oldValue === null && r.target.hasAttribute(r.attributeName)) {
          const el = r.target, entry = { id: id(el), el: name(el), parent: name(el.parentElement), text: el.textContent.slice(0, 30), t: performance.now(), animations: animations(el),
            chars: window.__textFade?.replyChars(el) ?? 0 };
          if (r.attributeName === "data-fade") { log.entered.push(entry); counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1); }
          else {
            const box = el.getBoundingClientRect();
            log.leaving.push({ ...entry, mode: el.getAttribute("data-leaving"), top: box.top, bottom: box.bottom, height: box.height, position: getComputedStyle(el).position });
          }
        }
        if (r.type === "childList") for (const node of r.removedNodes)
          // React's removal comes first, with the element already put back: only the final one counts.
          if (node instanceof Element && node.hasAttribute("data-leaving") && !node.isConnected) log.gone.push({ id: id(node), t: performance.now() });
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-fade", "data-leaving"] });
    let marked = new Set();
    window.__fade = {
      log, id, animations,
      twice: () => [...counts].filter(([, count]) => count > 1).map(([key]) => key),
      reset() { log.entered.length = log.leaving.length = log.gone.length = log.ended.length = 0; },
      /** Numbers the messages and blocks shown now: none of them may fade in later. */
      mark() { marked = new Set([...document.querySelectorAll(".message, .message-content > *, .markdown > *, .markdown li")].map(id)); return marked.size; },
      remarked: () => log.entered.filter(entry => marked.has(entry.id)),
    };
  });
}
/** In the page: every span a text fade puts in (`data-text-fade`): its text, its delay (negative: a fade
 * going on), the animation it got then, where its text is in its reply (visible characters, counted as
 * text-fade.ts counts them) and the reply's visible text before and after the change that brought it. */
function installTextRecorder() {
  return page.evaluate(() => {
    const visible = text => text.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "");
    const blocks = message => [...message.querySelectorAll(":scope > .message-content > .markdown:not([data-fade-placeholder])")];
    const replyText = message => blocks(message).map(block => visible(block.textContent)).join("");
    const offsetOf = (message, node) => {
      let count = 0;
      for (const block of blocks(message)) for (let walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), text = walker.nextNode(); text; text = walker.nextNode()) {
        if (text === node) return count;
        count += visible(text.data).length;
      }
      return -1;
    };
    const log = { spans: [], snaps: [] }, shown = new WeakMap(), id = window.__fade.id;
    new MutationObserver(records => {
      const messages = new Set(), spans = [], t = performance.now();
      for (const r of records) {
        const message = (r.target instanceof Element ? r.target : r.target.parentElement)?.closest(".message");
        if (message) messages.add(message);
        for (const node of r.addedNodes) if (node instanceof HTMLElement && node.matches(".message")) messages.add(node);
        for (const node of r.addedNodes) if (node instanceof HTMLElement && node.hasAttribute("data-text-fade")) spans.push(node);
      }
      for (const message of messages) {
        if (!message.isConnected || message.matches(".message-user")) continue;
        const text = replyText(message), last = shown.get(message);
        if (text !== last?.text) { shown.set(message, { text, before: last?.text ?? "" }); log.snaps.push({ t, id: id(message), source: message.dataset.source, text }); }
      }
      for (const span of spans) {
        const message = span.isConnected && span.closest(".message");
        if (!message) continue;
        const { text, before } = shown.get(message) ?? { text: replyText(message), before: "" };
        log.spans.push({ t, id: id(span), message: id(message), source: message.dataset.source, text: span.textContent, chars: visible(span.textContent).length,
          delay: parseFloat(span.style.animationDelay) || 0, offset: offsetOf(message, span.firstChild), parent: span.parentElement.tagName.toLowerCase(),
          animations: window.__fade.animations(span), before, after: text });
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__textFade = { log, visible, reset() { log.spans.length = log.snaps.length = 0; },
      /** The visible characters of a reply's own text in this element (a block of it, or the message). */
      replyChars: el => el.matches(".message") ? replyText(el).length : el.closest(".message-content > .markdown:not([data-fade-placeholder])") ? visible(el.textContent).length : 0 };
  });
}
const textFades = () => page.evaluate(() => ({ spans: window.__textFade.log.spans, snaps: window.__textFade.log.snaps, left: document.querySelectorAll("[data-text-fade]").length }));
/** The demo's replies (scripts/mock-claude.mjs): to "你好", and to a prompt with `mock-markdown`. */
const HELLO = "你好！这是运行在真实 tmux 中的离线模拟会话。\n\n回复先从终端画面逐段出现，然后由 JSONL 正文在原气泡内完成对齐。中文与 emoji 🧭 都会完整保留。\n\n你可以关闭窗口再回来，继续这个会话。";
const MARKDOWN = "先显示的文字，**这段加粗要到后面才闭合**，然后接着写完下去吧。\n\n1. 第一项：日本語のテキスト\n2. 第二项 emoji 🧭👨\u200d👩\u200d👧" +
  "\n\n| 列 A | 列 B |\n| --- | --- |\n| 甲 | 乙 |\n\n```bash\necho 你好\n```\n\n最后一句。";
const visibleText = text => text.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "");
const subsequence = (part, whole) => { let at = 0; for (const char of part) if ((at = whole.indexOf(char, at) + 1) === 0) return false; return true; };
/**
 * Text fades read against the reply's source (its Markdown as sent), independently of text-fade.ts:
 * the rendered text is the source without its syntax, so each visible character is found in the
 * source, in order. `refaded`: characters of a fresh fade (no delay) that the reply showed before
 * (allowed only with a new one of the same grapheme cluster: an emoji sequence that grew); `orphans`:
 * fades going on (negative delay) that do not continue an earlier fresh one of the same characters,
 * from its own start.
 */
function readTextFades(spans, source) {
  const src = visibleText(source), cluster = [], members = [];
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(src)) {
    members.push([]);
    for (let i = 0; i < segment.length; i++) { members.at(-1).push(cluster.length); cluster.push(members.length - 1); }
  }
  const embed = text => { const at = []; let j = 0; for (const unit of text.split("")) { while (j < src.length && src[j] !== unit) j++; at.push(j < src.length ? j++ : -1); } return at; };
  const fresh = spans.filter(span => span.delay === 0), going = spans.filter(span => span.delay < 0), refaded = [], unknown = [];
  for (const span of fresh) {
    const before = new Set(embed(span.before)), after = embed(span.after);
    if (span.offset < 0 || span.after.slice(span.offset, span.offset + span.chars) !== visibleText(span.text)) { unknown.push(span.text); continue; }
    for (let k = span.offset; k < span.offset + span.chars; k++)
      if (after[k] < 0) { unknown.push(span.text); break; }
      else if (members[cluster[after[k]]].every(i => before.has(i))) refaded.push(`${src[after[k]]} in ${span.text}`);
  }
  const orphans = going.filter(span => !fresh.some(start => start.t < span.t && subsequence(visibleText(span.text), visibleText(start.text)) &&
    Math.abs(-span.delay - (span.t - start.t)) <= 30)).map(span => `${span.text} ${span.delay}`);
  return { fresh, going, refaded, unknown, orphans };
}
/** Selects the latest reply's text while some of it fades in and copies it as a reader would (Ctrl+C,
 * the system clipboard): the clipboard, and what the page held when the copy happened (its `copy`
 * event): the fading spans, the text of the reply's blocks, its paragraphs, items, cells and code. */
async function copyWhileFading() {
  for (let tries = 1; tries <= 20; tries++) {
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await page.waitForFunction(() => [...document.querySelectorAll(".message-assistant")].at(-1)?.querySelector("[data-text-fade]"), null, { timeout: 15000 });
    await page.evaluate(() => {
      const reply = [...document.querySelectorAll(".message-assistant")].at(-1), blocks = [...reply.querySelectorAll(":scope > .message-content > .markdown")];
      document.querySelector(".conversation-scroll").focus({ preventScroll: true });
      const range = document.createRange();
      range.setStartBefore(blocks[0]);
      range.setEndAfter(blocks.at(-1));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      window.__copied = undefined;
      document.addEventListener("copy", () => { window.__copied = { fading: [...reply.querySelectorAll("[data-text-fade]")].map(span => span.textContent),
        text: blocks.map(block => block.textContent).join(""), selected: getSelection().toString(),
        pieces: [...reply.querySelectorAll(".markdown p, .markdown li, .markdown th, .markdown td, .markdown code")].map(el => el.textContent.trim()).filter(Boolean) }; },
      { once: true, capture: true });
    });
    await page.keyboard.press("Control+C");
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText()), state = await page.evaluate(() => window.__copied);
    if (state?.fading.length && clip) return { clip, tries, ...state };
  }
  throw new Error("could not copy the reply while its text was fading in");
}
const fades = () => page.evaluate(() => ({ entered: window.__fade.log.entered, leaving: window.__fade.log.leaving, gone: window.__fade.log.gone,
  ended: window.__fade.log.ended, twice: window.__fade.twice(), remarked: window.__fade.remarked() }));
const reset = () => page.evaluate(() => { window.__fade.reset(); window.__textFade.reset(); });

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
/** In the page: each change to the input area's inline style (when, its min-height and the min-height
 * transition it then runs, read at once) and the transition's events. The transition is the ease,
 * so this says whether it eased whatever the runner paints meanwhile. */
function watchDockEase() {
  return page.evaluate(() => {
    const dock = document.querySelector(".composer-area"), log = { styles: [], events: [] };
    const types = ["transitionrun", "transitionstart", "transitionend", "transitioncancel"];
    const observer = new MutationObserver(() => log.styles.push({ t: performance.now(), minHeight: dock.style.minHeight,
      transitions: window.__fade.animations(dock).filter(animation => animation.name === "min-height") }));
    observer.observe(dock, { attributes: true, attributeFilter: ["style"] });
    const note = event => event.target === dock && event.propertyName === "min-height" &&
      log.events.push({ type: event.type, t: performance.now(), elapsed: Math.round(event.elapsedTime * 1000) });
    for (const type of types) dock.addEventListener(type, note);
    window.__dockEase = () => { observer.disconnect(); for (const type of types) dock.removeEventListener(type, note); return log; };
  });
}
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
  await refreshFolderUntil(page, workspace.id, row(archive.sessionId));
  await installRecorder();
  await installTextRecorder();

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
  assert.deepEqual((await textFades()).spans, [], "nor does any text in them");
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
  assert.deepEqual((await textFades()).spans, [], "an older page fades no text in");
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
    await watchDockEase();
    await hide();
    await page.waitForFunction(selector => !document.querySelector(selector), selector);
    // Until the leaving one is gone and the input area's ease is undone (FADE_LEAVE_MS + 40 after).
    await page.waitForFunction(() => !document.querySelector(".composer-area > [data-leaving]") && !document.querySelector(".composer-area").style.minHeight);
    await settle();
    const frames = await stopFrames(), ease = await page.evaluate(() => window.__dockEase());
    const after = await page.evaluate(() => document.querySelector(".composer-area").getBoundingClientRect().height);
    return { before, after, frames, ease, seen: await fades() };
  }
  const pill = await dockRoundTrip(() => writeFile(stateFile, "progress"), ".turn-progress", () => writeFile(stateFile, "ready"));
  const card = await dockRoundTrip(async () => {
    await input.fill("运行标记命令 permission-late:600000");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  }, "section.permission-card", async () => {
    await shot("permission-card.png");
    await page.locator("section.permission-card [data-permission-option=\"1\"]").click();
  });
  for (const [name, { before, after, frames, ease, seen }] of Object.entries({ pill, card })) {
    // Whether it eased and faded where it was is read from the page's records: the transition and
    // the animation it started, the style it held. Painted frames only show it when the window draws
    // during those 180 ms: on a busy macOS runner (--jobs 2) frames once stopped right after the fade
    // began and came back with the card gone (dock 497 … 497, 145: run 45348497143), the transition
    // created and started all the same; stopping the GPU process for 400 ms there does the same here.
    const pinned = seen.leaving.find(entry => entry.mode === "pin"), sink = pinned?.animations.find(item => item.name === "lectern-sink");
    const gone = seen.gone.find(entry => entry.id === pinned?.id), at = ease.styles.findIndex(style => style.transitions.length);
    const [eased] = ease.styles[at]?.transitions ?? [], held = at >= 0 && ease.styles[at + 1] ? ease.styles[at + 1].t - ease.styles[at].t : undefined;
    const start = ease.styles[at]?.t ?? 0, ghost = frames.flatMap(frame => frame.ghosts.filter(item => item.mode === "pin"));
    report[name] = { before, after, pinned: pinned && { top: pinned.top, position: pinned.position, animations: pinned.animations, lasted: gone && gone.t - pinned.t },
      ease, held, ghostTops: ghost.map(item => Math.round(item.top)), maxGap: maxGap(frames),
      // Painted frames (ms after the ease began: height), and how many fell between the two heights.
      dock: frames.map(frame => [Math.round(frame.t - start), Math.round(frame.dock)]).filter(([t]) => t > -100 && t < 600),
      framesEasing: frames.filter(frame => frame.dock < before.dock - 1 && frame.dock > after + 1).length,
      entered: seen.entered.map(entry => entry.el), leaving: seen.leaving.map(entry => [entry.el, entry.mode]) };
    assert.ok(seen.entered.some(entry => entry.parent.startsWith("div.composer-area")), `${name}: it fades in: ${report[name].entered}`);
    assert.ok(pinned, `${name}: it fades out pinned: ${JSON.stringify(report[name].leaving)}`);
    assert.deepEqual(seen.leaving.filter(entry => entry.el.startsWith("article")), [], `${name}: no message left meanwhile`);
    assert.ok(pinned.position === "absolute" && Math.abs(pinned.top - before.top) <= 4, `${name}: out of the flow, where it was (${before.top} → ${pinned.top}, ${pinned.position})`);
    assert.ok(sink?.state === "running" && sink.duration === 180 && sink.to.opacity === "0", `${name}: it fades out there: ${JSON.stringify(pinned.animations)}`);
    assert.ok(gone && gone.t - pinned.t >= 150, `${name}: it stays for its fade, then goes: ${report[name].pinned.lasted}`);
    // The ease: a min-height transition from the old height to the new one (a jump has none), held
    // until the fade is over (FADE_LEAVE_MS + 40, by the clock), then the area lets go at its new height.
    assert.ok(after < before.dock - 1 && eased?.state === "running" && eased.duration === 180 && eased.easing === "ease" &&
      Math.abs(parseFloat(eased.from.minHeight) - before.dock) <= 1 && Math.abs(parseFloat(eased.to.minHeight) - after) <= 1,
      `${name}: the input area eases to its new height: ${before.dock} → ${after}, ${JSON.stringify(ease)}`);
    assert.ok(held >= 180 && ease.styles[at + 1].minHeight === "", `${name}: it holds the ease through the fade (${held} ms), then lets go: ${JSON.stringify(ease.styles)}`);
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
  // The fade itself: each block starts transparent and becomes opaque over 200 ms, the animation it
  // got when it appeared, run to its end. (Opacities in painted frames for the report: a busy runner
  // may paint a fade in only one or two frames.)
  const opacities = new Map();
  for (const frame of frames) for (const { id, opacity } of frame.fading) opacities.set(id, [...opacities.get(id) ?? [], opacity]);
  report.ramps = [...opacities.values()].slice(0, 4);
  const blockFades = blocks.map(entry => entry.animations.find(item => item.name === "lectern-fade-in"));
  report.blockFades = blockFades.map((fade, i) => ({ ...fade, ended: seen.ended.filter(end => end.id === blocks[i].id).map(end => `${end.type} ${end.name} ${end.elapsed}`) }));
  assert.ok(blockFades.every(fade => fade?.state === "running" && fade.duration === 200 && fade.from.opacity === "0" && fade.to.opacity === "1"),
    "each block fades in from transparent: " + JSON.stringify(report.blockFades));
  assert.ok(blocks.some(entry => seen.ended.some(end => end.id === entry.id && end.type === "animationend" && end.name === "lectern-fade-in")),
    "the fade runs to its end: " + JSON.stringify(report.blockFades));
  // Text added to a paragraph already shown fades in as text: each new stretch once, from transparent
  // over 320 ms (the animation it got then); a fade still running when the preview changes again goes
  // on (a negative delay), never from the start; nothing the reply showed before fades again, nothing
  // when the saved reply replaces the preview; no span is left once the fades end.
  let texts = await textFades(), read = readTextFades(texts.spans, HELLO);
  const blockChars = seen.entered.reduce((sum, entry) => sum + entry.chars, 0), freshChars = read.fresh.reduce((sum, span) => sum + span.chars, 0);
  const textEnded = seen.ended.filter(end => end.name === "lectern-text-in" && end.type === "animationend").length;
  report.streamedText = { fresh: read.fresh.map(span => span.text), going: read.going.map(span => `${span.text} ${span.delay}`), blockChars, freshChars,
    total: visibleText(HELLO).length, ended: textEnded, animation: read.fresh[0]?.animations, left: texts.left, refaded: read.refaded, unknown: read.unknown, orphans: read.orphans };
  assert.ok(read.fresh.length >= 3, "text streamed into paragraphs already shown fades in: " + JSON.stringify(report.streamedText.fresh));
  assert.ok(read.fresh.every(({ animations: [fade, ...more] }) => !more.length && fade?.name === "lectern-text-in" && fade.state === "running" && fade.duration === 320 &&
    fade.from.opacity === "0" && fade.to.opacity === "1"), "each from transparent, over 320 ms: " + JSON.stringify(read.fresh.map(span => span.animations)));
  assert.ok(textEnded > 0, "text fades run to their end");
  assert.deepEqual(read.refaded, [], "text the reply showed before never fades in again");
  assert.deepEqual(read.unknown, [], "every fading span is text of the reply, where the recorder found it");
  assert.deepEqual(read.orphans, [], "a fade going on continues one that started earlier, from its own start");
  // Each character came in once: in a block that faded in whole, or in one text fade (a stretch may
  // have come in a block still fading: it does not fade twice).
  assert.ok(freshChars + blockChars <= report.streamedText.total && freshChars + blockChars >= report.streamedText.total - 12, JSON.stringify(report.streamedText));
  assert.deepEqual(texts.spans.filter(span => span.source !== "preview"), [], "the saved reply replacing the preview fades no text in");
  assert.equal(texts.left, 0, "no span is left once the fades end");
  await reset();

  // 5b. Markdown that changes shape as it streams (mock-markdown): `**` closing a frame after it opens,
  // a paragraph "1" becoming a list, a paragraph of pipes becoming a table, an emoji sequence, code.
  // What was shown stays as it is, whatever element holds it now; only new characters fade, in the bold
  // text, list items, cells and code too. Copied while its text fades, the reply gives its text as is.
  await input.fill("mock-markdown 演示");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  // Once the list is there (more text fades into it, the table and the code afterwards).
  await page.locator('.message-assistant[data-source="preview"] .markdown ol > li').last().waitFor();
  const copied = await copyWhileFading();
  await shot("text-fading.png");
  await page.waitForFunction(() => [...document.querySelectorAll(".message-assistant")].at(-1)?.getAttribute("data-source") === "jsonl" &&
    [...document.querySelectorAll(".message-assistant")].at(-1).textContent.includes("最后一句"), null, { timeout: 30000 });
  await settle();
  texts = await textFades();
  read = readTextFades(texts.spans, MARKDOWN);
  const shapes = texts.snaps.filter(snap => snap.source === "preview").map(snap => snap.text);
  report.shapedText = { fresh: read.fresh.map(span => `${span.parent}: ${span.text}`), going: read.going.length, refaded: read.refaded, unknown: read.unknown,
    orphans: read.orphans, shapes: shapes.slice(0, 6), left: texts.left, copied: { ...copied, pieces: copied.pieces.length } };
  assert.ok(shapes.some(text => text.includes("**这段加")) && shapes.at(-1).includes("这段加粗要到后面才闭合") && !shapes.at(-1).includes("*"),
    "the bold text showed with its `**` first, then without: " + JSON.stringify(shapes));
  assert.deepEqual(read.refaded, [], "text shown before does not fade again when the Markdown changes shape");
  assert.deepEqual(read.unknown, [], "every fading span is text of the reply");
  assert.deepEqual(read.orphans, [], "a fade going on continues one that started earlier, from its own start");
  const parents = new Set(read.fresh.map(span => span.parent));
  assert.ok(["strong", "li", "code"].every(tag => parents.has(tag)), "new text fades in bold text, list items and code too: " + JSON.stringify(report.shapedText.fresh));
  assert.deepEqual(texts.spans.filter(span => span.source !== "preview"), [], "the saved reply replacing the preview fades no text in");
  assert.equal(texts.left, 0, "no span is left once the fades end");
  // The copy: the reply's text, every character once (the fading ones too), paragraphs, items, cells and
  // code as they are, and what the reply's Markdown says so far.
  assert.equal(visibleText(copied.clip), visibleText(copied.text), "the copy has the reply's text, every character once: " + JSON.stringify(copied));
  assert.ok(copied.pieces.every(piece => copied.clip.includes(piece)), "paragraphs, items, cells and code copy as they are: " + JSON.stringify(copied));
  assert.ok(copied.clip.includes("这段加粗要到后面才闭合") && copied.clip.includes("第一项"), "the bold text and the list are in it: " + copied.clip);
  assert.ok(subsequence(visibleText(copied.clip), visibleText(MARKDOWN)), "what the reply says so far: " + copied.clip);
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
  // Its text faded in too (only opacity changes: the line being read stayed, above).
  report.reading.textFades = (await textFades()).spans.filter(span => span.delay === 0).map(span => span.text);
  assert.ok(report.reading.textFades.length, "text of the new reply faded in meanwhile");
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
  // Where they were put back and the animation each got then (painted frames may be too few to
  // show the collapse on a busy runner; their heights are in the report).
  const user = seen.leaving.find(entry => entry.el.includes("message-user")), reply = seen.leaving.find(entry => entry.el.includes("message-assistant"));
  assert.ok(user.height > 1 && reply.height > 1 && user.bottom <= reply.top + 1, "they stay in their order: the question above its reply: " + JSON.stringify(seen.leaving));
  const lasted = seen.gone.map(gone => gone.t - seen.leaving.find(entry => entry.id === gone.id).t);
  const heights = frames.flatMap(frame => frame.ghosts.filter(ghost => ghost.mode === "collapse").map(ghost => ghost.height));
  const collapses = seen.leaving.map(entry => entry.animations.find(item => item.name === "lectern-collapse"));
  report.rewound = { lasted, collapses, heights: heights.map(Math.round), maxGap: maxGap(frames) };
  assert.ok(lasted.length === 2 && lasted.every(ms => ms >= 150 && ms < 600), "they stay for the fade, then go: " + lasted);
  assert.ok(collapses.every(fade => fade?.state === "running" && fade.duration === 180 && fade.from.height === "calc-size(auto, size)" && fade.to.height === "0px" && fade.to.opacity === "0"),
    "the height collapses over the fade, from their own: " + JSON.stringify(collapses));
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
  assert.deepEqual((await textFades()).spans, [], "reduced motion: no text fades in");
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
