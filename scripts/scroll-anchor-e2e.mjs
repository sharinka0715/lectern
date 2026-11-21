// npm run build && node scripts/scroll-anchor-e2e.mjs [packaged-executable]
// The conversation keeps its latest message in view (and, while reading older
// messages, the line at the bottom edge) when the window, zoom, input box or
// content changes size. Demo mode: no real model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright";

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
/** The text line at the bottom edge of the visible conversation, and how far above the edge it is. */
const bottomLine = () => page.evaluate(() => {
  const v = document.querySelector(".conversation-scroll"), box = v.getBoundingClientRect();
  const paragraphs = [...v.querySelectorAll(".message")].filter(el => el.getBoundingClientRect().top < box.bottom - 40);
  const el = paragraphs.at(-1);
  return { text: el.textContent.slice(0, 12), offset: box.bottom - el.getBoundingClientRect().top };
});

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? ["--demo"] : [".", "--demo"], env, ...(executable && { executablePath: path.resolve(executable) }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await resize(1320, 840);
  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  const archiveId = await seedArchive();
  await page.locator('.session-row[data-session-id="' + archiveId + '"]').click();
  await page.getByText("问题 39", { exact: true }).waitFor();
  await atLatest("opened");

  await resize(1320, 560);
  await atLatest("shorter window");
  await resize(900, 560);
  await atLatest("narrower window");
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
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.disabled, null, { timeout: 30000 });
  await atLatest("resumed");
  const before = await page.evaluate(() => document.querySelector(".conversation-scroll").clientHeight);
  await input.fill(Array.from({ length: 8 }, (_, i) => "第 " + (i + 1) + " 行").join("\n"));
  await page.waitForFunction(height => document.querySelector(".conversation-scroll").clientHeight < height - 60, before);
  await atLatest("taller input box");
  await input.fill("");
  await atLatest("input box back");

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
