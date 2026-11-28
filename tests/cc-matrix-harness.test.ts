import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The compatibility matrix scripts are plain ES modules.
import { selectVersions } from '../scripts/cc-matrix/versions.mjs';
// @ts-expect-error The compatibility matrix scripts are plain ES modules.
import { cacheTtls, startFakeApi } from '../scripts/cc-matrix/fake-api.mjs';

test('compatibility matrix: one release per block of ten, plus latest and stable', () => {
  const published = ['2.1.299', '2.1.300', '2.1.301', '2.1.310', '2.1.311', '2.1.319', '2.1.321', '2.1.322', '2.1.329', '2.1.330-beta.1'];
  assert.deepEqual(selectVersions(published, { latest: '2.1.329', stable: '2.1.311' }), ['2.1.300', '2.1.310', '2.1.311', '2.1.321', '2.1.329']);
  assert.deepEqual(selectVersions(published, { latest: '2.1.322' }, { from: '2.1.315' }), ['2.1.319', '2.1.321', '2.1.322']);
});

test('compatibility matrix fake API: the marker picks the script, the step follows the tool loop', async () => {
  const api = await startFakeApi();
  try {
    api.script('loop', ({ step }: { step: number }) => step === 0 ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }] } : { text: 'finished' });
    const ask = async (messages: unknown[]) => {
      const response = await fetch(`${api.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, tools: [{ name: 'Agent' }, { name: 'Bash' }], messages }) });
      return response.text();
    };
    const first = await ask([{ role: 'user', content: 'go ccm:loop' }]);
    assert.match(first, /"name":"Bash"/);
    assert.match(first, /"stop_reason":"tool_use"/);
    const second = await ask([{ role: 'user', content: 'go ccm:loop' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }]);
    assert.match(second, /finished/);
    assert.deepEqual(api.requests.map((r: { script: string; step: number }) => [r.script, r.step]), [['loop', 0], ['loop', 1]]);
    // A task notification's <summary> tag is not the compaction prompt.
    const note = await ask([{ role: 'user', content: '<task-notification><summary>done</summary></task-notification>' }]);
    assert.doesNotMatch(note, /Primary Request/);
    const models = await fetch(`${api.url}/v1/models`).then(r => r.json());
    assert.ok(models.data.length > 1);
    assert.equal(api.external.length, 0);
  } finally { await api.close(); }
});

test('compatibility matrix fake API: the prompt-cache lifetimes a request asks for', () => {
  const ephemeral = (ttl?: string) => ({ type: 'ephemeral', ...(ttl && { ttl }) });
  assert.deepEqual(cacheTtls({ messages: [{ role: 'user', content: 'no markers' }] }), []);
  // A marker without a ttl is the API's default five minutes.
  assert.deepEqual(cacheTtls({ system: [{ type: 'text', text: 's', cache_control: ephemeral() }] }), ['5m']);
  assert.deepEqual(cacheTtls({
    system: [{ type: 'text', text: 's', cache_control: ephemeral('1h') }],
    tools: [{ name: 'Bash', cache_control: ephemeral('1h') }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'q', cache_control: ephemeral('5m') }] }],
  }), ['1h', '5m']);
});

test('compatibility matrix fake API: the safety check can be answered or failed in each way', async () => {
  const api = await startFakeApi();
  try {
    const check = (action: string) => fetch(`${api.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', max_tokens: 64,
      system: 'You are a security monitor for autonomous AI coding agents.', messages: [{ role: 'user', content: `<transcript>\nBash ${action}\n</transcript>` }] }) });
    const plans: Record<string, object> = { status: { status: 529, errorType: 'overloaded_error' }, reset: { reset: true }, hang: { hangMs: 150 }, refused: { refuseMs: 400 } };
    api.script('@classifier', ({ action, answer }: { action: string; answer: () => string }) => plans[action.split(' ')[1]] ?? { text: answer() });
    assert.match(await (await check('fine')).text(), /<severity>0<\/severity>/);
    const overloaded = await check('status');
    assert.equal(overloaded.status, 529);
    assert.equal((await overloaded.json()).error.type, 'overloaded_error');
    await assert.rejects(check('reset'));
    await assert.rejects(check('hang'));
    await assert.rejects(check('refused'));
    // Meanwhile new connections are refused; then the same address answers again.
    await assert.rejects(fetch(`${api.url}/v1/models`), (error: Error & { cause?: { code?: string } }) => error.cause?.code === 'ECONNREFUSED');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.ok((await fetch(`${api.url}/v1/models`)).ok);
    assert.deepEqual(api.requests.filter((r: { kind: string }) => r.kind === 'classifier').map((r: { failed?: unknown }) => r.failed ?? null), [null, 529, 'reset', 'hang', 'refused']);
  } finally { await api.close(); }
});

