// 离线历史：在真实 Electron 中记录首屏 / 上翻文字出现的时刻、图片请求和传输字节。
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

function png(seed) {
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(data, crc32(name)));
    return Buffer.concat([length, name, data, checksum]);
  };
  const w = 400, h = 256, row = w * 3 + 1;
  const pixels = Buffer.alloc(row * h);
  let v = seed + 1;
  for (let y = 0; y < h; y++) for (let x = 1; x < row; x++) {
    v = (Math.imul(v, 1664525) + 1013904223) >>> 0; pixels[row * y + x] = v >>> 24;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-history-images-')));
const cwd = path.join(root,'work'), profile = path.join(root,'profile'), config = path.join(root,'claude'), logs = path.join(root,'logs');
const project = path.join(config,'projects',cwd.replace(/[^a-z0-9-]/gi, '-')), sid = randomUUID();
const olderText = '更早一轮的图文结论', latestText = '最新一轮的图文结论';
let app;
try {
  await Promise.all([cwd, profile, project].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id:'fixture', name:'多图历史', cwd, kind:'local' }]));
  let parentUuid = null;
  const line = (type, content) => {
    const uuid = randomUUID();
    const result = { cwd, sessionId:sid, type, parentUuid, uuid, timestamp: new Date().toISOString(),
      message: { role:type, content, ...(type === 'assistant' && { id:uuid, stop_reason:'end_turn' }) } };
    parentUuid = uuid;
    return JSON.stringify(result) + '\n';
  };
  const files = Array.from({ length:12 }, (_, i) => png(i));
  const img = i => ({ type:'image', title:`样图 ${i}`, source:{ type:'base64', media_type:'image/png', data:files[i].toString('base64') } });
  const text = text => ({ type:'text', text });
  const file = path.join(project, sid + '.jsonl');
  const jsonl = line('user', '检查第一批图片') + line('assistant', [...files.slice(0,9).map((_, i) => img(i)), text(olderText)]) +
    line('user', '检查第二批图片') + line('assistant', [img(9), text('比较开始'), img(10), img(11), text(latestText)]);
  await writeFile(file, jsonl);
  const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA:profile, CLAUDE_CONFIG_DIR:config, TMUX_TMPDIR:root, LECTERN_LOG_DIR:logs, LECTERN_DIAGNOSTIC_CONTENT:'0' };
  delete env.TMUX; delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath:path.resolve(exe) }), env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  // At startup the folder opens its newest conversation by itself, which may come
  // before the click below (it does on fast Linux runs). Watch from the first
  // script on, and record the frame in which the latest reply's text first appears.
  await page.addInitScript(caption => {
    const start = performance.now();
    window.__tailFrame = new Promise(resolve => {
      const mo = new MutationObserver(() => {
        const body = [...document.querySelectorAll('.message .markdown')].find(el => el.textContent === caption);
        if (!body) return;
        mo.disconnect();
        const inDomMs = Math.round(performance.now() - start);
        requestAnimationFrame(() => resolve({ inDomMs, frameMs: Math.round(performance.now() - start),
          thumbnails: body.closest('.message').querySelectorAll('.chat-image-open img').length }));
      });
      mo.observe(document, { childList: true, subtree: true, characterData: true });
    });
  }, latestText);
  await page.reload();
  const open = page.locator(`.session-row[data-session-id="${sid}"]`);
  await open.waitFor();
  async function firstFrame(trigger, caption) {
    return trigger.evaluate((button, caption) => new Promise((resolve, reject) => {
      const start = performance.now();
      const timer = setTimeout(() => { mo.disconnect(); reject(new Error('没有等到正文：' + caption)); }, 15000);
      const mo = new MutationObserver(() => {
        const body = [...document.querySelectorAll('.message .markdown')].find(el => el.textContent === caption);
        if (!body) return;
        mo.disconnect(); clearTimeout(timer);
        const inDomMs = Math.round(performance.now() - start);
        requestAnimationFrame(() => {
          const message = body.closest('.message');
          resolve({ inDomMs, frameMs:Math.round(performance.now() - start), thumbnails:message.querySelectorAll('.chat-image-open img').length });
        });
      });
      mo.observe(document.body, { childList:true, subtree:true, characterData:true });
      button.click();
    }), caption);
  }
  if (!await open.evaluate(row => row.classList.contains('active'))) await open.click();
  const tail = await page.evaluate(() => window.__tailFrame);
  assert.deepEqual(await page.locator('.message .user-text').allTextContents(), ['检查第二批图片']);
  assert.equal(await page.locator('.message .chat-image').count(), 3);
  const more = page.getByRole('button', { name:'加载更早的消息', exact:true });
  const older = await firstFrame(more, olderText);
  assert.equal(await page.locator('.message .chat-image').count(), 12);
  assert.equal(await page.locator('.message .user-text').count(), 2);
  async function events() {
    await page.evaluate(() => window.desktop.markDiagnosticIncident('多图历史传输计数'));
    const names = (await readdir(logs)).filter(name => /^events\.\d+\.jsonl$/.test(name));
    return (await Promise.all(names.map(name => readFile(path.join(logs,name),'utf8')))).flatMap(s => s.split('\n').slice(0,-1).map(line => JSON.parse(line)));
  }
  const rows = await events();
  const reads = rows.filter(e => e.event === 'transport.command.exited' && e.context.sessionId === sid && ['session.poll','session.history_page'].includes(e.context.commandTag));
  assert.ok(reads.length);
  const wireBytes = reads.reduce((n,e) => n + e.data.stdoutBytes, 0);
  console.log(JSON.stringify({ fileBytes:Buffer.byteLength(jsonl), images:12, historyWireBytes:wireBytes, tail, older }));
  assert.ok(wireBytes >= Buffer.byteLength(jsonl), '两页历史应包含所有内嵌图片的原始数据');
  assert.equal(tail.thumbnails, 0); assert.equal(older.thumbnails, 0);
  assert.ok(!rows.some(e => e.event === 'ipc.previewMessageAttachment.start'));
  const name = '样图 7', button = page.getByRole('button', { name:`放大 ${name}`, exact:true });
  await button.scrollIntoViewIfNeeded();
  const width = await button.locator('img').evaluate(async img => { await img.decode(); return img.naturalWidth; });
  assert.ok(width > 0 && width <= 240);
  await button.click();
  const dialog = page.getByRole('dialog', { name:`图片预览 · ${name}` });
  assert.deepEqual(await dialog.getByRole('img', { name, exact:true }).evaluate(async img => { await img.decode(); return [img.naturalWidth,img.naturalHeight]; }), [400,256]);
  const saved = path.join(root,'saved.png');
  await app.evaluate(({dialog}, filePath) => { dialog.showSaveDialog = async () => ({canceled:false,filePath}); }, saved);
  await dialog.getByRole('button', {name:'下载原图'}).click();
  const until = Date.now() + 8000;
  let bytes;
  while (Date.now() < until && !bytes) { bytes = await readFile(saved).catch(() => undefined); if (!bytes) await new Promise(done => setTimeout(done,50)); }
  assert.deepEqual(bytes, files[7]);
  const final = await events();
  assert.equal(final.filter(e => e.event === 'ipc.previewMessageAttachment.start').length, 1);
  const imageTraces = new Set(final.filter(e => /^ipc\.(previewMessageAttachment(?:Thumbnail)?|downloadMessageAttachment)\.start$/.test(e.event)).map(e => e.context.traceId));
  assert.ok(!final.some(e => e.event === 'transport.command.request' && imageTraces.has(e.context.traceId)), '内嵌图片的缩略图、放大和下载都应使用桌面端已收到的数据');
  console.log('通过：两页历史完整传回 12 张图，正文异步显示缩略图，放大和下载直接使用已收到的原图。');
} finally { await app?.close(); await rm(root,{ recursive:true, force:true }); }
