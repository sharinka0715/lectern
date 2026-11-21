import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import nodeModule from 'node:module';
import { once } from 'node:events';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Backend, ReadResult } from '../src/backend';
import { Controller } from '../src/main/controller';
import type { WorkspaceStore } from '../src/main/store';
import { compactReceipt, CompactSamples, parseTurnProgress, showsCompactCompletion } from '../src/core/turn-progress';
import type { SessionSnapshot } from '../src/shared/types';

const border = '──────────────────────';
const editor = (hint = 'esc to interrupt') => `${border}\n❯ \n${border}\n  ⏵⏵ auto mode on (shift+tab to cycle)${hint ? ' · ' + hint : ''}\n`;
const withBox = (line: string, hint?: string) => `${line}\n\n${editor(hint)}`;
// Native 2.1.326 /compact in an isolated tmux + HOME with loopback SSE:
// 271 input and 22 output were supplied in the response, NOT in this boundary.
const compactRow = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: 'sample',
  compactMetadata: { trigger: 'manual', preTokens: 108, postTokens: 279, cumulativeDroppedTokens: 0, durationMs: 3344 } };
const badge = '                                       ◐ medium · /effort';
const compacting = withBox(`✳ Compacting conversation… (3s · ↓ 14 tokens)\n${badge}`);
const success = withBox(`❯ /compact\n  ⎿  Compacted (ctrl+o to see full summary)\n\n${badge}`, '← for agents');
const group = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('native viewports preserve activity, approximate count, direction and optional fields', () => {
  assert.deepEqual(parseTurnProgress(group('telemetry/manual-working.txt')), { activity: 'Gesticulating', elapsed: '3s', tokens: { display: '37', direction: 'down' } });
  const samples = JSON.parse(group('tools/native-grouped-headings.json')) as { name: string; viewport: string }[];
  assert.deepEqual(parseTurnProgress(samples.find(s => s.name.endsWith('7872'))!.viewport),
    { activity: 'Whirring', elapsed: '19s', tokens: { display: '1.7k', direction: 'down' }, detail: 'thinking' });
  assert.equal(parseTurnProgress(samples.at(-1)!.viewport), undefined, 'Cooked for … is a completed footer');
  assert.deepEqual(parseTurnProgress(withBox('\x1b[2m✻ Working… (20m 27s · ↑ 1,423 tokens)\x1b[0m')),
    { activity: 'Working', elapsed: '20m 27s', tokens: { display: '1,423', direction: 'up' } });
  assert.deepEqual(parseTurnProgress(withBox('· Working… (1.5k tokens)')), { activity: 'Working', tokens: { display: '1.5k' } });
  assert.deepEqual(parseTurnProgress(withBox('✢ Working…')), { activity: 'Working' });
  assert.deepEqual(parseTurnProgress('✶ Thinking…\nesc to interrupt\n'), { activity: 'Thinking' });
  assert.deepEqual(parseTurnProgress(withBox('✻ Thinking… (esc to interrupt)', '? for shortcuts')), { activity: 'Thinking' });
  assert.deepEqual(parseTurnProgress(withBox('∷ Compacting conversation', ''), undefined, true), { activity: 'Compacting conversation', compactPhase: 'compacting' });
});

test('read compact hook stages and an operation even when a verified task list intervenes', () => {
  assert.deepEqual(parseTurnProgress(compacting), { compactPhase: 'compacting', activity: 'Compacting conversation', elapsed: '3s', tokens: { direction: 'down', display: '14' } });
  assert.equal(parseTurnProgress(withBox('✢ Running PreCompact hooks… (2s)'))?.compactPhase, 'before');
  assert.equal(parseTurnProgress(withBox('∵ Running PostCompact hooks'))?.compactPhase, 'after');
  const tasks = '  1/3 tasks done · 1 in progress\n  ✔ Inspect fixture\n  ◼ Test fixture\n  ◻ Release fixture';
  const line = '✻ Compacting session… (20m 27s)';
  assert.deepEqual(parseTurnProgress(withBox(`${line}\n${tasks}\n${badge}`, 'esc to interrupt · ctrl+t to hide tasks')),
    { activity: 'Compacting session', compactPhase: 'compacting', elapsed: '20m 27s' });
  assert.equal(parseTurnProgress(withBox(`${line}\n${tasks}`)), undefined, 'quoted list without native footer does not bridge to old spinner');
  assert.equal(parseTurnProgress(withBox(`✻ Old…\n${tasks}\n✶ New…`, 'esc to interrupt · ctrl+t to hide tasks'))?.activity, 'New');
  assert.equal(showsCompactCompletion(success), true);
  assert.equal(showsCompactCompletion(withBox('❯ /compact\n  ⎿  Error during compaction: Not enough messages to compact.', '')), false);
});