test('compatibility matrix fake API: the /goal evaluator answers from the condition, the continued turn gets the feedback', async () => {
  const api = await startFakeApi();
  try {
    const post = async (body: object) => (await fetch(`${api.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', max_tokens: 128000, ...body }) })).json();
    const system = [{ type: 'text', text: 'You are a Claude agent.' }, { type: 'text', text: 'You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully.' }];
    const evaluate = async (condition: string) => (await post({ system, messages: [{ role: 'user', content: [{ type: 'text', text: `Based on the conversation transcript above, has the following stopping condition been satisfied?\n\nCondition: ${condition}\n\nARGUMENTS: {}` }] }] })).content[0].text;
    const plan = 'Two steps ccm:g ccm-goal:no-yes';
    assert.deepEqual(JSON.parse(await evaluate(plan)), { ok: false, reason: 'the transcript does not show the last step yet' });
    assert.equal(JSON.parse(await evaluate(plan)).ok, true);
    assert.equal(JSON.parse(await evaluate(plan)).ok, true, 'the last answer repeats');
    assert.equal(JSON.parse(await evaluate('Never ccm-goal:impossible')).impossible, true);
    const broken = await evaluate('Broken ccm-goal:bad');
    assert.throws(() => JSON.parse(broken), 'a failed check: not JSON');
    assert.equal(JSON.parse(await evaluate('No plan')).reason, 'insufficient evidence in transcript');
    // Without all three signs it stays what it was: a side request, a main-loop request.
    assert.equal((await post({ system, messages: [{ role: 'user', content: 'Write a title' }] })).content[0].text, 'Compatibility check');
    api.script('@goal', ({ count, answer }: { count: number; answer: () => string }) => count === 1 ? { text: 'not JSON' } : { text: answer() });
    assert.equal(await evaluate('Scripted ccm-goal:yes'), 'not JSON');
    assert.deepEqual(api.requests.filter((r: { kind: string }) => r.kind === 'goal').map((r: { condition: string; check: number }) => [r.condition.split(' ')[0], r.check]),
      [['Two', 1], ['Two', 2], ['Two', 3], ['Never', 1], ['Broken', 1], ['No', 1], ['Scripted', 1]]);
    const seen: unknown[] = [];
    api.script('g', ({ step, feedback, feedbacks }: { step: number; feedback?: string; feedbacks: number }) => { seen.push([step, feedback ?? null, feedbacks]); return { text: 'ok' }; });
    const tools = [{ name: 'Agent' }, { name: 'Bash' }];
    const set = [{ role: 'user', content: [{ type: 'text', text: '<command-args>Two ccm:g</command-args>' }, { type: 'text', text: 'A session-scoped Stop hook is now active with condition: "Two ccm:g".' }] }];
    const fed = [...set, { role: 'assistant', content: 'one' }, { role: 'user', content: '<system-reminder>\nStop hook feedback:\n[Two ccm:g]: step two is missing\n</system-reminder>' }];
    await post({ tools, messages: set });
    await post({ tools, messages: fed });
    assert.deepEqual(seen, [[0, null, 0], [0, 'step two is missing', 1]]);
  } finally { await api.close(); }
});

test('compatibility matrix fake API: a subagent\'s progress label request, a fork of its conversation or one of its own', async () => {
  const api = await startFakeApi();
  try {
    const ask = async (body: Record<string, unknown>) => (await fetch(`${api.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, ...body }) })).text();
    const fork = { tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: 'Do the work ccm:helper' }, { role: 'assistant', content: 'On it.' },
      { role: 'user', content: 'Describe your most recent action in 3-5 words using present tense (-ing). Do not use tools.' }] };
    const own = { system: 'You write a 3-5 word progress label for a background agent, from short notes about what it is doing.',
      messages: [{ role: 'user', content: 'Do the work ccm:helper\nDescribe the agent\'s most recent action in 3-5 words using present tense (-ing).' }] };
    assert.match(await ask(fork), /Checking the work/);
    api.script('@progress', ({ name }: { name?: string }) => ({ text: `Label for ${name}` }));
    assert.match(await ask(fork), /Label for helper/);
    assert.match(await ask(own), /Label for helper/);
    assert.deepEqual(api.requests.map((r: { kind: string }) => r.kind), ['progress', 'progress', 'progress']);
  } finally { await api.close(); }
});
