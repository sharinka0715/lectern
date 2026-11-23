// npm run build && node scripts/composer-focus-e2e.mjs [packaged-executable]
// The input box keeps the keyboard through the moments it cannot be typed into (useComposerFocus).
// Demo mode, offline mock Claude: after a message sent with Enter the box keeps the keyboard, the
// selection and every key typed through the reply's start and end (an Enter meanwhile sends nothing),
// and typing on opens the @ list; IME compositions go on through a reply's end; a focus the user put
// elsewhere (the sidebar filter, a click on the transcript) is not taken; a permission card leaves the
// box the user is typing in (Enter approves nothing), takes the keyboard only from nowhere, and once
// answered gives it to the box, as does a model picked from the box's menu; text typed while a new
// chat starts stays in it; in a split, the other pane's reply and permission card leave this pane's
// box alone; a question card that replaced the box gives it back with its caret.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import { tsImport } from "tsx/esm/api";

const { parseQuestionScreen } = await tsImport("../src/core/question-screen.ts", import.meta.url);
const { scenarios } = JSON.parse(await readFile(new URL("../tests/fixtures/native-contracts/question-2.1.326.json", import.meta.url), "utf8"));
// A short name: the demo's tmux socket lives below it, and macOS allows 104 bytes for a socket path.
const root = await realpath(await mkdtemp(path.join(tmpdir(), "tcfo-")));
const output = path.resolve("test-results", "composer-focus");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Files written into the folder during the run show in the @ list soon.
const env = { ...process.env, LECTERN_LOCALE: "zh-CN", TMPDIR: root, TMUX_TMPDIR: root, LECTERN_FILE_INDEX_TTL_MS: "300",
  LECTERN_USER_DATA: path.join(root, "profile"), LECTERN_NODE_BINARY: process.execPath,
  LECTERN_LOG_DIR: path.join(output, "diagnostics"), LECTERN_DIAGNOSTIC_CONTENT: "0" };
