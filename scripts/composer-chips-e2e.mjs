// npm run build && node scripts/composer-chips-e2e.mjs [packaged-executable]
// Attachments inside the input box's text: a pasted image becomes a chip ("图片1") where
// the caret was, numbered like the card above the text, and the card opens the image
// larger. The caret steps over a chip, Backspace and cut take it whole, paste and undo
// bring it back (anywhere in the text), and what is copied out or sent is the @-path.
// Demo mode: no real model.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "tcc-")));
const output = path.resolve("test-results", "composer-chips");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: "zh-CN", TMPDIR: root, TMUX_TMPDIR: root,
  LECTERN_USER_DATA: path.join(root, "profile"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  LECTERN_NODE_BINARY: process.execPath, LECTERN_LOG_DIR: path.join(output, "diagnostics"), LECTERN_DIAGNOSTIC_CONTENT: "0" };
delete env.TMUX; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const uploads = path.join(root, `lectern-attachments-${process.getuid()}`);
const primary = process.platform === "darwin" ? "Meta" : "Control";
let app, page;
const step = name => console.log(`[composer-chips] ${name}`);

try {
  const executable = process.argv[2];
  app = await _electron.launch({ args: executable ? ["--demo"] : [".", "--demo"], env, ...(executable && { executablePath: path.resolve(executable) }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const input = page.getByRole("textbox", { name: "发送给 Claude 的消息" });
  const chips = page.locator(".composer-chip-face");
  const cards = page.locator(".composer-attachments [data-attachment-card]");
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const labels = () => chips.evaluateAll(nodes => nodes.map(node => node.dataset.chipLabel));
  const cardLabels = () => cards.evaluateAll(nodes => nodes.map(node => node.dataset.chipLabel ?? node.dataset.tip));
  const chipPaths = () => chips.evaluateAll(nodes => nodes.map(node => node.dataset.chipPath));
  // The textarea's text with each chip token shown as [n] (its order) and everything else as typed.
  const shownText = () => input.evaluate(element => element.value.replace(/ \u{E0001}[\u{E0030}-\u{E0039}]+\u{E002D}[\u{E0030}-\u{E0039}]+\u{E007F} */gu, "▣"));
  const tokenRanges = () => input.evaluate(element => [...element.value.matchAll(/ \u{E0001}[\u{E0030}-\u{E0039}]+\u{E002D}([\u{E0030}-\u{E0039}]+)\u{E007F}/gu)]
    .map(match => { const width = Number([...match[1]].map(c => c.codePointAt(0) - 0xE0030).join("")); return [match.index, match.index + match[0].length + width - 1]; }));
  const caret = () => input.evaluate(element => [element.selectionStart, element.selectionEnd]);
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const pasteImage = bytes => input.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...bytes]);
  const uploaded = () => page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length
    && !document.querySelector('.composer-chip-face[data-state="uploading"], .composer-attachments [data-state="uploading"]'));

  await page.locator('.session-row.active[data-session-live="true"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.disabled, null, { timeout: 30000 });
  const sessionId = await page.locator(".session-row.active").getAttribute("data-session-id");
  // Two different pictures: a wide "screenshot" and a tall one.
  const picture = (width, height, color) => page.evaluate(([width, height, color]) => {
    const canvas = Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(width / 4, height / 4, width / 2, height / 8);
    return canvas.toDataURL("image/png").split(",")[1];
  }, [width, height, color]).then(data => Buffer.from(data, "base64"));
  const wide = await picture(640, 400, "#345cad"), tall = await picture(300, 500, "#b65a38");

  step("paste two images where the caret is");
  await input.click();
  await input.pressSequentially("看这两张图：");
  await pasteImage(wide);
  await uploaded();
  await input.pressSequentially("和");
  await pasteImage(tall);
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 2);
  await uploaded();
  await input.pressSequentially("有什么区别？");
  assert.equal(await shownText(), "看这两张图： ▣ 和 ▣ 有什么区别？");
  assert.deepEqual(await labels(), ["图片1", "图片2"]);
  assert.deepEqual(await cardLabels(), ["图片1", "图片2"], "the cards are numbered like the chips");
  const [first, second] = await chipPaths();
  for (const file of [first, second]) assert.ok(file?.startsWith(uploads + "/") && file.endsWith("/image.png"), file);
  assert.notEqual(first, second);
  assert.deepEqual(await readFile(first), wide);
  // Hovering a chip names the file and its path.
  await chips.first().hover();
  const hover = page.getByRole("tooltip");
  await hover.waitFor();
  assert.match(await hover.innerText(), new RegExp(`image\\.png[\\s\\S]*${first.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  // Each chip sits on its token's spaces inside the textarea, on the text's line.
  const boxes = await page.evaluate(() => {
    const area = document.querySelector(".composer textarea").getBoundingClientRect();
    return [...document.querySelectorAll(".composer-chip-face")].map(face => {
      const box = face.getBoundingClientRect();
      return { inside: box.left >= area.left - 1 && box.right <= area.right + 1 && box.top >= area.top - 2 && box.bottom <= area.bottom + 2, width: box.width, label: face.querySelector(".composer-chip-label").scrollWidth <= face.querySelector(".composer-chip-label").clientWidth };
    });
  });
  for (const box of boxes) assert.ok(box.inside && box.width > 30 && box.label, JSON.stringify(boxes));
  await page.mouse.move(0, 0);
  await page.locator(".composer").screenshot({ path: path.join(output, "chips.png") });

  step("the caret steps over a chip; Shift+arrow selects it whole");
  const [[aStart, aEnd], [bStart, bEnd]] = await tokenRanges();
  await input.evaluate((element, at) => element.setSelectionRange(at, at), aStart);
  await input.press("ArrowRight");
  assert.deepEqual(await caret(), [aEnd, aEnd]);
  await input.press("ArrowLeft");
  assert.deepEqual(await caret(), [aStart, aStart]);
  await input.press("ArrowLeft");
  assert.deepEqual(await caret(), [aStart - 1, aStart - 1], "plain text moves one character");
  await input.press("ArrowRight");
  await input.press("Shift+ArrowRight");
  assert.deepEqual(await caret(), [aStart, aEnd]);
  await page.locator('.composer-chip[data-selected="true"]').waitFor();
  // A caret that lands inside a chip's spaces some other way goes to the nearer edge.
  await input.evaluate((element, at) => element.setSelectionRange(at, at), aStart + 3);
  await input.press("Shift");
  assert.deepEqual(await caret(), [aStart, aStart], "a caret put inside goes to the nearer edge");
  // A click on a chip selects it.
  await chips.nth(1).click();
  assert.deepEqual(await caret(), [bStart, bEnd]);
  assert.equal(await page.locator('.composer-chip[data-selected="true"] .composer-chip-face').getAttribute("data-chip-label"), "图片2");

  step("an input method composes next to a chip");
  await input.evaluate((element, at) => element.setSelectionRange(at, at), bEnd);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ne", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.imeSetComposition", { text: "嗯", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "嗯" });
  assert.equal(await shownText(), "看这两张图： ▣ 和 ▣嗯 有什么区别？");
  assert.deepEqual(await labels(), ["图片1", "图片2"]);
  await input.press("Backspace");
  assert.equal(await shownText(), "看这两张图： ▣ 和 ▣ 有什么区别？");

  step("a card opens its image larger, with the mouse and the keyboard");
  await cards.first().getByRole("button", { name: "查看大图：图片1（image.png）" }).click();
  const viewer = page.getByRole("dialog", { name: "图片预览 · image.png" });
  assert.equal(await viewer.getByRole("img", { name: "image.png", exact: true }).evaluate(async img => { await img.decode(); return img.naturalWidth; }), 640);
  await page.screenshot({ path: path.join(output, "viewer.png") });
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "查看大图：图片1（image.png）", "focus goes back to the card");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await viewer.waitFor();
  // Fit to the window, and back.
  const canvas = viewer.locator(".chat-image-canvas");
  await canvas.getByRole("button", { name: "原始尺寸" }).click();
  assert.equal(await canvas.getAttribute("data-actual-size"), "true");
  await viewer.getByRole("button", { name: "关闭图片预览" }).click();
  await viewer.waitFor({ state: "detached" });
  // A click beside the image closes it too.
  await cards.nth(1).getByRole("button").first().click();
  await viewer.getByRole("img", { name: "image.png", exact: true }).waitFor();
  const dialogBox = await viewer.boundingBox();
  await page.mouse.click(dialogBox.x + 4, dialogBox.y - 20 > 0 ? dialogBox.y - 20 : dialogBox.y + dialogBox.height + 10);
  await viewer.waitFor({ state: "detached" });

  step("cut a chip and paste it elsewhere; undo puts it back");
  await chips.first().click();
  await page.keyboard.press(`${primary}+X`);
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 1);
  assert.equal(await clipboard(), `@${first}`, "the clipboard has the @-path, usable anywhere");
  assert.equal(await shownText(), "看这两张图：  和 ▣ 有什么区别？");
  assert.deepEqual([await labels(), await cardLabels()], [["图片1"], ["图片1"]], "the other image is image 1 now");
  assert.deepEqual(await chipPaths(), [second]);
  await input.press("End");
  await page.keyboard.press(`${primary}+V`);
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 2);
  assert.equal(await shownText(), "看这两张图：  和 ▣ 有什么区别？▣");
  assert.deepEqual(await chipPaths(), [second, first]);
  assert.deepEqual([await labels(), await cardLabels()], [["图片1", "图片2"], ["图片1", "图片2"]]);
  await page.locator(".composer").screenshot({ path: path.join(output, "moved.png") });
  await page.keyboard.press(`${primary}+Z`);
  assert.equal(await shownText(), "看这两张图：  和 ▣ 有什么区别？");
  await page.keyboard.press(`${primary}+Z`);
  assert.equal(await shownText(), "看这两张图： ▣ 和 ▣ 有什么区别？");
  assert.deepEqual(await chipPaths(), [first, second]);
  await page.keyboard.press(`${primary}+Shift+Z`);
  assert.equal(await shownText(), "看这两张图：  和 ▣ 有什么区别？");
  await page.keyboard.press(`${primary}+Z`);
  assert.deepEqual(await chipPaths(), [first, second]);

  step("Backspace deletes a chip whole; the last reference gone, its card goes too");
  const [, [, secondEnd]] = await tokenRanges();
  await input.evaluate((element, at) => element.setSelectionRange(at, at), secondEnd);
  await input.press("Backspace");
  assert.equal(await shownText(), "看这两张图： ▣ 和  有什么区别？");
  assert.deepEqual([await chipPaths(), await cardLabels()], [[first], ["图片1"]]);
  await page.keyboard.press(`${primary}+Z`);
  assert.deepEqual([await chipPaths(), await cardLabels()], [[first, second], ["图片1", "图片2"]]);
  // Two references to one image: one card, and it stays until both are gone.
  await chips.first().click();
  await page.keyboard.press(`${primary}+C`);
  await input.press("End");
  await page.keyboard.press(`${primary}+V`);
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 3);
  assert.deepEqual([await labels(), await cardLabels()], [["图片1", "图片2", "图片1"], ["图片1", "图片2"]]);
  await input.press("Backspace");
  assert.deepEqual([await labels(), await cardLabels()], [["图片1", "图片2"], ["图片1", "图片2"]]);

  step("what is copied out is the draft's text");
  await input.press(`${primary}+A`);
  await page.keyboard.press(`${primary}+C`);
  assert.equal(await clipboard(), `看这两张图： @${first} 和 @${second} 有什么区别？`);
  await input.press("End");

  step("removing a card takes its chips out of the text");
  await cards.nth(1).hover();
  await page.getByRole("button", { name: "移除 image.png" }).nth(1).click();
  assert.deepEqual([await chipPaths(), await cardLabels()], [[first], ["图片1"]]);
  assert.equal(await shownText(), "看这两张图： ▣ 和 有什么区别？");
  await page.keyboard.press(`${primary}+Z`);
  // Taking a card out is not typing: undo leaves it out.
  assert.deepEqual(await chipPaths(), [first]);
  await input.press("End");
  await pasteImage(tall);
  await uploaded();
  const third = (await chipPaths())[1];
  assert.equal(await shownText(), "看这两张图： ▣ 和 有什么区别？ ▣ ");

  step("a draft left and shown again keeps its chips");
  await page.getByRole("button", { name: "新建对话" }).first().click();
  await page.waitForFunction(() => !document.querySelector(".composer-chip-face"));
  await page.locator(`.session-row[data-session-id="${sessionId}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 2);
  assert.deepEqual([await labels(), await chipPaths()], [["图片1", "图片2"], [first, third]]);
  assert.equal(await shownText(), "看这两张图： ▣ 和 有什么区别？ ▣ ");

  step("an image that cannot be read shows why, and a way to the file");
  await rm(third);
  await cards.nth(1).getByRole("button").first().click();
  const broken = page.getByRole("dialog", { name: "图片预览 · image.png" });
  await broken.getByRole("alert").waitFor();
  await broken.getByRole("button", { name: "查看文件" }).waitFor();
  assert.doesNotMatch(await broken.getByRole("alert").innerText(), /Error invoking/);
  await page.screenshot({ path: path.join(output, "viewer-error.png") });
  await page.keyboard.press("Escape");
  await broken.waitFor({ state: "detached" });
  await cards.nth(1).hover();
  await page.getByRole("button", { name: "移除 image.png" }).nth(1).click();

  step("sending gives Claude Code the @-paths where the chips were");
  await page.locator(".send-button:not([disabled])").waitFor({ timeout: 30000 });
  await input.press("Enter");
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').value);
  assert.equal(await page.locator(".composer-attachments, .composer-chip-face").count(), 0);
  const transcript = await page.evaluate(async () => {
    const [ws] = await window.desktop.listWorkspaces();
    return (await window.desktop.discover(ws.id)).sessions[0].path;
  });
  const prompts = async () => (await readFile(transcript, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === "user").map(row => row.message.content[0]?.text ?? "");
  for (let i = 0; i < 100 && !(await prompts()).some(text => text.startsWith("看这两张图")); i++) await page.waitForTimeout(100);
  assert.equal((await prompts()).find(text => text.startsWith("看这两张图"))?.trim(), `看这两张图： @${first} 和 有什么区别？`);
  step("in a text taller than the box, chips scroll with it");
  await input.click();
  await input.fill(Array.from({ length: 16 }, (_, i) => `第 ${i + 1} 行`).join("\n") + "\n末行：");
  await pasteImage(wide);
  await uploaded();
  const placement = () => page.evaluate(() => {
    const area = document.querySelector(".composer textarea"), box = area.getBoundingClientRect();
    const face = document.querySelector(".composer-chip-face").getBoundingClientRect();
    const layer = document.querySelector(".composer-chip-layer");
    return { scrolled: area.scrollTop, layer: layer.scrollTop, width: layer.clientWidth === area.clientWidth, overflow: area.scrollHeight > area.clientHeight,
      visible: face.top >= box.top - 1 && face.bottom <= box.bottom + 1 };
  });
  let place = await placement();
  assert.ok(place.overflow && place.scrolled > 0 && place.layer === place.scrolled && place.width && place.visible, JSON.stringify(place));
  await page.locator(".composer").screenshot({ path: path.join(output, "scrolled.png") });
  await input.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector(".composer-chip-layer").scrollTop === 0);
  place = await placement();
  assert.ok(!place.visible, "the chip scrolled out of view with its line");
  await input.fill("");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, output }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
