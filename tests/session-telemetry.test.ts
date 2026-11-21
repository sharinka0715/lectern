import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseExecutionMode, SessionTelemetry } from '../src/core/session-telemetry';

const rule = '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────';
const footer = (badge: string) => `${rule}\n❯\u00a0\n${rule}\n  ${badge}\n`;
const jsonl = (...records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const context = (telemetry: SessionTelemetry) => telemetry.context;
const usage = (input = 17063, read = 11905, creation = 3) => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: creation, output_tokens: 22,
});
const assistant = (uuid: string, values: Record<string, unknown> = usage(), stop: string | null = 'end_turn', id = uuid) => ({
  type: 'assistant', uuid, isSidechain: false, timestamp: '2026-11-17T17:39:57.000Z',
  message: { id, role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: stop, usage: values, content: [{ type: 'text', text: 'Fixture' }] },
});
const user = (uuid: string) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text: 'Fixture prompt' }] } });

test('execution mode reads the recorded native footer below its boxed input', () => {
  // Native v2.1.326 captures in native-ssh-tools and model-inspect have this
  // badge, NBSP input spacing, optional agent hint and blank pane padding.
  const screen = `● Response text\n\n${footer('⏵⏵ auto mode on (shift+tab to cycle) · ← for agents')}\n\n`;
  assert.deepEqual(parseExecutionMode(screen), {
    mode: 'auto', label: '自动', source: 'native-footer',
    evidence: '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
  });
  assert.equal(parseExecutionMode(`\x1b[32m${screen}\x1b[0m`)?.mode, 'auto');
});

test('recorded manual footers remain observable while idle, drafting and working without a cycle hint', () => {
  // Captured from the native manual-mode test. Draft content is replaced;
  // native framing is preserved.
  for (const name of ['manual-idle', 'manual-draft', 'manual-working']) {
    const screen = readFileSync(new URL(`./fixtures/telemetry/${name}.txt`, import.meta.url), 'utf8');
    const observed = parseExecutionMode(screen);
    assert.equal(observed?.mode, 'default', name);
    assert.equal(observed?.label, '手动');
    assert.equal(observed?.source, 'native-footer');
    assert.match(observed?.evidence ?? '', /^⏸ manual mode on/);
  }
  for (const line of ['manual mode on', 'manual mode on · ? for shortcuts', '⏸ manual mode off', '⏸ manual mode on according to the assistant']) {
    assert.equal(parseExecutionMode(footer(line)), undefined, line);
  }
  assert.equal(parseExecutionMode(`● ⏸ manual mode on\n${footer('? for shortcuts')}`), undefined);
  assert.equal(parseExecutionMode(`● Example:\n\x60\x60\x60text\n${footer('⏸ manual mode on')}\x60\x60\x60`), undefined);
});

test('explicit permission badges map to stable modes without inferring a default', () => {
  for (const [badge, expected] of [
    ['⏵⏵ accept edits on', 'acceptEdits'], ['⏸ plan mode on', 'plan'],
    ['⏵⏵ bypass permissions on', 'bypassPermissions'], ['manual mode', 'default'],
  ]) assert.equal(parseExecutionMode(footer(`${badge} (shift+tab to cycle)`))?.mode, expected);
  for (const suffix of [' · ? for shortcuts · ← for agents', ' · ← for agents']) {
    assert.equal(parseExecutionMode(footer('⏸ manual mode on' + suffix))?.mode, 'default');
  }
  assert.equal(parseExecutionMode(footer("⏵⏵ don't ask on (shift+tab to cycle)"))?.mode, 'dontAsk');
  for (const badge of ['? for shortcuts', 'auto mode off (shift+tab to cycle)', 'future mode on (shift+tab to cycle)', 'auto mode on']) {
    assert.equal(parseExecutionMode(footer(badge)), undefined);
  }
});

test('execution mode ignores body, tool output, fenced examples and stale footer evidence', () => {
  const badge = '⏵⏵ auto mode on (shift+tab to cycle)';
  for (const screen of [
    `● ${badge}\n${footer('? for shortcuts')}`,
    `● Bash(command)\n  ⎿ ${badge}\n${footer('? for shortcuts')}`,
    `● Example:\n\n\x60\x60\x60text\n${footer(badge)}\x60\x60\x60`,
    `${footer(badge)}\n${footer('? for shortcuts')}`,
    `${footer(badge)}\nChoose model\n❯ 1. Sonnet\n2. Opus\nEnter to confirm · Esc to cancel`,
    badge,
    `❯\n${rule}\n${badge}`,
  ]) assert.equal(parseExecutionMode(screen), undefined, screen);
});