test('ignore old frames, code, body text, drafts, menus and padding; never resurrect metrics from another line', () => {
  for (const viewport of [group('telemetry/manual-idle.txt'), group('telemetry/manual-draft.txt'),
    compacting + withBox('❯ New prompt\n● Finished', ''), withBox('✶ Thinking… (3s · ↓ 7 tokens)\n● This is a new reply.'),
    withBox('● ```text\n✻ Thinking… (esc to interrupt)'), withBox('  ✻ Thinking… (esc to interrupt)'),
    withBox('✶ Old… (1m · ↓ 22 tokens)') + 'Permission required\n❯ 1. Yes\nEnter to confirm · Esc to cancel',
    withBox('● Thinking…'), withBox('✶ Thinking… (3s)\n❯ /compact'), withBox('A spinner example: ✻ Thinking… (3s)'), '']) {
    assert.equal(parseTurnProgress(viewport), undefined, viewport);
  }
  assert.deepEqual(parseTurnProgress(withBox(`✻ First… (3s · ↓ 123 tokens)\n✶ Next…`)), { activity: 'Next' });
});

test('compact receipts accept only a recorded boundary and never impute missing fields from session totals', () => {
  const receipt = compactReceipt(compactRow)!;
  assert.deepEqual(receipt, { id: 'boundary', trigger: 'manual', durationMs: 3344, preTokens: 108, postTokens: 279, timestamp: undefined });
  for (const row of [{ ...compactRow, isSidechain: true }, { ...compactRow, type: 'assistant' }, { type: 'cost-state', durationMs: 3344 },
    { ...compactRow, compactMetadata: { durationMs: 0, preservedMessages: { anchorUuid: 'boundary' } } }]) assert.equal(compactReceipt(row), undefined);
  const missing = compactReceipt({ ...compactRow, durationMs: 12, usage: { output_tokens: 55 }, compactMetadata: { preTokens: 0, postTokens: -2, durationMs: '22' } })!;
  assert.equal(missing.durationMs, undefined); assert.equal(missing.preTokens, 0); assert.equal(missing.postTokens, undefined);
});

test('last observed compact estimate attaches only to the next proven completion in the same turn', () => {
  const live = parseTurnProgress(compacting)!, receipt = compactReceipt(compactRow)!;
  const start = () => { const s = new CompactSamples(); s.observe(live, 'u1', 0, undefined, false, 100); return s; };
  const s = start(); s.observe({ ...live, tokens: undefined }, 'u1', 0, undefined, false, 120);
  s.observe(undefined, 'u1', 0, undefined, true, 150); s.observe(undefined, 'u1', 1, receipt, false, 800);
  assert.deepEqual(s.receipt(receipt)?.lastObservedTokens, live.tokens);
  assert.equal(s.receipt({ ...receipt, id: 'other' })?.lastObservedTokens, undefined);
  for (const reason of ['turn', 'two boundaries', 'stale', 'interrupt', 'plain idle', 'ordinary progress', 'new compact', 'pre hook']) {
    const c = start();
    if (reason === 'interrupt') c.interrupt();
    if (reason === 'plain idle') c.observe(undefined, 'u1', 0, undefined, false, 300);
    if (reason === 'ordinary progress') c.observe({ activity: 'Thinking', tokens: { display: '123' } }, 'u1', 0, undefined, false, 300);
    const overlap = reason === 'new compact' ? live : reason === 'pre hook' ? { ...live, compactPhase: 'before' as const } : undefined;
    c.observe(overlap, reason === 'turn' ? 'u2' : 'u1', reason === 'two boundaries' ? 2 : 1, receipt, false, reason === 'stale' ? 9600 : 400);
    assert.equal(c.receipt(receipt)?.lastObservedTokens, undefined, reason);
  }
});

