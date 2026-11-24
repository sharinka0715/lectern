// Run after npm run build. The isolated demo uses real Electron IPC and tmux with an offline Claude fixture.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron, resizeWindow } from "./fixtures/electron.mjs";
import { refreshFolderUntil } from "./fixtures/sidebar-refresh.mjs";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "trn-")));
const output = path.resolve("test-results", "session-rename-" + Date.now());
await mkdir(output, { recursive: true });
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', TMPDIR: root, TMUX_TMPDIR: root,
  LECTERN_USER_DATA: path.join(root, "profile"), LECTERN_LOG_DIR: path.join(output, "diagnostics"),
  LECTERN_DIAGNOSTIC_CONTENT: "0", LECTERN_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
delete env.TMUX;

let app, page;
const report = { checks: [] };
try {
  const executablePath = process.argv[2];
  app = await _electron.launch({ args: executablePath ? ["--demo"] : [".", "--demo"], env, ...(executablePath && { executablePath }) });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await resizeWindow(app, page, 1440, 880);
  const [workspace] = await page.evaluate(() => window.desktop.listWorkspaces());
  assert.ok(workspace.claudeDir.startsWith(root + path.sep) && workspace.cwd.startsWith(root + path.sep));
  const liveId = await page.locator('.session-row.active[data-status="idle"]').getAttribute("data-session-id");
  const archiveId = randomUUID();
  const project = path.join(workspace.claudeDir, "projects", workspace.cwd.replace(/[^a-z0-9-]/gi, "-"));
  const firstPrompt = "请整理项目计划";
  const archive = path.join(project, archiveId + ".jsonl");
  const seed = { type: "user", uuid: randomUUID(), sessionId: archiveId, cwd: workspace.cwd,
    timestamp: new Date().toISOString(), message: { role: "user", content: firstPrompt } };
  await writeFile(archive, JSON.stringify(seed) + "\n", { flag: "wx" });

  const row = id => page.locator('.session-row[data-session-id="' + id + '"]');
  await refreshFolderUntil(page, workspace.id, row(archiveId));
  const dialog = page.getByRole("dialog", { name: "重命名会话", exact: true });
  const field = dialog.getByRole("textbox", { name: "会话名称" });
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  const pencil = title => page.getByRole("button", { name: "重命名会话「" + title + "」", exact: true });
  const header = view => page.locator('.desk-pane[data-view="' + view + '"] .topbar-title');
  const activeId = () => page.locator(".session-row.active").getAttribute("data-session-id");
  const initialLiveTitle = await row(liveId).locator(".session-title").innerText();

  await row(archiveId).press("F2");
  assert.match(await row(archiveId).getAttribute("title"), /首条消息/);
  assert.equal(await field.inputValue(), firstPrompt);
  assert.deepEqual(await field.evaluate(input => [input.selectionStart, input.selectionEnd]), [0, firstPrompt.length]);
  await dialog.getByText(/临时续接/).waitFor();
  await field.fill("未保存的名称");
  await field.dispatchEvent("compositionstart");
  await field.press("Enter");
  assert.equal(await dialog.isVisible(), true);
  await field.dispatchEvent("compositionend");
  await field.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await row(archiveId).evaluate(button => document.activeElement === button), true);
  assert.equal(await activeId(), liveId);
  assert.equal(await readFile(archive, "utf8"), JSON.stringify(seed) + "\n");
  report.checks.push("F2 opens the selected text, IME Enter preserves it, Escape cancels without navigation");

  await pencil(firstPrompt).click();
  await field.fill(" ");
  assert.equal(await save.isDisabled(), true);
  await field.fill("长".repeat(201));
  await save.click();
  await dialog.getByRole("alert").filter({ hasText: /200/ }).waitFor();
  const archiveTitle = "规划 🗂️ “秋季”";
  await field.fill("  " + archiveTitle + "  ");
  await field.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await pencil(archiveTitle).waitFor();
  assert.equal(await row(archiveId).getAttribute("data-session-live"), "false");
  assert.equal(await activeId(), liveId);
  assert.equal(await header("primary").innerText(), initialLiveTitle);
  assert.equal((await readFile(archive, "utf8")).split("\n")[0], JSON.stringify(seed));
  report.checks.push("unselected archive renamed, title trimmed, history still offline, primary view preserved");

  await page.getByRole("button", { name: "并排打开对话", exact: true }).click();
  await header("secondary").filter({ hasText: archiveTitle }).waitFor();
  // The live chat is already on the left: clicking it focuses that pane, never a second copy.
  await row(liveId).click();
  await page.waitForFunction(() => document.querySelector('.desk-pane[data-view="primary"]')?.dataset.active === "true");
  assert.equal(await header("secondary").innerText(), archiveTitle);
  const screenState = path.join(workspace.claudeDir, "screen-state");
  await writeFile(screenState, "waiting");
  await page.locator('.session-row.active[data-status="waiting"]').waitFor();
  await row(liveId).press("F2");
  const requested = "交接记录 · 修订 2";
  const liveTitle = requested + "-2";
  await writeFile(path.join(workspace.claudeDir, "fixture-occupied-name"), requested);
  await field.fill(requested);
  await save.click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await field.inputValue(), requested);
  assert.equal(await row(liveId).locator(".session-title").innerText(), initialLiveTitle);
  assert.equal(await header("primary").innerText(), initialLiveTitle);
  assert.equal(await header("secondary").innerText(), archiveTitle);
  assert.equal(await activeId(), liveId);
  await writeFile(screenState, "ready");
  await page.locator('.session-row.active[data-status="idle"]').waitFor();
  await save.click();
  await dialog.waitFor({ state: "hidden" });
  await header("primary").filter({ hasText: liveTitle }).waitFor();
  assert.equal(await header("secondary").innerText(), archiveTitle);
  assert.equal(await page.locator('.desk-pane[data-view="primary"]').getAttribute("data-active"), "true");
  report.checks.push("busy native prompt retains original titles, retry shows native collision suffix without switching focus");
  const directory = await page.evaluate(id => window.desktop.discover(id), workspace.id);
  for (const [id, expected] of [[archiveId, archiveTitle], [liveId, liveTitle]]) {
    assert.equal(directory.sessions.find(session => session.id === id)?.title, expected);
    const records = (await readFile(path.join(project, id + ".jsonl"), "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    assert.equal(records.filter(r => r.type === "custom-title").at(-1)?.customTitle, expected);
    assert.ok(records.filter(r => r.type === "user").every(r => !JSON.stringify(r.message).includes("/rename")));
  }
  const filter = page.getByRole("textbox", { name: "筛选项目和对话" });
  await filter.fill("秋季");
  assert.equal(await row(liveId).count(), 0);
  assert.equal(await row(archiveId).count(), 1);
  await filter.fill("");
  await page.reload();
  await header("primary").filter({ hasText: liveTitle }).waitFor();
  await header("secondary").filter({ hasText: archiveTitle }).waitFor();
  await pencil(archiveTitle).waitFor();
  await page.screenshot({ path: path.join(output, "renamed-views.png") });
  report.checks.push("native-format files, fresh discovery, filtering and reloaded panes preserve both titles");

  // Inject a transport failure at the IPC boundary for the final operation only.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("lectern:renameSession");
    ipcMain.handle("lectern:renameSession", () => { throw new Error("SSH 连接已中断"); });
  });
  await pencil(archiveTitle).click();
  await field.fill("网络中断时的草稿");
  await save.click();
  await dialog.getByRole("alert").filter({ hasText: "SSH 连接已中断" }).waitFor();
  assert.equal(await field.inputValue(), "网络中断时的草稿");
  assert.equal(await row(archiveId).locator(".session-title").innerText(), archiveTitle);
  assert.equal(await activeId(), liveId);
  await dialog.getByRole("button", { name: "取消" }).click();
  await dialog.waitFor({ state: "hidden" });
  report.checks.push("transport rejection preserves the unselected row, selection and editable draft");
  assert.deepEqual(pageErrors, []);
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = String(error.stack || error);
  await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, output }));
}