test('native request usage preserves all input categories and never adds output or infers capacity', () => {
  const telemetry = new SessionTelemetry();
  telemetry.ingestJsonl(jsonl(assistant('native-last-request', {
    ...usage(), output_tokens: 999999, cache_creation: { ephemeral_5m_input_tokens: 3 },
  })));
  assert.deepEqual(telemetry.context, {
    inputTokens: 17063, cacheReadInputTokens: 11905, cacheCreationInputTokens: 3, totalInputTokens: 28971,
    cacheCreationTtl: '5m', outputTokens: 999999, model: 'claude-sonnet-5-5', messageId: 'native-last-request',
    timestamp: '2026-11-17T17:39:57.000Z', source: 'jsonl-last-request', windowTokens: null, usedPercent: null,
  });
  const returned = telemetry.context!;
  returned.totalInputTokens = 1;
  assert.equal(telemetry.context?.totalInputTokens, 28971, 'callers cannot change reducer state');
});

test('cache TTL evidence requires the whole latest write in a single duration bucket', () => {
  const telemetry = new SessionTelemetry();
  for (const [buckets, ttl] of [
    [{ ephemeral_1h_input_tokens: 3, ephemeral_5m_input_tokens: 0 }, '1h'],
    [{ ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 2 }, undefined],
    [{ ephemeral_1h_input_tokens: 4 }, undefined], [{}, undefined],
  ] as const) {
    telemetry.ingestJsonl(jsonl(assistant('req', { ...usage(), cache_creation: buckets })), true);
    assert.equal(telemetry.context?.cacheCreationTtl, ttl);
  }
});