// Node has no CSS loader; the renderer normally gets this stylesheet via Vite.
const cssHook = nodeModule.registerHooks?.({ load(url, context, next) {
  return url.endsWith('/turn-progress.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
// registerHooks first appeared in 22.15; the project's minimum is 22.12.
if (!cssHook) nodeModule.register(`data:text/javascript,${encodeURIComponent("export function load(url, context, next) { return url.endsWith('/turn-progress.css') ? {format:'module',source:'',shortCircuit:true} : next(url,context); }")}`);
const { TurnProgress } = await import('../src/renderer/TurnProgress');
cssHook?.deregister();
function render(snapshot?: Pick<SessionSnapshot, 'sessionId' | 'turnProgress' | 'lastCompact'>) {
  return renderToStaticMarkup(createElement(TurnProgress, { snapshot }));
}

test('controller projects native progress to the rendered row, completes it, and never revives it on history opens', { timeout: 7500 }, async () => {
  const ws = { id: 'w', name: 'work', kind: 'local', cwd: '/tmp' };
  const store = { get: () => ws } as unknown as WorkspaceStore;
  let viewport: string | undefined = compacting, active = true, rows: unknown[] = [], fail = false;
  const backend = {
    resetRead() {}, dispose() {}, readSession: async (_w: unknown, id: string): Promise<ReadResult> => {
      if (fail) throw Error('disconnected');
      const incoming = rows; rows = [];
      return { session: { id, title: id, mapping: 'manual', paneId: active ? '%1' : undefined }, panePid: active ? 12 : undefined,
        screen: compacting, viewport, active, hasMore: false, reset: false, jsonl: Buffer.from(incoming.map(r => JSON.stringify(r) + '\n').join('')) };
    },
  } as unknown as Backend;
  const c = new Controller(store, backend);
  const next = async () => (await once(c, 'snapshot'))[0] as SessionSnapshot;
  try {
    const first = await c.watchSession('w', 'sample');
    assert.match(render(first), /Compacting session/); assert.match(render(first), /3s/); assert.match(render(first), /↓ 14 tokens/);
    viewport = success; assert.equal((await next()).turnProgress, undefined);
    rows = [compactRow, { ...compactRow, uuid: 'foreign', sessionId: 'different' }, { ...compactRow, uuid: 'sidechain', isSidechain: true }];
    const done = await next(); assert.equal(done.lastCompact?.id, 'boundary');
    assert.deepEqual(done.lastCompact?.lastObservedTokens, { direction: 'down', display: '14' });
    const summary = render(done);
    assert.match(summary, /原屏末次估算 ↓ 14 tokens/); assert.match(summary, /压缩前 108 tokens/); assert.match(summary, /压缩后 279 tokens/);
    assert.match(summary, /实际消耗未上报/); assert.doesNotMatch(summary, /turn-progress-dots|271 tokens|22 tokens/);
    viewport = compacting; assert.ok((await next()).turnProgress);
    fail = true; assert.equal((await next()).turnProgress, undefined); fail = false;
    viewport = undefined;
    assert.equal(render(await c.watchSession('w', 'different')), '', 'full scrollback and previous watch must not supply progress');
    active = false; rows = [compactRow]; viewport = compacting;
    const historical = await c.watchSession('w', 'sample'); assert.equal(historical.turnProgress, undefined); assert.equal(historical.lastCompact?.lastObservedTokens, undefined);
    assert.match(render(historical), /上次压缩完成/); assert.doesNotMatch(render(historical), /14 tokens/);
    assert.match(render({ sessionId: 'sample', lastCompact: { id: 'no-timing' } }), /耗时未记录/);
  } finally { await c.dispose(); }
});