delete env.TMUX; delete env.TMUX_PANE; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const step = name => console.log(`[composer-focus] ${name}`);
let app, page;

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? ["--demo"] : [".", "--demo"], env, ...(executable && { executablePath: path.resolve(executable) }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const pane = view => page.locator(`.desk-pane[data-view="${view}"]`);
  const box = (view = "primary") => pane(view).getByRole("textbox", { name: "发送给 Claude 的消息" });
  const filter = page.getByRole("textbox", { name: "筛选项目和对话" });
  const option = name => page.getByRole("option", { name });
  /** What has the keyboard: a pane's input box by its view, the body, or another element by its label. */
  const focusAt = () => page.evaluate(() => {
    const active = document.activeElement;
    if (active?.matches("form.composer textarea")) return active.closest(".desk-pane").dataset.view;
    return active === document.body ? "body" : active?.getAttribute("aria-label") || active?.textContent.trim().slice(0, 20) || active?.tagName;
  });
  const focusedOn = view => page.waitForFunction(view => document.activeElement?.matches(`.desk-pane[data-view="${view}"] form.composer textarea`), view);
  const selection = (view = "primary") => box(view).evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]);
  const replies = (view = "primary") => pane(view).locator(".message-assistant").count();
  /** A reply after the `before` ones is written to the transcript and the pane's box can be typed into again. */
  const replied = (view, before) => page.waitForFunction(([view, before]) => {
    const shown = document.querySelector(`.desk-pane[data-view="${view}"]`), all = shown.querySelectorAll(".message-assistant");
    return all.length > before && all[all.length - 1].dataset.source === "jsonl" && !shown.querySelector(".interrupt-button")
      && shown.querySelector("form.composer textarea")?.getAttribute("aria-disabled") !== "true";
  }, [view, before], { timeout: 30000 });
  /** The reply is streaming and the box can send (to queue or steer) again after the moment the reply starts. */
  const streaming = async view => {
    await pane(view).locator('.message-assistant[data-source="preview"]').waitFor();
    await page.waitForFunction(view => document.querySelector(`.desk-pane[data-view="${view}"] form.composer textarea`)?.getAttribute("aria-disabled") !== "true", view);
  };
  /** The pane's box cannot send now (a reply starting or ending); it may still be typed into. */
  const cannotSend = view => page.waitForFunction(view =>
    document.querySelector(`.desk-pane[data-view="${view}"] form.composer textarea`)?.getAttribute("aria-disabled") === "true", view);
  /** Records, until read, every moment the pane's box was not focused, read-only, disabled or unable to send. */
  const watchBox = view => page.evaluate(view => {
    const seen = window.__boxWatch = { lost: [], locked: 0, readOnly: 0, disabled: 0 };
    const sample = () => {
      const input = document.querySelector(`.desk-pane[data-view="${view}"] form.composer textarea`);
      if (input?.getAttribute("aria-disabled") === "true") seen.locked++;
      if (input?.readOnly) seen.readOnly++;
      if (input?.disabled) seen.disabled++;
      if (document.activeElement !== input) seen.lost.push(document.activeElement?.tagName ?? "none");
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    let live = true;
    const frame = () => { if (live) { sample(); requestAnimationFrame(frame); } };
    frame();
    seen.stop = () => { live = false; observer.disconnect(); };
  }, view);
  const readWatch = () => page.evaluate(() => { const { stop, ...seen } = window.__boxWatch; stop(); return seen; });

  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  await page.waitForFunction(() => document.querySelector(".session-row.active")?.dataset.status === "idle"
    && document.querySelector("form.composer textarea")?.getAttribute("aria-disabled") !== "true", null, { timeout: 30000 });
  const { id: workspaceId, cwd } = await page.evaluate(async () => (await window.desktop.listWorkspaces())[0]);
  await writeFile(path.join(cwd, "notes.md"), "# 笔记\n");
  const firstChat = await page.locator(".session-row.active").getAttribute("data-session-id");
  const input = box();

  step("sent with Enter: the box keeps the keyboard and every key typed through the reply's start and end; nothing more is sent");
  await input.click();
  await input.pressSequentially("你好");
  let before = await replies("primary");
  const asked = await pane("primary").locator(".message-user").count();
  await watchBox("primary");
  await page.keyboard.press("Enter");
  // Straight on, as the reply starts (nothing can be sent for a moment then).
  await page.keyboard.type("继续");
  await streaming("primary");
  await page.keyboard.type("写");
  // The reply ends: for about a second nothing can be sent; typing goes on, Enter sends nothing.
  await cannotSend("primary");
  await page.keyboard.press("Enter");
  await page.keyboard.type("完");
  await input.evaluate(el => el.setSelectionRange(1, 3, "backward"));
  await replied("primary", before);
  const watched = await readWatch();
  assert.deepEqual(watched.lost, [], "the box never lost the keyboard");
  assert.ok(watched.locked > 0, `nothing could be sent for a moment (${JSON.stringify(watched)})`);
  assert.deepEqual([watched.disabled, watched.readOnly], [0, 0], "never disabled or read-only under the user");
  assert.equal(await input.inputValue(), "继续写完", "every key typed is in the box");
  assert.deepEqual(await selection(), [1, 3, "backward"], "the selection as it was");
  await page.waitForTimeout(500);
  assert.equal(await pane("primary").locator(".message-user").count(), asked + 1, "the Enter pressed meanwhile sent nothing");
  // Typing on, without clicking the box first: it goes in, and `@` opens the list of the folder's files.
  await page.keyboard.press("End");
  await page.keyboard.type(" @notes");
  await option(/notes\.md/).waitFor();
  assert.equal(await input.inputValue(), "继续写完 @notes");
  await page.keyboard.press("Escape");
  await input.fill("");

  step("an IME composition goes on through the reply's end, and one begun while nothing can be sent works too");
  const cdp = await page.context().newCDPSession(page);
  await input.evaluate(el => {
    const seen = window.__ime = { start: 0, end: 0 };
    el.addEventListener("compositionstart", () => seen.start++);
    el.addEventListener("compositionend", () => seen.end++);
  });
  await page.keyboard.type("再来一段");
  before = await replies("primary");
  await page.keyboard.press("Enter");
  await streaming("primary");
  await cdp.send("Input.imeSetComposition", { text: "zai", selectionStart: 3, selectionEnd: 3 });
  await cannotSend("primary");
  assert.deepEqual(await input.evaluate(el => [el.readOnly, el.disabled, document.activeElement === el]), [false, false, true]);
  assert.equal(await input.isDisabled(), true, "Playwright reads aria-disabled as disabled too");
  await cdp.send("Input.imeSetComposition", { text: "zaijian", selectionStart: 7, selectionEnd: 7 });
  await cdp.send("Input.insertText", { text: "再见" });
  await cdp.send("Input.imeSetComposition", { text: "ma", selectionStart: 2, selectionEnd: 2 });
  assert.equal(await input.getAttribute("aria-disabled"), "true", "begun while nothing could be sent");
  await replied("primary", before);
  assert.deepEqual(await page.evaluate(() => window.__ime), { start: 2, end: 1 }, "the second composition is still open");
  await cdp.send("Input.insertText", { text: "吗" });
  assert.deepEqual(await page.evaluate(() => window.__ime), { start: 2, end: 2 });
  assert.equal(await input.inputValue(), "再见吗");
  assert.equal(await focusAt(), "primary");
  await input.fill("");

  step("a focus the user put elsewhere stays there when the reply ends");
  await page.keyboard.type("第三条");
  before = await replies("primary");
  await page.keyboard.press("Enter");
  await streaming("primary");
  await filter.click();
  await page.keyboard.type("zz");
  await replied("primary", before);
  await page.waitForTimeout(300);
  assert.equal(await focusAt(), "筛选项目和对话", "still in the sidebar filter");
  assert.equal(await filter.inputValue(), "zz");
  await filter.press("Escape");
  // A click on the transcript's text (its scroll region takes the focus) is the user's choice too.
  await input.click();
  await page.keyboard.type("第四条");
  before = await replies("primary");
  await page.keyboard.press("Enter");
  await streaming("primary");
  await pane("primary").locator(".message-assistant .markdown p").first().click();
  assert.equal(await focusAt(), "会话消息");
  await replied("primary", before);
  await page.waitForTimeout(300);
  assert.equal(await focusAt(), "会话消息", "the reply's end leaves the focus in the transcript");

  step("a permission card leaves the box the user is typing in: an Enter there approves nothing");
  await input.click();
  await page.keyboard.type("运行标记命令 permission-late:600000");
  await page.keyboard.press("Enter");
  const card = pane("primary").locator("section.permission-card");
  await card.waitFor();
  await page.keyboard.type("先别");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  assert.equal(await focusAt(), "primary", "the card did not take the keyboard");
  assert.equal(await input.inputValue(), "先别", "nothing can be sent while the card waits: the text stays");
  assert.equal(await card.count(), 1, "and the card is not answered");
  assert.equal(existsSync(path.join(cwd, "allowed.txt")), false, "the command did not run");
  // Answered with the mouse, it hands the keyboard back to the box.
  await card.locator('[data-permission-option="1"]').click();
  await card.waitFor({ state: "detached" });
  await pane("primary").locator(".message-assistant").filter({ hasText: "已允许并运行" }).waitFor();
  await focusedOn("primary");
  assert.equal(await input.inputValue(), "先别");
  await page.keyboard.type(" @notes");
  await option(/notes\.md/).waitFor();
  await page.keyboard.press("Escape");
  await input.fill("");
  // Nothing has the keyboard (the sidebar filter let it go): a card takes it, and a digit answers it.
  await filter.click();
  await filter.press("Escape");
  assert.equal(await focusAt(), "body");
  await page.evaluate(([workspaceId, sessionId]) => window.desktop.sendMessage(workspaceId, sessionId, "再运行一次 permission-late:600000"), [workspaceId, firstChat]);
  await card.waitFor();
  await page.waitForFunction(() => document.activeElement?.closest("section.permission-card"));
  await page.keyboard.press("1");
  await card.waitFor({ state: "detached" });
  await focusedOn("primary");

  step("a model picked from the box's menu: the keyboard is back in the box once the switch is done");
  const modelButton = pane("primary").locator('button[data-setting-kind="model"]');
  await modelButton.click();
  const menu = pane("primary").locator('[data-setting-menu="model"]');
  await menu.getByRole("option").filter({ hasText: "Fixture Beta" }).click();
  await menu.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector(".desk-pane[data-view='primary'] button[data-setting-kind='model']")?.textContent.includes("Fixture Beta"));
  await focusedOn("primary");
  await page.keyboard.type("换好了");
  assert.equal(await input.inputValue(), "换好了");
  await input.fill("");

  step("a new chat's first message: what is typed while the chat starts stays in its box");
  await page.getByRole("button", { name: /^新建对话/ }).first().click();
  await page.waitForFunction(() => document.querySelector(".draft-settings")
    && document.querySelector("form.composer textarea")?.getAttribute("aria-disabled") !== "true");
  await input.fill("你好");
  await page.keyboard.press("Enter");
  await page.keyboard.type("顺手写下");
  await page.waitForFunction(first => {
    const row = document.querySelector(".session-row.active");
    return row && row.dataset.sessionId !== first && row.dataset.sessionLive === "true";
  }, firstChat, { timeout: 30000 });
  const secondChat = await page.locator(".session-row.active").getAttribute("data-session-id");
  await replied("primary", 0);
  assert.equal(await focusAt(), "primary");
  assert.equal(await input.inputValue(), "顺手写下", "kept, and moved with the chat it started");
  assert.equal(await pane("primary").locator(".message-user").count(), 1, "only the first message was sent");
  await input.fill("");

  step("split: the other pane's reply and permission card leave this pane's box alone");
  await page.locator(`.session-row[data-session-id="${firstChat}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "在旁边分屏打开" }).click();
  await pane("secondary").locator(".message-assistant").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".desk-pane[data-view='secondary'] form.composer textarea")?.getAttribute("aria-disabled") !== "true");
  // The user writes on the left while the conversation on the right (sent from elsewhere) replies.
  await box("primary").click();
  await page.keyboard.type("左边在写");
  before = await replies("secondary");
  await page.evaluate(([workspaceId, sessionId]) => window.desktop.sendMessage(workspaceId, sessionId, "右边的消息"), [workspaceId, firstChat]);
  await replied("secondary", before);
  await page.waitForTimeout(300);
  assert.equal(await focusAt(), "primary", "the right pane's reply does not take the keyboard");
  // Its permission card does not either: a digit typed on the left stays on the left.
  await page.evaluate(([workspaceId, sessionId]) => window.desktop.sendMessage(workspaceId, sessionId, "运行 permission-late:600000"), [workspaceId, firstChat]);
  const rightCard = pane("secondary").locator("section.permission-card");
  await rightCard.waitFor();
  await page.waitForTimeout(300);
  assert.equal(await focusAt(), "primary", "the right pane's card does not take the keyboard");
  await page.keyboard.type("1");
  assert.equal(await box("primary").inputValue(), "左边在写1");
  assert.equal(await rightCard.count(), 1, "the card is still waiting");
  // Answered with a click, it hands the keyboard to its own pane's box.
  await rightCard.locator('[data-permission-option="1"]').click();
  await rightCard.waitFor({ state: "detached" });
  await focusedOn("secondary");

  step("a question card that replaced the box gives it back with its caret, unless the user went elsewhere");
  // The left pane's conversation now shows recorded snapshots only (as in question-ui-e2e).
  const base = await page.evaluate(async ([workspaceId, sessionId]) => {
    const snapshot = await window.desktop.watchSession(workspaceId, sessionId, "primary");
    await window.desktop.unwatchSession("primary");
    return snapshot;
  }, [workspaceId, secondChat]);
  const viewport = scenarios.single.screens.start, screen = parseQuestionScreen(viewport);
  assert.ok(screen, "the question fixture parses");
  const publish = snapshot => app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send("lectern:snapshot", snapshot), snapshot);
  const questionCard = pane("primary").locator("section.question-card");
  const ask = async token => {
    await publish({ ...base, status: "waiting", navigationStatus: "waiting", viewport, screen: viewport, question: { ...screen, interactionId: token, token } });
    await questionCard.waitFor();
  };
  await publish(base);
  await page.waitForFunction(() => document.querySelector(".desk-pane[data-view='primary'] form.composer textarea")?.getAttribute("aria-disabled") !== "true");
  await box("primary").fill("先看问题再说");
  await box("primary").evaluate(el => el.setSelectionRange(1, 3));
  // [1, 3, "forward"]; macOS has no selection direction by default: "none" there.
  const caret = await selection();
  await ask("q-1");
  assert.equal(await box("primary").count(), 0, "the card stands in for the box");
  await publish(base);
  await questionCard.waitFor({ state: "detached" });
  await focusedOn("primary");
  assert.equal(await box("primary").inputValue(), "先看问题再说");
  assert.deepEqual(await selection(), caret, "the caret and selection as they were");
  await ask("q-2");
  await filter.click();
  await page.keyboard.type("yy");
  await publish(base);
  await questionCard.waitFor({ state: "detached" });
  await page.waitForTimeout(300);
  assert.equal(await focusAt(), "筛选项目和对话", "the sidebar filter keeps the keyboard");
  assert.equal(await filter.inputValue(), "yy");
  await filter.press("Escape");

  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, "final.png") });
  console.log("PASS: the input box keeps the keyboard and every key typed (IME too) while nothing can be sent, sends nothing meanwhile, is not robbed by a permission card, gets the keyboard back from cards and the model menu, and never takes it from elsewhere or from the other split pane.");
} catch (error) {
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