test('only completed main turns publish; repeated content blocks and UUIDs never accumulate usage', () => {
  const telemetry = new SessionTelemetry();
  const first = assistant('first');
  telemetry.ingestJsonl(jsonl(first, user('u2')));
  const before = telemetry.context;
  telemetry.ingestJsonl(jsonl(
    assistant('tool-block-one', usage(31519, 20, 953), 'tool_use', 'shared-api-id'),
    assistant('tool-block-two', usage(31519, 20, 953), 'tool_use', 'shared-api-id'),
    { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Fixture' }] } },
  ));
  assert.deepEqual(telemetry.context, before, 'an in-progress turn retains the last completed request');
  const final = assistant('final', usage(34340, 180, 72));
  telemetry.ingestJsonl(jsonl(final));
  assert.equal(telemetry.context?.totalInputTokens, 34592);
  telemetry.ingestJsonl(jsonl(final, first));
  assert.equal(telemetry.context?.messageId, 'final', 'replayed older UUIDs cannot roll back telemetry');
});

test('native turn_duration settles null-stop responses and ignores turns without an assistant', () => {
  const telemetry = new SessionTelemetry();
  telemetry.ingestJsonl(jsonl(assistant('null-stop', usage(20, 80, 10), null)));
  assert.equal(telemetry.context, undefined);
  telemetry.ingestJsonl(jsonl({ type: 'system', subtype: 'turn_duration', uuid: 'duration-1' }));
  assert.equal(context(telemetry)?.totalInputTokens, 110);
  telemetry.ingestJsonl(jsonl(user('next'), { type: 'system', subtype: 'turn_duration', uuid: 'duration-2' }));
  assert.equal(context(telemetry)?.totalInputTokens, 110);
});

test('sidechain, synthetic errors, nested usage and cumulative billing never replace main request usage', () => {
  const telemetry = new SessionTelemetry();
  telemetry.ingestJsonl(jsonl(assistant('main')));
  const expected = telemetry.context;
  telemetry.ingestJsonl(jsonl(
    { ...assistant('side', usage(90000)), isSidechain: true },
    { ...assistant('error', usage(0, 0, 0)), isApiErrorMessage: true },
    { type: 'assistant', uuid: 'synthetic', message: { model: '<synthetic>', usage: usage(0, 0, 0), stop_reason: 'end_turn' } },
    { type: 'progress', data: assistant('nested', usage(80000)) },
    { type: 'cost-state', modelUsage: { 'claude-sonnet-5[1m]': { inputTokens: 9000000, outputTokens: 400000, contextWindow: 1000000 } } },
    { type: 'api-request', params: { max_tokens: 64000, context_window_size: 1000000 } },
  ));
  assert.deepEqual(telemetry.context, expected);
});

test('compaction clears usage and ignores retained pre-compaction messages until a new completed request', () => {
  const telemetry = new SessionTelemetry();
  telemetry.ingestJsonl(jsonl(assistant('old')));
  telemetry.ingestJsonl(jsonl({ type: 'system', subtype: 'compact_boundary', uuid: 'compact', compactMetadata: {
    preTokens: 859135, postTokens: 17981, preservedMessages: { allUuids: ['retained-answer'] },
  } }));
  assert.equal(telemetry.context, undefined, 'pre/post compaction counts are not window capacity or request usage');
  telemetry.ingestJsonl(jsonl(assistant('retained-answer', usage(0, 0, 0)), assistant('new-tool', usage(15000, 0, 200), 'tool_use')));
  assert.equal(telemetry.context, undefined);
  telemetry.ingestJsonl(jsonl(assistant('new-answer', usage(15500, 200, 50))));
  assert.equal(context(telemetry)?.totalInputTokens, 15750);
});

test('partial JSONL is buffered and replacement resets completed and pending measurements', () => {
  const telemetry = new SessionTelemetry();
  const line = jsonl(assistant('complete'));
  telemetry.ingestJsonl(line.slice(0, -2));
  assert.equal(telemetry.context, undefined);
  telemetry.ingestJsonl(line.slice(-2));
  assert.equal(context(telemetry)?.messageId, 'complete');
  telemetry.ingestJsonl(jsonl(assistant('replacement-tool', usage(1, 2, 3), 'tool_use')), true);
  assert.equal(telemetry.context, undefined);
  telemetry.ingestJsonl(jsonl({ type: 'system', subtype: 'turn_duration' }));
  assert.equal(context(telemetry)?.totalInputTokens, 6);
  telemetry.reset();
  assert.equal(telemetry.context, undefined);
});

test('missing and invalid usage categories remain unknown instead of silently becoming zero', () => {
  for (const invalid of [undefined, null, -1, 0.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
    const telemetry = new SessionTelemetry();
    telemetry.ingestJsonl(jsonl(assistant('old'), assistant('invalid', { ...usage(), cache_read_input_tokens: invalid })));
    assert.equal(telemetry.context, undefined);
  }
  const telemetry = new SessionTelemetry();
  telemetry.ingestJsonl('{invalid json}\n' + jsonl(assistant('overflow', usage(Number.MAX_SAFE_INTEGER, 1, 1))));
  assert.equal(telemetry.context, undefined);
});

test('a revised usage record replaces the previous measurement without summation', () => {
  const telemetry = new SessionTelemetry();
  telemetry.ingestJsonl(jsonl(assistant('same-uuid', usage(2, 3, 4))));
  telemetry.ingestJsonl(jsonl(assistant('same-uuid', usage(10, 20, 30))));
  assert.equal(telemetry.context?.totalInputTokens, 60);
});

test('a custom cycle binding is accepted only inside an exact native mode footer', () => {
  for (const chord of ['ctrl+p', 'k', 'ctrl+k ctrl+p', 'F6']) {
    const evidence = `⏸ plan mode on (${chord} to cycle) · ← for agents`;
    assert.equal(parseExecutionMode(footer(evidence))?.evidence, evidence);
    assert.equal(parseExecutionMode('● ' + evidence + '\n' + footer('? for shortcuts')), undefined);
    assert.equal(parseExecutionMode('● Bash(echo)\n  ⎿ ' + evidence + '\n' + footer('? for shortcuts')), undefined);
    assert.equal(parseExecutionMode('● Example\n```\n' + footer(evidence) + '```'), undefined);
  }
  for (const badge of ['plan mode on in a quotation (ctrl+p to cycle)', 'auto mode on (press this button to cycle)']) {
    assert.equal(parseExecutionMode(footer(badge)), undefined);
  }
});

test('usage normalization selects only the last eligible main iteration and ignores unmetered responses', () => {
  const telemetry = new SessionTelemetry();
  const iterations = [{ type: 'message', ...usage(2, 2, 2) }, { type: 'fallback_message', ...usage(3, 3, 4) },
    { type: 'advisor_message', ...usage(9, 9, 9) }, { type: 'compaction', ...usage(10, 10, 10) }];
  telemetry.ingestJsonl(jsonl(assistant('ordinary', { ...usage(1, 1, 1), iterations })));
  assert.equal(telemetry.context?.totalInputTokens, 10);
  telemetry.ingestJsonl(jsonl({ ...assistant('unmetered'), isUnmetered: true }));
  assert.equal(telemetry.context?.messageId, 'ordinary');
  telemetry.ingestJsonl(jsonl(assistant('ineligible', { ...usage(1, 1, 1), iterations: [...iterations, { type: 'other', ...usage() }] })));
  assert.equal(telemetry.context?.totalInputTokens, 3);
  telemetry.ingestJsonl(jsonl(assistant('zero-top', { ...usage(0, 0, 0), iterations })));
  assert.equal(telemetry.context?.totalInputTokens, 0);
});

test('a right-aligned notice beside the mode badge does not hide the permission mode', () => {
  const screen = '  回复\n' + '─'.repeat(60) + ' discuss ─\n❯ \n' + '─'.repeat(70) + '\n  ⏸ manual mode on · ? for shortcuts' + ' '.repeat(20) + 'Update available · restart to apply\n';
  assert.equal(parseExecutionMode(screen)?.mode, 'default');
});
