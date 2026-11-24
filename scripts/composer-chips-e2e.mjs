// npm run build && node scripts/composer-chips-e2e.mjs [packaged-executable]
// Files inside the input box's text: a pasted screenshot becomes a chip named image1.png
// (the next one image2.png, never the same number twice in a chat) where the caret was,
// with its card above the text that opens the image larger. The caret steps over a chip,
// Backspace and cut take it whole, paste and undo bring it back (anywhere in the text),
// and what is copied out or sent is the @-path. A file picked from the @ list becomes a
// chip the same way (its card opens the preview); typed mentions stay text until the
// draft is shown again. Demo mode: no real model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "./fixtures/electron.mjs";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "tcc-")));
const output = path.resolve("test-results", "composer-chips");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Workspace image thumbnails need Pillow on Linux; without it the card keeps its placeholder.
const fileThumbnails = process.platform === "darwin" || spawnSync("python3", ["-I", "-c", "import PIL"], { stdio: "ignore" }).status === 0;
// Files written into the folder during the run show in the @ list soon.
const env = { ...process.env, LECTERN_LOCALE: "zh-CN", TMPDIR: root, TMUX_TMPDIR: root, LECTERN_FILE_INDEX_TTL_MS: "300",
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
  const cardLabels = () => cards.evaluateAll(nodes => nodes.map(node => node.dataset.tip));
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
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]')?.matches(':disabled, [aria-disabled="true"]'), null, { timeout: 30000 });
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

  step("paste two screenshots where the caret is: image1.png and image2.png");
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
  assert.deepEqual(await labels(), ["image1.png", "image2.png"]);
  assert.deepEqual(await cardLabels(), ["image1.png", "image2.png"], "the cards are named like the chips");
  assert.equal(await page.locator(".attachment-card-badge").count(), 0, "no number badges");
  const [first, second] = await chipPaths();
  assert.ok(first?.startsWith(uploads + "/") && first.endsWith("/image1.png"), first);
  assert.ok(second?.startsWith(uploads + "/") && second.endsWith("/image2.png"), second);
  assert.notEqual(first, second);
  assert.deepEqual(await readFile(first), wide);
  // Hovering a chip names the file and its path.
  await chips.first().hover();
  const hover = page.getByRole("tooltip");
  await hover.waitFor();
  assert.match(await hover.innerText(), new RegExp(`image1\\.png[\\s\\S]*${first.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
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
  assert.equal(await page.locator('.composer-chip[data-selected="true"] .composer-chip-face').getAttribute("data-chip-label"), "image2.png");

  step("an input method composes next to a chip");
  await input.evaluate((element, at) => element.setSelectionRange(at, at), bEnd);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ne", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.imeSetComposition", { text: "嗯", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "嗯" });
  assert.equal(await shownText(), "看这两张图： ▣ 和 ▣嗯 有什么区别？");
  assert.deepEqual(await labels(), ["image1.png", "image2.png"]);
  await input.press("Backspace");
  assert.equal(await shownText(), "看这两张图： ▣ 和 ▣ 有什么区别？");

  step("a card opens its image larger, with the mouse and the keyboard");
  await cards.first().getByRole("button", { name: "查看大图：image1.png" }).click();
  const viewer = page.getByRole("dialog", { name: "图片预览 · image1.png" });
  assert.equal(await viewer.getByRole("img", { name: "image1.png", exact: true }).evaluate(async img => { await img.decode(); return img.naturalWidth; }), 640);
  await page.screenshot({ path: path.join(output, "viewer.png") });
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "查看大图：image1.png", "focus goes back to the card");
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
  const viewer2 = page.getByRole("dialog", { name: "图片预览 · image2.png" });
  await viewer2.getByRole("img", { name: "image2.png", exact: true }).waitFor();
  const dialogBox = await viewer2.boundingBox();
  await page.mouse.click(dialogBox.x + 4, dialogBox.y - 20 > 0 ? dialogBox.y - 20 : dialogBox.y + dialogBox.height + 10);
  await viewer2.waitFor({ state: "detached" });

  step("cut a chip and paste it elsewhere; undo puts it back");
  await chips.first().click();
  await page.keyboard.press(`${primary}+X`);
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 1);
  assert.equal(await clipboard(), `@${first}`, "the clipboard has the @-path, usable anywhere");
  assert.equal(await shownText(), "看这两张图：  和 ▣ 有什么区别？");
  assert.deepEqual([await labels(), await cardLabels()], [["image2.png"], ["image2.png"]], "names never change");
  assert.deepEqual(await chipPaths(), [second]);
  await input.press("End");
  await page.keyboard.press(`${primary}+V`);
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 2);
  assert.equal(await shownText(), "看这两张图：  和 ▣ 有什么区别？▣");
  assert.deepEqual(await chipPaths(), [second, first]);
  assert.deepEqual([await labels(), await cardLabels()], [["image2.png", "image1.png"], ["image2.png", "image1.png"]], "the cards follow the text's order");
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
  assert.deepEqual([await chipPaths(), await cardLabels()], [[first], ["image1.png"]]);
  await page.keyboard.press(`${primary}+Z`);
  assert.deepEqual([await chipPaths(), await cardLabels()], [[first, second], ["image1.png", "image2.png"]]);
  // Two references to one image: one card, and it stays until both are gone.
  await chips.first().click();
  await page.keyboard.press(`${primary}+C`);
  await input.press("End");
  await page.keyboard.press(`${primary}+V`);
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 3);
  assert.deepEqual([await labels(), await cardLabels()], [["image1.png", "image2.png", "image1.png"], ["image1.png", "image2.png"]]);
  await input.press("Backspace");
  assert.deepEqual([await labels(), await cardLabels()], [["image1.png", "image2.png"], ["image1.png", "image2.png"]]);

  step("what is copied out is the draft's text");
  await input.press(`${primary}+A`);
  await page.keyboard.press(`${primary}+C`);
  assert.equal(await clipboard(), `看这两张图： @${first} 和 @${second} 有什么区别？`);
  await input.press("End");

  step("removing a card takes its chips out of the text");
  await cards.nth(1).hover();
  await page.getByRole("button", { name: "移除 image2.png" }).click();
  assert.deepEqual([await chipPaths(), await cardLabels()], [[first], ["image1.png"]]);
  assert.equal(await shownText(), "看这两张图： ▣ 和 有什么区别？");
  await page.keyboard.press(`${primary}+Z`);
  // Taking a card out is not typing: undo leaves it out.
  assert.deepEqual(await chipPaths(), [first]);
  await input.press("End");
  await pasteImage(tall);
  await uploaded();
  const third = (await chipPaths())[1];
  assert.equal(await shownText(), "看这两张图： ▣ 和 有什么区别？ ▣ ");
  // image2.png left the text, but its number is not given again in this chat.
  assert.deepEqual(await labels(), ["image1.png", "image3.png"]);
  assert.ok(third.endsWith("/image3.png"), third);

  step("a draft left and shown again keeps its chips");
  await page.getByRole("button", { name: "新建对话" }).first().click();
  await page.waitForFunction(() => !document.querySelector(".composer-chip-face"));
  await page.locator(`.session-row[data-session-id="${sessionId}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 2);
  assert.deepEqual([await labels(), await chipPaths()], [["image1.png", "image3.png"], [first, third]]);
  assert.equal(await shownText(), "看这两张图： ▣ 和 有什么区别？ ▣ ");

  step("an image that cannot be read shows why, and a way to the file");
  await rm(third);
  await cards.nth(1).getByRole("button").first().click();
  const broken = page.getByRole("dialog", { name: "图片预览 · image3.png" });
  await broken.getByRole("alert").waitFor();
  await broken.getByRole("button", { name: "查看文件" }).waitFor();
  assert.doesNotMatch(await broken.getByRole("alert").innerText(), /Error invoking/);
  await page.screenshot({ path: path.join(output, "viewer-error.png") });
  await page.keyboard.press("Escape");
  await broken.waitFor({ state: "detached" });
  await cards.nth(1).hover();
  await page.getByRole("button", { name: "移除 image3.png" }).click();

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

  step("a file picked from the @ list becomes a chip with its name; undo takes it back");
  const cwd = await page.evaluate(async () => (await window.desktop.listWorkspaces())[0].cwd);
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(path.join(cwd, "notes.md"), "# 笔记\n补全选中的文件\n");
  await writeFile(path.join(cwd, "docs", "plan v2.md"), "# 计划\n");
  await writeFile(path.join(cwd, "todo.txt"), "待办\n");
  await writeFile(path.join(cwd, "diagram.png"), wide);
  // The reply to the message sent above may still be running or ending: the box keeps the keyboard and the @ list through it.
  const pick = async (typed, name) => {
    await input.pressSequentially(typed);
    await page.getByRole("option", { name }).waitFor();
    await input.press("Enter");
    await page.getByRole("listbox").waitFor({ state: "detached" });
  };
  await input.click();
  await input.pressSequentially("先读 ");
  await pick("@notes", /notes\.md/);
  assert.equal(await shownText(), "先读 ▣ ");
  assert.deepEqual([await labels(), await chipPaths()], [["notes.md"], ["notes.md"]]);
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => [node.dataset.attachmentCard, node.dataset.tip, node.dataset.tipDetail])),
    [["file", "notes.md", path.join(cwd, "notes.md")]], "a file card with the full path on hover");
  await chips.first().hover();
  await page.getByRole("tooltip").filter({ hasText: path.join(cwd, "notes.md") }).waitFor();
  await page.mouse.move(0, 0);
  await page.keyboard.press(`${primary}+Z`);
  assert.equal(await shownText(), "先读 @notes", "undo gives back what was typed");
  await page.keyboard.press(`${primary}+Shift+Z`);
  assert.equal(await shownText(), "先读 ▣ ");
  await input.press("End");

  step("a quoted path and an image from the @ list; their cards open the preview and the image");
  await input.pressSequentially("和 ");
  await pick("@plan", /plan v2\.md/);
  await input.pressSequentially("还有 ");
  await pick("@diag", /diagram\.png/);
  assert.equal(await shownText(), "先读 ▣ 和 ▣ 还有 ▣ ");
  assert.deepEqual(await labels(), ["notes.md", "plan v2.md", "diagram.png"]);
  assert.deepEqual(await page.locator(".composer-chip-label").evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth).map(node => node.textContent)), [],
    "each chip is wide enough for its name");
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => [node.dataset.attachmentCard, node.dataset.tip])),
    [["file", "notes.md"], ["file", "plan v2.md"], ["image", "diagram.png"]]);
  // A workspace image is thumbnailed on its machine (a placeholder without a converter).
  if (fileThumbnails) await cards.nth(2).locator("img").waitFor();
  else {
    assert.equal(await cards.nth(2).getAttribute("data-thumbnail"), "icon");
    console.log("NOTE: python3 Pillow is not installed, so the picked image's card was checked as a placeholder.");
  }
  await input.press(`${primary}+A`);
  await page.keyboard.press(`${primary}+C`);
  assert.equal(await clipboard(), '先读 @notes.md 和 @"docs/plan v2.md" 还有 @diagram.png ');
  await input.press("End");
  await page.locator(".composer").screenshot({ path: path.join(output, "picked.png") });
  await cards.first().getByRole("button", { name: `打开 ${path.join(cwd, "notes.md")}` }).click();
  const drawer = page.getByRole("complementary", { name: "文件预览" });
  await drawer.getByText("补全选中的文件").waitFor();
  await drawer.getByRole("button", { name: "关闭文件预览" }).click();
  await cards.nth(2).getByRole("button", { name: "查看大图：diagram.png" }).click();
  const diagram = page.getByRole("dialog", { name: "图片预览 · diagram.png" });
  assert.equal(await diagram.getByRole("img", { name: "diagram.png", exact: true }).evaluate(async img => { await img.decode(); return img.naturalWidth; }), 640);
  await page.keyboard.press("Escape");
  await diagram.waitFor({ state: "detached" });
  // A double click on a file's chip opens it too.
  await chips.nth(1).dblclick();
  await drawer.getByText("计划").waitFor();
  await drawer.getByRole("button", { name: "关闭文件预览" }).click();

  step("typed mentions stay text; shown again, the files they name become chips");
  await input.fill("");
  await input.pressSequentially("手打 @todo.txt 和 @missing.txt 以及 @notes.md ");
  await page.waitForTimeout(500);
  assert.equal(await chips.count(), 0, "typing never turns into chips");
  await page.getByRole("button", { name: "新建对话" }).first().click();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="发送给 Claude 的消息"]').value);
  await page.locator(`.session-row[data-session-id="${sessionId}"]`).click();
  // notes.md is known from the @ list at once; todo.txt after the folder is checked; missing.txt stays text.
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 2);
  assert.equal(await shownText(), "手打 ▣ 和 @missing.txt 以及 ▣ ");
  assert.deepEqual(await labels(), ["todo.txt", "notes.md"]);
  await page.locator(".composer").screenshot({ path: path.join(output, "restored.png") });

  step("sent, the files stay chips in the bubble and copy as their @-paths");
  await page.locator(".send-button:not([disabled])").waitFor({ timeout: 30000 });
  await input.press("Enter");
  const bubble = page.locator('.message-user[data-source="jsonl"]').filter({ hasText: "手打" });
  await bubble.locator("[data-attachment-chip]").nth(1).waitFor();
  const bubbleChips = locator => locator.locator("[data-attachment-chip]").evaluateAll(nodes => nodes.map(node => [node.dataset.attachmentChip, node.dataset.mention]));
  assert.deepEqual(await bubbleChips(bubble), [["todo.txt", "@todo.txt"], ["notes.md", "@notes.md"]]);
  // Claude Code is still where the chat started: the picked file goes as the folder-relative path, as typed.
  assert.equal((await prompts()).find(text => text.startsWith("手打"))?.trim(), "手打 @todo.txt 和 @missing.txt 以及 @notes.md");
  assert.equal(await bubble.locator(".attachment-cards").count(), 0, "no row: no image, and named files are not repeated as cards");
  const copyAll = async locator => {
    await locator.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); getSelection().removeAllRanges(); getSelection().addRange(range); });
    await page.keyboard.press(`${primary}+C`);
    await page.evaluate(() => getSelection().removeAllRanges());
    return clipboard();
  };
  assert.equal((await copyAll(bubble.locator(".user-text"))).trim(), "手打 @todo.txt 和 @missing.txt 以及 @notes.md");
  // Pasted back into the box, the known files are chips again.
  await input.click();
  await page.keyboard.press(`${primary}+V`);
  await page.waitForFunction(() => document.querySelectorAll(".composer-chip-face").length === 2);
  assert.equal((await shownText()).trimEnd(), "手打 ▣ 和 @missing.txt 以及 ▣");
  await input.fill("");

  step("a mention the transcript did not record is a chip once the folder is checked");
  await page.locator(".send-button").waitFor({ timeout: 30000 });
  const replied = text => text.endsWith("\n") && text.split("\n").some(line => line.includes("已收到你的消息：手打") && line.includes('"stop_reason"'));
  for (let i = 0; i < 100 && !replied(await readFile(transcript, "utf8")); i++) await page.waitForTimeout(100);
  const user = { type: "user", uuid: randomUUID(), sessionId, cwd, message: { role: "user", content: [{ type: "text", text: '对比 @"docs/plan v2.md" 和 @diagram.png 以及 @gone.md' }] } };
  const answer = { type: "assistant", uuid: randomUUID(), parentUuid: user.uuid, sessionId, cwd, message: { role: "assistant", id: randomUUID(), stop_reason: "end_turn", content: "好。" } };
  await appendFile(transcript, [user, answer].map(row => JSON.stringify(row) + "\n").join(""));
  const typed = page.locator(".message-user").filter({ hasText: "对比" });
  await typed.locator("[data-attachment-chip]").nth(1).waitFor();
  assert.deepEqual(await bubbleChips(typed), [["plan v2.md", '@"docs/plan v2.md"'], ["diagram.png", "@diagram.png"]]);
  assert.deepEqual(await typed.locator(".attachment-cards [data-attachment-card]").evaluateAll(nodes => nodes.map(node => node.dataset.attachmentCard)), ["image"],
    "the image in the row above");
  assert.match(await typed.locator(".user-text").innerText(), /以及 @gone\.md/);
  await typed.locator(".message-content").screenshot({ path: path.join(output, "bubble.png") });
  await typed.locator('[data-attachment-chip="plan v2.md"]').click();
  await drawer.getByText("计划").waitFor();
  await drawer.getByRole("button", { name: "关闭文件预览" }).click();

  step("after Claude Code cd's into a subfolder, a file picked from the @ list is sent as its absolute path");
  const finished = start => text => text.endsWith("\n") && text.split("\n").some(line => line.includes("已收到你的消息：" + start) && line.includes('"stop_reason"'));
  await page.locator(".send-button").waitFor({ timeout: 30000 });
  await input.fill("进入子目录 mock-cd:docs");
  await page.locator(".send-button:not([disabled])").waitFor({ timeout: 30000 });
  await input.press("Enter");
  for (let i = 0; i < 150 && !finished("进入子目录")(await readFile(transcript, "utf8")); i++) await page.waitForTimeout(100);
  await page.locator('.message-assistant[data-source="jsonl"]').filter({ hasText: "已收到你的消息：进入子目录" }).waitFor();
  const launch = await realpath(cwd), sub = path.join(launch, "docs");
  const mention = file => /^[\p{L}\p{N}\p{M}_./~-]+$/u.test(file) ? "@" + file : `@"${file}"`;
  await input.click();
  await input.pressSequentially("再看 ");
  await pick("@todo", /todo\.txt/);
  assert.equal(await shownText(), "再看 ▣ ");
  assert.deepEqual(await labels(), ["todo.txt"], "the chip keeps the file's name");
  await page.locator(".send-button:not([disabled])").waitFor({ timeout: 30000 });
  await input.press("Enter");
  for (let i = 0; i < 100 && !(await prompts()).some(text => text.startsWith("再看")); i++) await page.waitForTimeout(100);
  // Claude Code reads a mention from where it is now (docs/): the folder-relative todo.txt would be lost.
  assert.equal((await prompts()).find(text => text.startsWith("再看"))?.trim(), `再看 ${mention(path.join(launch, "todo.txt"))}`);
  const moved = page.locator('.message-user[data-source="jsonl"]').filter({ hasText: "再看" });
  await moved.locator("[data-attachment-chip]").waitFor();
  assert.deepEqual(await bubbleChips(moved), [["todo.txt", mention(path.join(launch, "todo.txt"))]]);
  await moved.locator('[data-attachment-chip="todo.txt"]').click();
  await drawer.getByText("待办").waitFor();
  await drawer.getByRole("button", { name: "关闭文件预览" }).click();
  await moved.locator(".message-content").screenshot({ path: path.join(output, "after-cd.png") });

  step("a prompt's mentions are the files Claude Code read from where it was");
  for (let i = 0; i < 150 && !finished("再看")(await readFile(transcript, "utf8")); i++) await page.waitForTimeout(100);
  await writeFile(path.join(cwd, "docs", "notes.md"), "# 子目录\n子目录里的笔记\n");
  const compare = { type: "user", uuid: randomUUID(), sessionId, cwd: sub, message: { role: "user", content: [{ type: "text", text: "比较 @notes.md 和 @../notes.md" }] } };
  const done = { type: "assistant", uuid: randomUUID(), parentUuid: compare.uuid, sessionId, cwd: sub, message: { role: "assistant", id: randomUUID(), stop_reason: "end_turn", content: "好。" } };
  await appendFile(transcript, [compare, done].map(row => JSON.stringify(row) + "\n").join(""));
  const compared = page.locator(".message-user").filter({ hasText: "比较" });
  await compared.locator("[data-attachment-chip]").nth(1).waitFor();
  assert.deepEqual(await bubbleChips(compared), [["notes.md", "@notes.md"], ["notes.md", "@../notes.md"]]);
  await compared.locator("[data-attachment-chip]").first().click();
  await drawer.getByText("子目录里的笔记").waitFor();
  await drawer.getByRole("button", { name: "关闭文件预览" }).click();
  await compared.locator("[data-attachment-chip]").nth(1).click();
  await drawer.getByText("补全选中的文件").waitFor();
  await drawer.getByRole("button", { name: "关闭文件预览" }).click();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, output }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
