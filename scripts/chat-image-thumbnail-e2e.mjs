// 在隔离的会话中验证缩略图和原图分别读取，使用真实的 Electron IPC。
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';
import { spawnSync } from 'node:child_process';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-thumbnails-'));
const logs = path.join(profile, 'logs');
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: logs, LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
const executablePath = process.argv[2];
// Workspace thumbnails come from the target: sips on macOS, python3 with Pillow elsewhere.
const workspaceThumbnails = process.platform === 'darwin' || spawnSync('python3', ['-I', '-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
let app;
try {
  app = await electron.launch({ ...(executablePath && { executablePath: path.resolve(executablePath) }), args: [...(executablePath ? [] : ['.']), '--demo'], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator('.message-assistant').first().waitFor();
  const { file, sessionId, cwd, base64 } = await page.evaluate(async () => {
    const createUrl = URL.createObjectURL.bind(URL);
    window.imageBlobSizes = new Map();
    URL.createObjectURL = blob => {
      const url = createUrl(blob);
      window.imageBlobSizes.set(url, blob.size);
      return url;
    };
    const [ws] = await window.desktop.listWorkspaces();
    const [session] = (await window.desktop.discover(ws.id)).sessions;
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
    gradient.addColorStop(0, '#246193');
    gradient.addColorStop(1, '#ffeabe');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const revokeUrl = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { window.imageBlobSizes.delete(url); revokeUrl(url); };
    return { file: session.path, cwd: ws.cwd, sessionId: session.id, base64: canvas.toDataURL('image/png').split(',')[1] };
  });
  const bytes = Buffer.from(base64, 'base64');
  await writeFile(path.join(cwd, 'thumbnail-test.png'), bytes);
  const user = { uuid: randomUUID(), sessionId, cwd, type: 'user', message: { role: 'user', content: [
    { type: 'text', text: '检查缩略图' }, { type: 'image', title: '记录内的图片', source: { type: 'base64', media_type: 'image/png', data: base64 } },
  ] } };
  const assistant = { uuid: randomUUID(), parentUuid: user.uuid, sessionId, cwd, type: 'assistant', message: {
    role: 'assistant', id: randomUUID(), stop_reason: 'end_turn', content: '![工作区的图片](thumbnail-test.png)',
  } };
  await appendFile(file, `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);

  async function originalRequests() {
    await page.evaluate(() => window.desktop.markDiagnosticIncident('图片读取计数'));
    const names = (await readdir(logs)).filter(name => /^events\.\d+\.jsonl$/.test(name));
    const events = (await Promise.all(names.map(name => readFile(path.join(logs, name), 'utf8'))))
      .flatMap(text => text.split('\n').slice(0, -1).map(line => JSON.parse(line).event));
    return ['previewMessageAttachment', 'previewInlineImage'].map(name => events.filter(event => event === `ipc.${name}.start`).length);
  }
  for (const name of ['记录内的图片', '工作区的图片']) {
    const button = page.getByRole('button', { name: `放大 ${name}`, exact: true });
    await button.scrollIntoViewIfNeeded();
    if (name === '工作区的图片' && !workspaceThumbnails) {
      // Linux without Pillow has no converter: a clickable placeholder, and no original is read.
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(await button.locator('img').count(), 0);
      console.log('NOTE: python3 Pillow is not installed, so the workspace thumbnail was checked as a placeholder.');
      continue;
    }
    const thumb = await button.locator('img').evaluate(async img => {
      await img.decode();
      const button = img.closest('button');
      const shown = img.getBoundingClientRect(), box = button.getBoundingClientRect();
      return { width: img.naturalWidth, height: img.naturalHeight, displayHeight: box.height, displayWidth: box.width,
        shownRatio: shown.width / shown.height, imageWidth: shown.width,
        lineHeight: parseFloat(getComputedStyle(button).lineHeight), bytes: window.imageBlobSizes.get(img.src) };
    });
    // The original proportions at a fixed height: the frame hugs the image, no blank margins.
    assert.ok(Math.abs(thumb.shownRatio - 1280 / 720) < 0.03, JSON.stringify(thumb));
    assert.ok(thumb.displayWidth - thumb.imageWidth <= 3, JSON.stringify(thumb));
    assert.ok(thumb.width < 1280 && thumb.height < 720 && thumb.bytes < bytes.length, JSON.stringify(thumb));
    assert.ok(Math.abs(thumb.displayHeight - 2 * thumb.lineHeight) <= 1, JSON.stringify(thumb));
    console.log(`${name}：原图 1280×720、${bytes.length} 字节，缩略图 ${thumb.width}×${thumb.height}、${thumb.bytes} 字节，显示高度 ${thumb.displayHeight}px`);
  }
  assert.deepEqual(await originalRequests(), [0, 0], '浏览两张缩略图时应当没有原图请求');

  const copySizes = () => app.evaluate(() => globalThis.copiedImageSizes);
  await app.evaluate(({ clipboard, nativeImage }) => {
    globalThis.copiedImageSizes = [];
    clipboard.write = async ([item]) => {
      const png = await item.getType('image/png');
      globalThis.copiedImageSizes.push(nativeImage.createFromBuffer(Buffer.from(await png.arrayBuffer())).getSize());
    };
  });
  for (const [index, name] of ['记录内的图片', '工作区的图片'].entries()) {
    await page.getByRole('button', { name: `放大 ${name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `图片预览 · ${name}` });
    const original = await dialog.getByRole('img', { name, exact: true }).evaluate(async img => {
      await img.decode();
      return { size: [img.naturalWidth, img.naturalHeight], url: img.src };
    });
    assert.deepEqual(original.size, [1280, 720]);
    await dialog.getByRole('button', { name: '原始尺寸' }).click();
    assert.equal((await dialog.getByRole('img', { name, exact: true }).boundingBox()).width, 1280);
    await dialog.getByRole('button', { name: '关闭图片预览' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(url => !window.imageBlobSizes.has(url), original.url);
    assert.deepEqual(await originalRequests(), [1, index], '每次点击只加载选中的原图');
  }
  const embedded = page.getByRole('button', { name: '放大 记录内的图片', exact: true });
  await embedded.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制图片' }).click();
  await page.waitForFunction(() => !document.querySelector('.chat-image-menu'));
  const deadline = Date.now() + 5000;
  while (!(await copySizes()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await copySizes(), [{ width: 1280, height: 720 }]);
  const saved = path.join(profile, 'saved.png');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, saved);
  await embedded.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '下载原图' }).click();
  const saveDeadline = Date.now() + 5000;
  while (!(await readFile(saved).catch(() => undefined)) && Date.now() < saveDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await readFile(saved), bytes);
  // 旧缩略图仍在内存时删除原件；打开应显示读取错误，恢复文件后可再次点击读取。
  const workspaceFile = path.join(cwd, 'thumbnail-test.png');
  const workspaceButton = page.getByRole('button', { name: '放大 工作区的图片', exact: true });
  const workspaceDialog = page.getByRole('dialog', { name: '图片预览 · 工作区的图片' });
  await rm(workspaceFile);
  await workspaceButton.click();
  await workspaceDialog.getByRole('alert').waitFor();
  await page.keyboard.press('Escape');
  await workspaceDialog.waitFor({ state: 'detached' });
  await writeFile(workspaceFile, bytes);
  await workspaceButton.click();
  assert.equal(await workspaceDialog.getByRole('img', { name: '工作区的图片', exact: true }).evaluate(async img => { await img.decode(); return img.naturalWidth; }), 1280);
  console.log('通过：浏览时零次原图请求，点击逐张读取原图，关闭释放原图，复制与下载保留原件，文件恢复后可重试。');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
