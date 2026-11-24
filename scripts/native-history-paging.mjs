// Read-only opt-in benchmark. Pass a long native projects/<slug>/<UUID>.jsonl.
// The reference scan runs outside the timed application reads. No conversation
// text or identifiers are written to the report, and no Claude process is started.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Backend } from '../src/backend/index.ts';
import { Controller } from '../src/main/controller.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { configureDiagnostics, flushDiagnostics, closeDiagnostics } from '../src/diagnostics/index.ts';

const input = process.argv[2];
if (!input) throw new Error('Pass an existing long compacted native session .jsonl file');
const file = await realpath(input);
const session = path.basename(file, '.jsonl');
const config = path.dirname(path.dirname(path.dirname(file)));
const digest = text => createHash('sha256').update(text.trim()).digest('hex');
const prompts = new Map();
let cwd, end = 0, lastCompact = -1, compactions = 0;
for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
  const offset = end;
  end += Buffer.byteLength(line) + 1;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (row.isSidechain || row.sessionId && row.sessionId !== session) continue;
  if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
  if (row.type === 'system' && row.subtype === 'compact_boundary') {
    compactions++; lastCompact = offset;
  }
  if (row.type === 'user' && !row.isMeta && !row.isCompactSummary) {
    const content = row.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ?
      content.filter(part => part?.type === 'text').map(part => part.text).join('\n\n') : '';
    if (text.trim() && !text.trimStart().startsWith('<')) prompts.set(digest(text), offset);
  }
}
assert.ok(cwd && lastCompact >= 0 && (await stat(cwd)).isDirectory());
const size = (await stat(file)).size;
const probe = await mkdtemp(path.join(tmpdir(),'lectern-history-probe-'));
const logs = path.join(probe,'logs');
configureDiagnostics({ directory:logs, captureContent:false });
const report = { fileBytes:size, compactBoundaries:compactions, initialBytes:0, initialMessages:0, openMs:0, pages:[], olderHumanVerified:false };
const out = path.resolve('test-results','native-history-paging-'+Date.now());
process.env.CLAUDE_CONFIG_DIR = config;
const workspace = { id:'native-page-probe', name:'Pagination', kind:'local', cwd };
class MeasuredBackend extends Backend {
  async readSession(...args) {
    const result = await super.readSession(...args);
    if (result.reset) report.initialBytes = result.jsonl.length;
    return result;
  }
  async readOlderHistory(...args) {
    const page = await super.readOlderHistory(...args);
    report.pages.push({ bytes:page.jsonl.length, start:page.olderCursor?.before ?? 0 });
    return page;
  }
}
const backend = new MeasuredBackend({ tmuxSocket:'lectern-history-'+randomUUID() });
const store = new WorkspaceStore(probe);
const controller = new Controller(store,backend);
try {
  await store.save(workspace);
  const start = performance.now();
  let snapshot = await controller.watchSession(workspace.id,session);
  report.openMs = Math.round(performance.now()-start);
  report.initialMessages = snapshot.messages.length;
  await flushDiagnostics();
  const events = (await readFile(path.join(logs,'events.000.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const firstRead = events.find(event => event.event === 'backend.jsonl.read');
  assert.ok(firstRead?.data.windowBytes > 0 && firstRead.data.windowBytes < size / 4);
  report.initialWindowBytes = firstRead.data.windowBytes;
  assert.equal(snapshot.status,'idle');
  assert.ok(snapshot.historyPage?.hasOlder && snapshot.messages.length > 0);
  assert.ok(report.initialBytes > 0 && report.initialBytes < size / 4);
  const firstVisible = new Set(snapshot.messages.filter(m=>m.role==='user').map(m=>digest(m.text)));
  const latest = snapshot.messages.at(-1);
  while (snapshot.historyPage?.hasOlder && report.pages.length < 100 && !report.olderHumanVerified) {
    const pageStart = performance.now();
    snapshot = await controller.loadEarlierMessages(workspace.id,session,snapshot.historyPage.cursor);
    const metrics = report.pages.at(-1);
    metrics.elapsedMs = Math.round(performance.now()-pageStart);
    assert.equal(new Set(snapshot.messages.map(m=>m.id)).size,snapshot.messages.length);
    assert.ok(snapshot.messages.some(m=>m.id===latest.id && m.text===latest.text));
    if(metrics.start < lastCompact) report.olderHumanVerified = snapshot.messages.some(m=>{
      if (m.role!=='user') return false;
      const hash = digest(m.text), offset = prompts.get(hash);
      return !firstVisible.has(hash) && offset !== undefined && offset >= metrics.start && offset < lastCompact;
    });
  }
  assert.ok(report.olderHumanVerified, 'Scrolling should reveal a real human message recorded before the last compaction');
  report.visibleAfter = snapshot.messages.length;
  report.success = true;
} finally {
  await controller.dispose(); await closeDiagnostics(); await rm(probe,{recursive:true,force:true});
  await mkdir(out,{recursive:true}); await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,...report}));
}
