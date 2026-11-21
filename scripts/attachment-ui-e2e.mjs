// npm run build && node scripts/attachment-ui-e2e.mjs [packaged-executable]
// Files dropped onto or pasted into a chat become @-mentions: a file from disk by
// its own path (Claude Code runs on this computer), clipboard data after it is
// copied into the machine's temporary directory. The keypad Enter sends.
// Demo mode: no real model. (SSH uploads: tests/ssh.test.ts over real OpenSSH.)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "tat-")));
const output = path.resolve("test-results", "attachment-ui-" + Date.now());
await mkdir(output, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', TMPDIR: root, TMUX_TMPDIR: root,
  LECTERN_USER_DATA: path.join(root, "profile"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: path.join(output, "diagnostics"), LECTERN_DIAGNOSTIC_CONTENT: "0" };
delete env.TMUX; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const uploads = path.join(root, `lectern-attachments-${process.getuid()}`);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let app, page;

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? ["--demo"] : [".", "--demo"], env, ...(executable && { executablePath: path.resolve(executable) }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const input = page.getByRole("textbox", { name: "发送给 Claude 的消息" });
  // An inserted @-mention puts the caret in place on the next frame; let that land before
  // replacing the text, or it collapses the selection fill() made and the old text stays.
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.disabled, null, { timeout: 30000 });

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
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').value.length > 0);
  assert.equal(await input.inputValue(), `@"${document1}" `);
  assert.equal(await page.locator(".composer.composer-drop").count(), 0);
  await assert.rejects(readdir(uploads), "a file from disk is not copied anywhere");

  // The "+" button opens the system file dialog; the chosen file is added the same way.
  await settled();
  await input.fill("");
  const document2 = path.join(root, "notes.md");
  await writeFile(document2, "# 选择的文件\n");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "添加文件", exact: true }).click()]);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(document2);
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').value.length > 0);
  assert.equal(await input.inputValue(), `@${document2} `);
  await assert.rejects(readdir(uploads), "a chosen file from disk is not copied either");

  // A screenshot from the clipboard has no path: it is copied to the temporary directory.
  await settled();
  await input.fill("看图：");
  await input.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
  await input.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  await page.waitForFunction(() => /@\S+image\.png $/.test(document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').value));
  const pasted = (await input.inputValue()).match(/^看图： @(\S+) $/)?.[1];
  assert.ok(pasted?.startsWith(uploads + "/") && pasted.endsWith("/image.png"), pasted);
  assert.deepEqual(await readFile(pasted), png);

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
  assert.equal((await readdir(uploads)).length, 1, "nothing more was uploaded");

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

  // The keypad Enter sends, also when an input method reports it as its own key (229).
  await input.fill("小键盘发送一");
  await page.locator(".send-button:not([disabled])").waitFor({ timeout: 30000 });
  await input.press("NumpadEnter");
  await page.locator(".message-user").filter({ hasText: "小键盘发送一" }).waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').value);
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
