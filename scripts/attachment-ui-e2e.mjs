// npm run build && node scripts/attachment-ui-e2e.mjs [packaged-executable]
// Files dropped onto or pasted into a chat become @-mentions where the caret is, shown
// as chips in the text and cards above it: a file from disk by its own path (Claude
// Code runs on this computer), clipboard data after it is copied into the machine's
// temporary directory as image1.png. A file's card opens the preview. The keypad Enter
// sends; the message keeps the files where its text names them, as chips that copy as
// their @-paths, its image also in a row above. (Chips themselves: composer-chips-e2e.)
// Demo mode: no real model. (SSH uploads: tests/ssh.test.ts over real OpenSSH.)
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { _electron } from "./fixtures/electron.mjs";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "tat-")));
const output = path.resolve("test-results", "attachment-ui-" + Date.now());
await mkdir(output, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', TMPDIR: root, TMUX_TMPDIR: root,
  LECTERN_USER_DATA: path.join(root, "profile"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: path.join(output, "diagnostics"), LECTERN_DIAGNOSTIC_CONTENT: "0" };
delete env.TMUX; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const uploads = path.join(root, `lectern-attachments-${process.getuid()}`);
let png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const primary = process.platform === "darwin" ? "Meta" : "Control";
let app, page;

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? ["--demo"] : [".", "--demo"], env, ...(executable && { executablePath: path.resolve(executable) }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const input = page.getByRole("textbox", { name: "发送给 Claude 的消息" });
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  /** Selects all of an element's text and copies it, as a user would. */
  const copyAll = async locator => {
    await locator.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); getSelection().removeAllRanges(); getSelection().addRange(range); });
    await page.keyboard.press(`${primary}+C`);
    return clipboard();
  };
  // An inserted @-mention puts the caret in place on the next frame; let that land before
  // replacing the text, or it collapses the selection fill() made and the old text stays.
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.matches(':disabled, [aria-disabled="true"]'), null, { timeout: 30000 });
  // A screenshot-like picture to paste: a window with a title bar and a few lines.
  png = Buffer.from(await page.evaluate(() => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 400 });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e8eef8"; ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = "#345cad"; ctx.fillRect(0, 0, 640, 56);
    ctx.fillStyle = "#b65a38"; ctx.fillRect(40, 96, 260, 24);
    ctx.fillStyle = "#9aa7bd"; for (let y = 150; y < 360; y += 40) ctx.fillRect(40, y, 560 - (y % 3) * 60, 16);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");

  // Spreadsheet cells carry a picture of themselves too: that paste stays text.
  await settled();
  await input.fill("");
  const handled = await input.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.setData("text/plain", "A1\tB1");
    data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, [...png]);
  assert.equal(handled, false);
  await page.waitForTimeout(500);
  await assert.rejects(readdir(uploads), "nothing was uploaded");

  // Shift + either Enter starts a new line instead of sending, also when an
  // input method reports the keypad Enter as its own key (229).
  await input.fill("第一行");
  await input.press("Shift+NumpadEnter");
  await input.pressSequentially("第二行");
  await input.press("Shift+Enter");
  await input.pressSequentially("第三行");
  await input.evaluate(element => {
    const event = new KeyboardEvent("keydown", { key: "Process", code: "NumpadEnter", shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    element.dispatchEvent(event);
  });
  assert.equal(await input.inputValue(), "第一行\n第二行\n第三行\n");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".message-user").filter({ hasText: "第一行" }).count(), 0, "Shift + Enter does not send");

  // The message to send: its text first, the files then go where the caret is (after it).
  await input.fill("小键盘发送一");
  // A file from disk, dropped on the chat: mentioned by its own path, quoted for the space.
  const document1 = path.join(root, "资料 1.txt");
  await writeFile(document1, "从磁盘拖入\n");
  const picker = await page.evaluateHandle(() => {
    const element = document.createElement("input");
    element.type = "file"; element.hidden = true; document.body.append(element);
    return element;
  });
  await picker.asElement().setInputFiles(document1);
  const dropped = await page.evaluateHandle(element => { const data = new DataTransfer(); data.items.add(element.files[0]); return data; }, picker);
  await page.dispatchEvent(".main-area", "dragenter", { dataTransfer: dropped });
  await page.locator(".composer.composer-drop").waitFor();
  assert.equal(await page.locator(".composer").getAttribute("data-drop-hint"), "松开以引用文件");
  await page.dispatchEvent(".main-area", "drop", { dataTransfer: dropped });
  // A card in the input box (full path on hover), and a chip instead of the path in the text.
  const cards = page.locator(".composer-attachments [data-attachment-card]");
  const cardCount = n => page.waitForFunction(n => document.querySelectorAll(".composer-attachments [data-attachment-card]").length === n, n);
  const chipNames = () => page.locator(".composer-chip-face").evaluateAll(nodes => nodes.map(node => node.dataset.chipLabel));
  await cardCount(1);
  // The text keeps a chip for it where the caret was, named like the file.
  assert.deepEqual(await chipNames(), ["资料 1.txt"]);
  assert.deepEqual([await cards.first().getAttribute("data-tip"), await cards.first().getAttribute("data-tip-detail"), await cards.first().getAttribute("data-attachment-card")],
    ["资料 1.txt", document1, "file"]);
  assert.match(await cards.first().innerText(), /资料 1\.txt\s+TXT/);
  assert.equal(await page.locator(".composer.composer-drop").count(), 0);
  await assert.rejects(readdir(uploads), "a file from disk is not copied anywhere");

  // The "+" button opens the system file dialog; the chosen file is added the same way.
  const document2 = path.join(root, "notes.md");
  await writeFile(document2, "# 选择的文件\n");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "添加文件", exact: true }).click()]);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(document2);
  await cardCount(2);
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.tip)), ["资料 1.txt", "notes.md"]);
  await assert.rejects(readdir(uploads), "a chosen file from disk is not copied either");
  // A file's card opens it in the preview.
  await cards.nth(1).getByRole("button", { name: `打开 ${document2}` }).click();
  const drawer = page.getByRole("complementary", { name: "文件预览" });
  await drawer.getByText("选择的文件").waitFor();
  await drawer.getByRole("button", { name: "关闭文件预览" }).click();
  await drawer.waitFor({ state: "detached" });
  // Each card can be taken out again (its remove badge shows on hover).
  await cards.first().hover();
  await page.getByRole("button", { name: "移除 资料 1.txt", exact: true }).click();
  await cardCount(1);
  assert.equal(await cards.first().getAttribute("data-tip"), "notes.md");
  assert.deepEqual(await chipNames(), ["notes.md"], "its chip left the text with it");

  // A screenshot from the clipboard has no path: it is copied to the temporary directory,
  // shown meanwhile as an uploading card, then as its own thumbnail.
  await settled();
  await page.evaluate(() => {
    window.uploadingSeen = 0;
    new MutationObserver(() => { window.uploadingSeen = Math.max(window.uploadingSeen, document.querySelectorAll('.composer-attachments [data-state="uploading"]').length); })
      .observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await input.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  await cardCount(2);
  await page.waitForFunction(() => !document.querySelector('.composer-attachments [data-state="uploading"]'));
  assert.equal(await page.evaluate(() => window.uploadingSeen), 1, "the upload showed as one uploading card");
  assert.deepEqual(await chipNames(), ["notes.md", "image1.png"], "the screenshot is named image1.png, its chip after the file's");
  const shot = cards.nth(1);
  assert.deepEqual([await shot.getAttribute("data-attachment-card"), await shot.getAttribute("data-thumbnail"), await shot.getAttribute("data-tip")],
    ["image", "image", "image1.png"]);
  const pasted = await shot.getAttribute("data-tip-detail");
  assert.ok(pasted?.startsWith(uploads + "/") && pasted.endsWith("/image1.png"), pasted);
  assert.deepEqual(await readFile(pasted), png);
  await page.locator(".composer").screenshot({ path: path.join(output, "composer-cards.png") });

  // The keypad Enter sends, also when an input method reports it as its own key (229).
  await page.locator(".send-button:not([disabled])").waitFor({ timeout: 30000 });
  await input.press("NumpadEnter");
  await page.locator(".message-user").filter({ hasText: "小键盘发送一" }).waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').value);
  assert.equal(await page.locator(".composer-attachments").count(), 0, "the cards went out with the message");
  // Claude Code got the text with the files as @-mentions where their chips were (after it).
  const { transcript, sessionId, cwd } = await page.evaluate(async () => {
    const [ws] = await window.desktop.listWorkspaces();
    const [session] = (await window.desktop.discover(ws.id)).sessions;
    return { transcript: session.path, sessionId: session.id, cwd: ws.cwd };
  });
  const prompts = async () => (await readFile(transcript, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === "user").map(row => row.message.content[0]?.text ?? "");
  for (let i = 0; i < 100 && !(await prompts()).some(text => text.startsWith("小键盘发送一")); i++) await page.waitForTimeout(100);
  const prompt = (await prompts()).find(text => text.startsWith("小键盘发送一"));
  assert.equal(prompt?.trim(), `小键盘发送一 @${document2} @${pasted}`, JSON.stringify(await prompts()));
  // The bubble, once the transcript has the files: each stays where the text names it, as a chip
  // named like the file (copied as its @-path); the image is also a thumbnail in the row above.
  const sent = page.locator('.message-user[data-source="jsonl"]').filter({ hasText: "小键盘发送一" });
  await sent.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.message-user[data-source="jsonl"] [data-attachment-chip]').length === 2);
  const bubbleChips = sent.locator("[data-attachment-chip]");
  assert.deepEqual(await bubbleChips.evaluateAll(nodes => nodes.map(node => [node.dataset.attachmentChip, node.dataset.mention])),
    [["notes.md", `@${document2}`], ["image1.png", `@${pasted}`]]);
  const bubbleCards = sent.locator(".attachment-cards [data-attachment-card]");
  assert.deepEqual(await bubbleCards.evaluateAll(nodes => nodes.map(node => [node.dataset.attachmentCard, node.dataset.thumbnail ?? null])), [["image", "image"]],
    "the named file is not repeated as a card");
  assert.equal(await sent.locator(".artifact-attachments").count(), 0);
  assert.equal(await sent.getByText(/^查看 /).count(), 0);
  assert.equal((await copyAll(sent.locator(".user-text"))).trim(), `小键盘发送一 @${document2} @${pasted}`, "copied, the chips are their @-paths");
  await page.evaluate(() => getSelection().removeAllRanges());
  await sent.locator(".message-content").screenshot({ path: path.join(output, "bubble-cards.png") });
  // The image's thumbnail and its chip enlarge it to the original; the file's chip opens the preview.
  for (const zoomIn of [bubbleCards.first().getByRole("button"), sent.locator('[data-attachment-chip="image1.png"]').getByRole("button")]) {
    await zoomIn.click();
    const zoom = page.getByRole("dialog", { name: "图片预览 · image1.png" });
    assert.equal(await zoom.getByRole("img", { name: "image1.png", exact: true }).evaluate(async img => { await img.decode(); return img.naturalWidth; }), 640);
    await zoom.getByRole("button", { name: "关闭图片预览" }).click();
    await zoom.waitFor({ state: "detached" });
  }
  await sent.locator('[data-attachment-chip="notes.md"]').click();
  await drawer.getByText("选择的文件").waitFor();
  await drawer.getByRole("button", { name: "关闭文件预览" }).click();
  // The reply finishes first: the stop button turns back into the send button.
  await page.locator(".send-button").waitFor({ timeout: 30000 });
  await input.fill("小键盘发送二");
  await page.locator(".send-button:not([disabled])").waitFor({ timeout: 30000 });
  await input.evaluate(element => {
    const event = new KeyboardEvent("keydown", { key: "Process", code: "NumpadEnter", bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    element.dispatchEvent(event);
  });
  await page.locator(".message-user").filter({ hasText: "小键盘发送二" }).waitFor({ timeout: 30000 }).catch(async error => {
    console.error("DEBUG", JSON.stringify(await page.evaluate(() => ({
      value: document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').value,
      users: [...document.querySelectorAll(".message-user")].map(el => el.textContent.slice(0, 40)),
      toast: document.querySelector(".toast, [role=status]")?.textContent, send: !!document.querySelector(".send-button"),
      status: document.querySelector(".connection-status")?.textContent, placeholder: document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').placeholder,
    }))));
    throw error;
  });
  // An older message that named the files inside its text (recorded by the transcript):
  // compact chips there with the full path on hover, and no second copy below.
  await page.locator(".send-button").waitFor({ timeout: 30000 });
  // The fixture writes its reply in two parts: append only after the whole line is there.
  const replied = text => text.endsWith("\n") && text.split("\n").some(line => line.includes("已收到你的消息：小键盘发送二") && line.includes('"stop_reason"'));
  for (let i = 0; i < 100 && !replied(await readFile(transcript, "utf8")); i++) await page.waitForTimeout(100);
  const user = { type: "user", uuid: randomUUID(), sessionId, cwd, message: { role: "user", content: [
    { type: "text", text: `界面还是没兼容： @${pasted} ，只能在终端操作。另见 @"${document1}" 里的说明。` }] } };
  const files = [pasted, document1].map(filename => ({ type: "attachment", uuid: randomUUID(), parentUuid: user.uuid, sessionId, cwd,
    attachment: { type: "file", filename, displayPath: filename } }));
  files[1].parentUuid = files[0].uuid;
  const answer = { type: "assistant", uuid: randomUUID(), parentUuid: files[1].uuid, sessionId, cwd,
    message: { role: "assistant", id: randomUUID(), stop_reason: "end_turn", content: "看到了。" } };
  await appendFile(transcript, [user, ...files, answer].map(row => JSON.stringify(row) + "\n").join(""));
  const older = page.locator(".message-user").filter({ hasText: "界面还是没兼容" });
  await older.locator("[data-attachment-chip]").nth(1).waitFor();
  assert.deepEqual(await older.locator("[data-attachment-chip]").evaluateAll(nodes => nodes.map(node => node.dataset.attachmentChip)), ["image1.png", "资料 1.txt"]);
  assert.deepEqual(await older.locator(".attachment-chip").evaluateAll(nodes => nodes.map(node => node.title)), [pasted, document1]);
  assert.deepEqual(await older.locator(".attachment-cards [data-attachment-card]").evaluateAll(nodes => nodes.map(node => node.dataset.attachmentCard)), ["image"],
    "the image once in the row, the text file only as its chip");
  // The chips draw the names; the text under them is the mentions, so a copy gives the message as written.
  assert.deepEqual(await older.locator(".attachment-chip-name").evaluateAll(nodes => nodes.map(node => getComputedStyle(node, "::before").content)), ['"image1.png"', '"资料 1.txt"']);
  assert.equal(await copyAll(older.locator(".user-text")), `界面还是没兼容： @${pasted} ，只能在终端操作。另见 @"${document1}" 里的说明。`);
  await page.evaluate(() => getSelection().removeAllRanges());
  assert.equal(await page.getByText(/^查看 /).count(), 0, "no separate 'View' links anywhere");
  await older.locator(".message-content").screenshot({ path: path.join(output, "bubble-chips.png") });

  // Dark appearance: the same cards and chips, and the input box's cards.
  // Playwright pins the page's color scheme, so the dark theme is emulated rather than set through nativeTheme.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => matchMedia("(prefers-color-scheme: dark)").matches);
  await input.fill("深色外观");
  await input.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  await cardCount(1);
  const [another] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "添加文件", exact: true }).click()]);
  await another.setFiles(document2);
  await cardCount(2);
  await page.locator(".composer").screenshot({ path: path.join(output, "composer-cards-dark.png") });
  await older.locator(".message-content").screenshot({ path: path.join(output, "bubble-chips-dark.png") });
  // Only the user's own scrolling leaves the latest message: scroll up with the wheel.
  const conversation = await page.locator(".conversation-scroll").boundingBox();
  await page.mouse.move(conversation.x + conversation.width / 2, conversation.y + conversation.height / 2);
  for (let i = 0; i < 20 && !(await sent.locator(".attachment-cards").evaluate(element => {
    const box = element.getBoundingClientRect(), view = element.closest(".conversation-scroll").getBoundingClientRect();
    return box.top > view.top + 20 && box.bottom < view.bottom - 20;
  })); i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(150); }
  await page.waitForTimeout(300);
  await sent.locator(".message-content").screenshot({ path: path.join(output, "bubble-cards-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, "done.png") });
  console.log(JSON.stringify({ success: true, dropped: document1, pasted, output }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
