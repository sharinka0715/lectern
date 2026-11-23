// npm run build && node scripts/file-index-e2e.mjs [packaged-executable]
// `@` completion answered from the background file index. The working directory has
// a 120,000-file folder, a dependency tree and deep sources; another folder has a
// saved conversation. Checks that opening a conversation (or a new chat) indexes its
// folder before the first `@`, that the big folder is listed but not read until the
// user @s into it, that a name inside it is still found, and that a file added after
// the index expired shows up in the open list. Prints the measured latencies.
// FILE_INDEX_MEASURE_ONLY=1 only types and times (also on builds without the index).
// Local folders only, no Claude, no network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const measureOnly = process.env.FILE_INDEX_MEASURE_ONLY === '1';
const ttlMs = 8000, bigFiles = 120_000;
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-file-index-')));
const output = path.resolve('test-results', 'file-index-e2e-' + Date.now());
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), logs = path.join(output, 'diagnostics');
const repo = path.join(root, 'repo'), side = path.join(root, 'side');
const write = async (file, text = '') => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = {};
let app, page;

// The tree: sources, docs, a dependency tree and one folder with 120,000 files.
let started = Date.now();
await mkdir(output, { recursive: true });
for (const file of ['README.md', 'package.json', 'docs/guide/deep/needle-deep.md', 'node_modules/react/index.js', 'node_modules/react/cjs/react.development.js'])
  await write(path.join(repo, file), '# fixture\n');
for (let m = 0; m < 30; m++) for (let f = 0; f < 10; f++)
  await write(path.join(repo, 'src', `mod-${String(m).padStart(2, '0')}`, `file-${String(f).padStart(2, '0')}.ts`), 'export {};\n');
await mkdir(path.join(repo, 'big'));
execFileSync('/bin/sh', ['-c', `seq -f 'item-%06g.log' 0 ${bigFiles - 1} | xargs touch`], { cwd: path.join(repo, 'big') });
assert.equal((await readdir(path.join(repo, 'big'))).length, bigFiles);
results.treeSeconds = (Date.now() - started) / 1000;

// A saved conversation in a second folder: selecting it indexes that folder.
const sessionId = randomUUID(), at = new Date().toISOString(), first = randomUUID();
const project = path.join(config, 'projects', side.replace(/[^a-z0-9-]/gi, '-'));
await write(path.join(side, 'notes.md'));
await write(path.join(project, sessionId + '.jsonl'), [
  { type: 'user', uuid: first, sessionId, cwd: side, timestamp: at, message: { role: 'user', content: '旧的提问' } },
  { type: 'assistant', uuid: randomUUID(), parentUuid: first, sessionId, cwd: side, timestamp: at,
    message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: '旧的回复' }], stop_reason: 'end_turn' } },
].map(record => JSON.stringify(record)).join('\n') + '\n');
await write(path.join(profile, 'workspaces.json'), JSON.stringify([
  { id: 'big', name: '大仓库', kind: 'local', cwd: repo, claudeDir: config },
  { id: 'side', name: '旁边', kind: 'local', cwd: side, claudeDir: config },
]));

/** Scans the app logged (`completion.index.scanned`), oldest first. */
async function scans(workspaceId) {
  const files = (await readdir(logs).catch(() => [])).filter(name => /^events\.\d+\.jsonl$/.test(name)).sort();
  const events = [];
  for (const name of files) for (const line of (await readFile(path.join(logs, name), 'utf8')).split('\n')) {
    if (!line.includes('completion.index.scanned')) continue;
    try { const entry = JSON.parse(line); if (entry.event === 'completion.index.scanned' && entry.data.workspaceId === workspaceId) events.push(entry.data); } catch { /* partial line */ }
  }
  return events;
}
async function until(check, label, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(50)) { const value = await check(); if (value) return value; }
  throw new Error('Timed out: ' + label);
}
const composer = 'textarea[aria-label="发送给 Claude 的消息"]';
/** Types `text` into the empty composer (one character every `gap` ms) and times the
 * last keystroke to the moment an option containing `expect` is shown. */
async function timeList(label, text, expect, { gap = 0, timeout = measureOnly ? 10000 : 15000 } = {}) {
  await page.locator(composer).fill('');
  await page.waitForFunction(() => !document.querySelector('[role=option]'));
  const result = await page.evaluate(({ text, expect, gap, timeout, composer }) => new Promise(resolve => {
    const box = document.querySelector(composer);
    box.focus();
    let start = 0;
    const options = () => [...document.querySelectorAll('[role=option]')].map(option => option.textContent);
    const check = () => { if (start && options().some(t => t.includes(expect))) finish({ ms: performance.now() - start, options: options() }); };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish({ ms: null, options: options() }), timeout);
    function finish(value) { observer.disconnect(); clearTimeout(timer); resolve(value); }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const chars = [...text];
    const type = i => {
      if (i === chars.length - 1) start = performance.now();
      document.execCommand('insertText', false, chars[i]);
      if (i < chars.length - 1) setTimeout(() => type(i + 1), gap); else check();
    };
    if (gap) type(0); else { start = performance.now(); document.execCommand('insertText', false, text); check(); }
  }), { text, expect, gap, timeout, composer });
  results[label] = result.ms === null ? 'not shown' : Math.round(result.ms);
  console.log(`${label}: ${results[label]}${result.ms === null ? '' : ' ms'}  (${text})`);
  if (!measureOnly) assert.notEqual(result.ms, null, `${label}: no option with ${expect}; shown: ${result.options.join(' | ')}`);
  return result;
}

