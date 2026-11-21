// 活动卡片的「附件」：每张图片显示自己的缩略图，长边居中裁成正方形；只为可见条目读取；非图片文件保留图标。
// 宽图内嵌在会话记录里（桌面端编码），高图和其余图片按路径附加在项目文件夹外，方图在项目文件夹内（目标机编码）。
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-attachment-thumbs-'));
const logs = path.join(profile, 'logs'), uploads = path.join(profile, 'uploads');
const results = path.resolve('test-results', 'attachment-thumbnails');
await mkdir(results, { recursive: true });
await mkdir(uploads);
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: logs, LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_NODE_BINARY: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LECTERN_DEV_URL;
const executablePath = process.argv[2];
// Files are thumbnailed on their machine: sips on macOS, python3 with Pillow elsewhere. Embedded images need neither.
const fileThumbnails = process.platform === 'darwin' || spawnSync('python3', ['-I', '-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
const palette = { red: [216, 50, 50], green: [46, 170, 74], blue: [42, 90, 216], yellow: [230, 200, 40], purple: [130, 70, 170] };
const EXTRAS = 14;

/** Draws the test images in the renderer: only the centered square of the wide and tall ones is green or blue. */
function drawImages({ palette, extras }) {
  const rgb = name => `rgb(${palette[name].join(',')})`;
  const draw = (width, height, paint) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    paint(canvas.getContext('2d'));
    return canvas.toDataURL('image/png').split(',')[1];
  };
  const fill = (ctx, name, x, y, w, h) => { ctx.fillStyle = rgb(name); ctx.fillRect(x, y, w, h); };
  return {
    wide: draw(1200, 300, ctx => { fill(ctx, 'red', 0, 0, 1200, 300); fill(ctx, 'green', 450, 0, 300, 300); }),
    tall: draw(300, 1200, ctx => { fill(ctx, 'yellow', 0, 0, 300, 1200); fill(ctx, 'blue', 0, 450, 300, 300); }),
    square: draw(600, 600, ctx => {
      fill(ctx, 'red', 0, 0, 300, 300); fill(ctx, 'green', 300, 0, 300, 300);
      fill(ctx, 'blue', 0, 300, 300, 300); fill(ctx, 'yellow', 300, 300, 300, 300);
    }),
    extras: Array.from({ length: extras }, () => draw(200, 200, ctx => fill(ctx, 'purple', 0, 0, 200, 200))),
  };
}

/** The palette color nearest to each sampled point of a slot's screenshot (fractions of its width and height). */
async function sample(page, slot, points) {
  const png = (await slot.screenshot()).toString('base64');
  const colors = await page.evaluate(async ({ png, points }) => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return Object.fromEntries(Object.entries(points).map(([name, [fx, fy]]) =>
      [name, [...ctx.getImageData(Math.floor(fx * bitmap.width), Math.floor(fy * bitmap.height), 1, 1).data.slice(0, 3)]]));
  }, { png, points });
  const nearest = rgb => Object.entries(palette).map(([name, c]) => [name, c.reduce((sum, v, i) => sum + (v - rgb[i]) ** 2, 0)])
    .sort((a, b) => a[1] - b[1])[0];
  return Object.fromEntries(Object.entries(colors).map(([name, rgb]) => {
    const [color, distance] = nearest(rgb);
    return [name, distance < 60 ** 2 ? color : `other(${rgb})`];
  }));
}

const inset = { tl: [.25, .25], tr: [.75, .25], bl: [.25, .75], br: [.75, .75], center: [.5, .5],
  left: [.14, .5], right: [.86, .5], top: [.5, .14], bottom: [.5, .86] };
const quadrants = { tl: [.25, .25], tr: [.75, .25], bl: [.25, .75], br: [.75, .75] };

async function ipcStarts(page, names) {
  await page.evaluate(() => window.desktop.markDiagnosticIncident('附件缩略图计数'));
  const files = (await readdir(logs)).filter(name => /^events\.\d+\.jsonl$/.test(name));
  const events = (await Promise.all(files.map(name => readFile(path.join(logs, name), 'utf8'))))
    .flatMap(text => text.split('\n').slice(0, -1).map(line => JSON.parse(line).event));
  return Object.fromEntries(names.map(name => [name, events.filter(event => event === `ipc.${name}.start`).length]));
}

