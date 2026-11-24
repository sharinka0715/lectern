// npm run build && node scripts/scroll-anchor-e2e.mjs [packaged-executable]
// The conversation keeps its latest message in view (and, while reading older
// messages, the line at the bottom edge) when the window, zoom, input box or
// content changes size. Its scrollbar runs to the bottom of the chat, under the
// input area floating there, and a wheel over that area scrolls the chat.
// Demo mode: no real model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, resizeWindow } from "./fixtures/electron.mjs";
import { refreshFolderUntil } from "./fixtures/sidebar-refresh.mjs";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "tsa-")));
const output = path.resolve("test-results", "scroll-anchor-" + Date.now());
await mkdir(output, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', TMPDIR: root, TMUX_TMPDIR: root,
  LECTERN_USER_DATA: path.join(root, "profile"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: path.join(output, "diagnostics"), LECTERN_DIAGNOSTIC_CONTENT: "0" };
delete env.TMUX; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app, page;
const report = {};

async function seedArchive() {
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  const project = path.join(workspace.claudeDir, "projects", workspace.cwd.replace(/[^a-z0-9-]/gi, "-"));
  const sessionId = randomUUID(), lines = [];
  let parentUuid = null;
  for (let i = 0; i < 40; i++) {
    for (const role of ["user", "assistant"]) {
      const uuid = randomUUID();
      // Long replies reflow when the window gets narrower.
      const text = role === "user" ? "问题 " + i : `回复 ${i}：` + "这一段文字足够长，窗口变窄时会折成更多行。".repeat(6 + (i % 4));
      const message = role === "user" ? { role, content: text } : { role, id: uuid, content: [{ type: "text", text }], stop_reason: "end_turn" };
      lines.push(JSON.stringify({ type: role, uuid, parentUuid, sessionId, cwd: workspace.cwd,
        timestamp: new Date(1700000000000 + lines.length * 1000).toISOString(), message }));
      parentUuid = uuid;
    }
  }
  await writeFile(path.join(project, sessionId + ".jsonl"), lines.join("\n") + "\n", { flag: "wx" });
  return sessionId;
}

const resize = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120)))));
const gap = () => page.evaluate(() => { const v = document.querySelector(".conversation-scroll"); return v.scrollHeight - v.scrollTop - v.clientHeight; });
async function atLatest(step) {
  await settle();
  const value = await gap();
  report[step] = value;
  assert.ok(value <= 2, `${step}: the latest message stays in view (${value}px below)`);
  assert.equal(await page.getByRole("button", { name: "滚动到最新消息", exact: true }).count(), 0, `${step}: still following the latest message`);
}
/** The text line at the bottom edge of the visible conversation (the top of
 * the input area floating over it), and how far above the edge it is. */
const bottomLine = () => page.evaluate(() => {
  const v = document.querySelector(".conversation-scroll"), bottom = document.querySelector(".composer-area").getBoundingClientRect().top;
  const paragraphs = [...v.querySelectorAll(".message")].filter(el => el.getBoundingClientRect().top < bottom - 40);
  const el = paragraphs.at(-1);
  return { text: el.textContent.slice(0, 12), offset: bottom - el.getBoundingClientRect().top };
});
const dockTop = () => page.evaluate(() => document.querySelector(".composer-area").getBoundingClientRect().top);
/** At the latest message the scrollbar runs to the bottom of the chat column,
 * under the input area, and the last message ends above the input area. */