try {
  const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, TMUX_TMPDIR: root, CLAUDE_CONFIG_DIR: config,
    LECTERN_LOG_DIR: logs, LECTERN_DIAGNOSTIC_CONTENT: '0', LECTERN_FILE_INDEX_TTL_MS: String(ttlMs) };
  delete env.TMUX; delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860));

  // Selecting a saved conversation indexes its folder, before anything is typed.
  // (The app opens a new chat in the first folder at launch; the second one starts collapsed.)
  await page.locator('.workspace-row[data-workspace-id="side"] .workspace-toggle').click();
  await page.locator(`.session-row[data-session-id="${sessionId}"]`).click();
  await page.getByText('旧的回复', { exact: true }).waitFor();
  if (!measureOnly) await until(async () => (await scans('side')).length, 'the selected conversation indexes its folder');

  // A new chat in the big folder: its working directory is indexed in the background.
  await page.getByRole('button', { name: '在 大仓库 新建对话', exact: true }).click();
  await page.waitForFunction(selector => !document.querySelector(selector)?.matches(':disabled, [aria-disabled="true"]'), composer);
  const opened = Date.now();
  if (!measureOnly) {
    const [root] = await until(async () => { const found = await scans('big'); return found.length && found; }, 'the new chat indexes its working directory');
    results.rootScanMs = root.durationMs; results.rootEntries = root.entries;
    assert.equal(root.depth, 0);
    assert.ok(root.entries < 1000, `big/ is listed, not walked (${root.entries} entries)`);
  }
  await sleep(Math.max(0, 1500 - (Date.now() - opened)));

  await timeList('first @', '@', 'README.md');
  await page.screenshot({ path: path.join(output, '1-first-at.png') });
  await timeList('@READ (next keystroke)', '@READ', 'README.md');
  await timeList('@needle (deep name)', '@needle', 'docs/guide/deep/needle-deep.md');
  await timeList('@src/mod-07/ (subfolder)', '@src/mod-07/', 'src/mod-07/file-00.ts');
  await timeList('@src/ typed', '@src/mod-2', 'src/mod-20', { gap: 60 });
  if (!measureOnly) {
    // Nothing below big/ or node_modules/ is known until the user enters them.
    const before = await timeList('@item-0001 (not walked)', '@item-0001', 'item-000100', { timeout: 1500 }).catch(error => error);
    assert.ok(before instanceof assert.AssertionError, 'big/ was not walked');
    assert.ok((await scans('big')).every(scan => scan.depth === 0), 'only the working directory was scanned');
  }
  await timeList('@big/ (enter the big folder)', '@big/', 'big/item-');
  await page.screenshot({ path: path.join(output, '2-big-folder.png') });
  await timeList('@big/item-0 (inside big/)', '@big/item-0', 'big/item-0');
  // 10 matching names among 120,000: more than one listing holds, so the endpoint looks them up.
  await timeList('@big/item-07777 typed', '@big/item-07777', 'big/item-077770.log', { gap: 60 });
  await timeList('@big/item-11999 typed', '@big/item-11999', 'big/item-119990.log', { gap: 60 });
  await timeList('@node_modules/ (dependency tree)', '@node_modules/', 'node_modules/react');

  if (!measureOnly) {
    assert.ok((await scans('big')).some(scan => scan.depth === 1), 'entering big/ indexed it');
    for (const label of ['first @', '@READ (next keystroke)', '@needle (deep name)', '@big/item-0 (inside big/)']) assert.ok(results[label] < 1000, `${label}: ${results[label]} ms`);
    // Expiry: a fresh index answers from memory; once it is older than the TTL the
    // old list is answered at once and replaced in place when the rescan lands.
    const rootScans = async () => (await scans('big')).filter(scan => scan.depth === 0).length;
    await page.locator(composer).fill('');
    // Longer than the TTL: a rescan an earlier keystroke started has landed and expired too.
    await sleep(ttlMs + 2000);
    const before = await rootScans();
    await timeList('@ after expiry (stale list)', '@', 'README.md');
    await until(async () => await rootScans() > before, 'an expired index is rescanned');
    await write(path.join(repo, 'added-after-scan.md'));
    await rm(path.join(repo, 'README.md'));
    const scansWhileFresh = await rootScans();
    await timeList('@ while fresh', '@', 'package.json');
    await sleep(1000);
    const fresh = (await page.locator('[role=option]').allTextContents()).join('|');
    assert.ok(fresh.includes('README.md') && !fresh.includes('added-after-scan.md'), 'a fresh index answers from memory: ' + fresh);
    assert.equal(await rootScans(), scansWhileFresh, 'a fresh index is not rescanned');
    await page.locator(composer).fill('');
    await sleep(ttlMs);
    const stale = await timeList('@ after expiry', '@', 'package.json');
    assert.ok(stale.options.some(text => text.includes('README.md')), 'the expired list is shown at once');
    const shown = Date.now();
    await page.locator('[role=option]', { hasText: 'added-after-scan.md' }).waitFor();
    results['new file shown after expiry'] = Date.now() - shown;
    console.log(`new file shown after expiry: ${results['new file shown after expiry']} ms after the old list`);
    await page.locator('[role=option]', { hasText: 'README.md' }).waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(output, '3-after-expiry.png') });
    assert.deepEqual(errors, []);
  }
  await writeFile(path.join(output, 'latencies.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  console.log(measureOnly ? 'Latencies measured.' : 'File index: prefetch on open, lazy big folder, name search inside it, expiry refresh verified.');
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