let app, page;
try {
  app = await electron.launch({ ...(executablePath && { executablePath: path.resolve(executablePath) }), args: [...(executablePath ? [] : ['.']), '--demo'], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator('.message-assistant').first().waitFor();
  const { file, sessionId, cwd } = await page.evaluate(async () => {
    const [ws] = await window.desktop.listWorkspaces();
    const [session] = (await window.desktop.discover(ws.id)).sessions;
    return { file: session.path, cwd: ws.cwd, sessionId: session.id };
  });
  const images = await page.evaluate(drawImages, { palette, extras: EXTRAS });
  // Paths as a pasted image's upload has them: outside the project, below the temporary directory.
  const tall = path.join(uploads, 'tall.png'), square = path.join(cwd, 'square.png'), notes = path.join(uploads, 'notes.txt');
  const extras = images.extras.map((_, i) => path.join(uploads, `extra-${String(i + 1).padStart(2, '0')}.png`));
  await writeFile(tall, Buffer.from(images.tall, 'base64'));
  await writeFile(square, Buffer.from(images.square, 'base64'));
  await writeFile(notes, '不是图片\n');
  await Promise.all(extras.map((name, i) => writeFile(name, Buffer.from(images.extras[i], 'base64'))));
  const user = { uuid: randomUUID(), sessionId, cwd, type: 'user', message: { role: 'user', content: [
    { type: 'text', text: '看看这些附件' }, { type: 'image', title: 'wide.png', source: { type: 'base64', media_type: 'image/png', data: images.wide } },
  ] } };
  // Claude Code records each @ file as an attachment row after the prompt.
  let parentUuid = user.uuid;
  const attached = [tall, square, notes, ...extras].map(filename => {
    const row = { uuid: randomUUID(), parentUuid, sessionId, cwd, type: 'attachment', attachment: { type: 'file', filename, displayPath: filename } };
    parentUuid = row.uuid;
    return row;
  });
  const reply = { uuid: randomUUID(), parentUuid, sessionId, cwd, type: 'assistant', message: {
    role: 'assistant', id: randomUUID(), stop_reason: 'end_turn', content: '已收到附件。' } };
  await appendFile(file, [user, ...attached, reply].map(row => JSON.stringify(row) + '\n').join(''));
  const total = 4 + EXTRAS;

  const panel = page.locator('.activity-float');
  if (!await panel.count()) await page.getByRole('button', { name: '查看会话活动' }).click();
  await panel.waitFor();
  const section = panel.getByRole('button', { name: /^附件/ });
  await section.locator('.activity-float-summary', { hasText: `${total} 个` }).waitFor();
  await section.click();
  const entries = panel.locator('.activity-float-attachments li');
  await page.waitForFunction(n => document.querySelectorAll('.activity-float-attachments li').length === n, total);
  assert.deepEqual(await entries.locator('button').evaluateAll(buttons => buttons.slice(0, 4).map(b => b.textContent)),
    ['wide.png', 'tall.png', 'square.png', 'notes.txt']);

  // Lazy: only entries inside the list's scrolled view load; their thumbnails arrive two at a time.
  const layout = () => page.evaluate(() => {
    const view = document.querySelector('.activity-float-attachments').closest('.activity-float-body').getBoundingClientRect();
    return [...document.querySelectorAll('.activity-float-attachments li')].map(li => {
      const box = li.getBoundingClientRect(), slot = li.querySelector('.activity-float-thumb');
      // Shown: overlapping the view; hidden: clear of it (an entry touching the edge counts as neither).
      return { name: li.textContent, shown: box.bottom > view.top + 1 && box.top < view.bottom - 1,
        hidden: box.top > view.bottom + 1 || box.bottom < view.top - 1, state: slot.dataset.thumbnail,
        img: !!slot.querySelector('img'), icon: !!slot.querySelector('svg') };
    });
  });
  const loads = name => name === 'wide.png' || fileThumbnails && name !== 'notes.txt';
  const settled = async predicate => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const rows = await layout();
      if (predicate(rows)) return rows;
      if (Date.now() > deadline) throw new Error('Thumbnails did not settle: ' + JSON.stringify(rows));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await settled(rows => rows.every(row => !row.shown || !loads(row.name) || row.state === 'image'));
  await new Promise(resolve => setTimeout(resolve, 1500));
  const before = await layout(), hidden = before.filter(row => row.hidden), reachable = before.filter(row => !row.hidden && row.name !== 'notes.txt');
  assert.ok(hidden.length >= 3, 'the list scrolls: ' + JSON.stringify(before));
  assert.ok(hidden.every(row => row.state === 'icon' && row.icon && !row.img), 'entries out of view keep their icon: ' + JSON.stringify(hidden));
  const requests = await ipcStarts(page, ['previewMessageAttachmentThumbnail', 'previewMessageAttachment', 'previewArtifact', 'previewInlineImage']);
  // The chat's own thumbnail of the embedded image uses the same call once.
  assert.ok(requests.previewMessageAttachmentThumbnail <= reachable.length + 1, JSON.stringify({ requests, reachable: reachable.length }));
  assert.deepEqual([requests.previewMessageAttachment, requests.previewArtifact, requests.previewInlineImage], [0, 0, 0], 'no original is read');

  const slot = name => entries.filter({ hasText: name }).locator('.activity-float-thumb');
  const notesRow = before.find(row => row.name === 'notes.txt');
  assert.ok(notesRow.state === 'icon' && notesRow.icon && !notesRow.img, 'a file that is not an image keeps its icon');
  const checks = [['wide.png', inset, 'green'], ['tall.png', inset, 'blue'],
    ['square.png', quadrants, { tl: 'red', tr: 'green', bl: 'blue', br: 'yellow' }]];
  for (const [name, points, expected] of checks) {
    if (!loads(name)) {
      assert.equal(await slot(name).locator('img').count(), 0);
      console.log(`NOTE: python3 Pillow is not installed, so ${name} was checked as an icon placeholder.`);
      continue;
    }
    const style = await slot(name).locator('img').evaluate(img => {
      const css = getComputedStyle(img), box = img.getBoundingClientRect(), frame = img.parentElement.getBoundingClientRect();
      return { fit: css.objectFit, position: css.objectPosition, width: box.width, height: box.height, natural: [img.naturalWidth, img.naturalHeight],
        frame: [frame.left - box.left, frame.top - box.top, frame.width, frame.height] };
    });
    // The image's own box is the slot's square; the pixels below check what cover shows of it.
    assert.deepEqual([style.fit, style.position, style.width, style.frame], ['cover', '50% 50%', style.height, [0, 0, style.width, style.height]], JSON.stringify(style));
    const seen = await sample(page, slot(name), points);
    const want = typeof expected === 'string' ? Object.fromEntries(Object.keys(points).map(key => [key, expected])) : expected;
    assert.deepEqual(seen, want, `${name} is center-cropped to a square`);
    console.log(`${name}：缩略图 ${style.natural.join('×')}，显示为 ${style.width}×${style.height} 的正方形，采样 ${JSON.stringify(seen)}`);
  }
  await panel.screenshot({ path: path.join(results, 'activity-attachments.png') });

  // Scrolling the list loads the entries that come into view.
  await page.evaluate(() => {
    const view = document.querySelector('.activity-float-attachments').closest('.activity-float-body');
    view.scrollTop = view.scrollHeight;
  });
  const last = path.basename(extras.at(-1));
  if (fileThumbnails) {
    await settled(rows => rows.find(row => row.name === last).state === 'image');
    assert.deepEqual(await sample(page, slot(last), quadrants), { tl: 'purple', tr: 'purple', bl: 'purple', br: 'purple' });
  }
  await panel.screenshot({ path: path.join(results, 'activity-attachments-scrolled.png') });
  // Folding the section and opening it again shows the same thumbnails (the unchanged files come from the cache).
  await section.click();
  await section.click();
  if (fileThumbnails) await page.locator('.activity-float-attachments li', { hasText: 'square.png' }).locator('img').waitFor();
  await page.locator('.activity-float-attachments li', { hasText: 'wide.png' }).locator('img').waitFor();
  console.log(`通过：${total} 个附件中图片各显示自己居中裁成正方形的缩略图，看不到的条目滚动到时才读取，非图片保留图标，从不读取原图。`);
} catch (error) {
  await page?.screenshot({ path: path.join(results, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