async function docked(step, screenshot) {
  await atLatest(step);
  const m = await page.evaluate(() => {
    const v = document.querySelector(".conversation-scroll"), box = v.getBoundingClientRect();
    const column = v.closest(".main-area").getBoundingClientRect();
    const dock = document.querySelector(".composer-area").getBoundingClientRect();
    const last = [...v.querySelectorAll(".message")].at(-1).getBoundingClientRect();
    const probe = document.elementFromPoint(last.left + 20, last.bottom - 8);
    return { scrollBottom: box.bottom, columnBottom: column.bottom, scrollRight: box.right, scrollbar: v.offsetWidth - v.clientWidth,
      end: v.scrollTop + v.clientHeight - v.scrollHeight, dockTop: dock.top, dockBottom: dock.bottom, dockRight: dock.right,
      lastTop: last.top, lastBottom: last.bottom, top: box.top, lastShown: !!probe?.closest(".message") };
  });
  report[step + " (docked)"] = m;
  assert.ok(Math.abs(m.scrollBottom - m.columnBottom) <= 1, `${step}: the scroll area (and its scrollbar) reaches the bottom of the chat column`);
  assert.ok(m.scrollbar > 0 && m.dockRight <= m.scrollRight - m.scrollbar, `${step}: the input area leaves the scrollbar uncovered`);
  assert.ok(Math.abs(m.dockBottom - m.columnBottom) <= 1, `${step}: the input area sits at the bottom`);
  assert.ok(Math.abs(m.end) <= 1, `${step}: scrolled to the end (${m.end})`);
  // Just above the input area (the message's margin and the end spacer between),
  // and whole unless it and that space are taller than the visible conversation.
  assert.ok(m.lastBottom <= m.dockTop + 0.5 && m.dockTop - m.lastBottom <= 48 && m.lastShown, `${step}: the last message ends above the input area`);
  if (m.dockTop - m.top >= m.lastBottom - m.lastTop + 48) assert.ok(m.lastTop >= m.top, `${step}: the last message is whole`);
  if (screenshot) await page.screenshot({ path: path.join(output, screenshot) });
}

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? ["--demo"] : [".", "--demo"], env, ...(executable && { executablePath: path.resolve(executable) }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await resizeWindow(app, page, 1320, 840);
  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  const archiveId = await seedArchive();
  await refreshFolderUntil(page, "demo-local", page.locator('.session-row[data-session-id="' + archiveId + '"]'));
  await page.locator('.session-row[data-session-id="' + archiveId + '"]').click();
  await page.getByText("问题 39", { exact: true }).waitFor();
  await docked("opened", "bottom-wide.png");

  await resize(1320, 560);
  await atLatest("shorter window");
  await resize(900, 560);
  await docked("narrower window", "bottom-narrow.png");
  await resize(1320, 840);
  await atLatest("larger window");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.3));
  await atLatest("zoomed in");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await atLatest("zoomed back");
  // Content that grows after it is shown (an image loading, a block expanding).
  await page.evaluate(() => { document.querySelector(".conversation-end").style.height = "260px"; });
  await atLatest("content grew");
  await page.evaluate(() => { document.querySelector(".conversation-end").style.height = ""; });
  await atLatest("content shrank");
  // A scroll nobody asked for (the browser restoring an offset) is undone.
  await page.evaluate(() => { const v = document.querySelector(".conversation-scroll"); v.scrollTop = 0; });
  await atLatest("unrequested scroll");

  // A taller input box pushes the conversation up, not over its last lines.
  await page.getByRole("button", { name: "续接会话", exact: true }).click();
  const input = page.getByRole("textbox", { name: "发送给 Claude 的消息" });
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.matches(':disabled, [aria-disabled="true"]'), null, { timeout: 30000 });
  await atLatest("resumed");
  await docked("resumed");
  const before = await dockTop();
  await input.fill(Array.from({ length: 8 }, (_, i) => "第 " + (i + 1) + " 行").join("\n"));
  await page.waitForFunction(top => document.querySelector(".composer-area").getBoundingClientRect().top < top - 60, before);
  await docked("taller input box", "bottom-taller-input.png");
  await input.fill("");
  await docked("input box back");

  // A wheel over the input area scrolls the conversation; over a draft that
  // scrolls by itself it scrolls the draft.
  const scrollTop = () => page.evaluate(() => document.querySelector(".conversation-scroll").scrollTop);
  const latestTop = await scrollTop();
  await page.locator(".composer-footnote").hover();
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(top => document.querySelector(".conversation-scroll").scrollTop <= top - 290, latestTop);
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).waitFor();
  const jump = await page.evaluate(() => [document.querySelector(".scroll-latest").getBoundingClientRect().bottom,
    document.querySelector(".composer-area").getBoundingClientRect().top]);
  assert.ok(jump[0] <= jump[1], `the jump button sits above the input area (${jump})`);
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).click();
  await atLatest("wheel over the input area, back");
  await input.fill(Array.from({ length: 30 }, (_, i) => "草稿 " + (i + 1)).join("\n"));
  await settle();
  await input.hover();
  const draftTop = await input.evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
  assert.ok(draftTop > 0, "the long draft scrolls inside the input box");
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(top => document.querySelector(".composer textarea").scrollTop < top, draftTop);
  await atLatest("wheel over a long draft");
  await input.fill("");
  await atLatest("long draft cleared");

  // Reading older messages: the line at the bottom edge stays where it was.
  // The reader's own scroll (a wheel event first; other scrolls keep the latest message).
  await page.evaluate(() => {
    const v = document.querySelector(".conversation-scroll");
    v.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 0 }));
    v.scrollTop = v.scrollHeight / 2;
  });
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).waitFor();
  await settle();
  const reading = await bottomLine();
  await page.screenshot({ path: path.join(output, "reading-under-input.png") });
  // Messages pass under the input area, which covers them (opaque, above them).
  const covered = await page.evaluate(() => {
    const dock = document.querySelector(".composer-area").getBoundingClientRect();
    const under = [...document.querySelectorAll(".conversation-scroll .message")].some(el => {
      const box = el.getBoundingClientRect();
      return box.top < dock.bottom - 20 && box.bottom > dock.top + 20;
    });
    const hit = [dock.top + 6, (dock.top + dock.bottom) / 2, dock.bottom - 4]
      .map(y => !!document.elementFromPoint((dock.left + dock.right) / 2, y)?.closest(".composer-area"));
    return { under, hit, background: getComputedStyle(document.querySelector(".composer-area")).backgroundImage };
  });
  report.covered = covered;
  assert.ok(covered.under && covered.hit.every(Boolean) && covered.background.includes("gradient"), "the input area covers the messages under it");
  await resize(1320, 600);
  await settle();
  const after = await bottomLine();
  report.reading = { before: reading, after };
  assert.equal(after.text, reading.text, "the message at the bottom edge stays at the bottom edge");
  assert.ok(Math.abs(after.offset - reading.offset) <= 4, `it does not move (${reading.offset} → ${after.offset})`);
  await input.fill("一\n二\n三\n四\n五\n六");
  await settle();
  const typed = await bottomLine();
  assert.equal(typed.text, reading.text, "a taller input box does not cover the line being read");
  assert.ok(Math.abs(typed.offset - reading.offset) <= 4, `${reading.offset} → ${typed.offset}`);
  await input.fill("");
  await page.getByRole("button", { name: "滚动到最新消息", exact: true }).click();
  await atLatest("back to latest");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, "done.png") });
  console.log(JSON.stringify({ success: true, report, output }));
} catch (error) {
  console.error(JSON.stringify({ report }));
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
