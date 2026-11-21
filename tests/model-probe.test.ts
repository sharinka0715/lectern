import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchChoiceArgs, parseModelProbe, PROBE_ARGS, PROBE_INPUT } from '../src/backend/model-probe';
import { defaultModelChoice, effortsFor, validLaunchChoices } from '../src/shared/model-catalog';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/sdk-probe/${name}.jsonl`, import.meta.url), 'utf8');

test('Claude Code 2.1.329 (subscription): the /model menu rows in order, effort levels per model, the new-session defaults', () => {
  const catalog = parseModelProbe(fixture('first-party-2.1.329'), '2026-11-20T00:00:00.000Z');
  assert.equal(catalog.version, '2.1.329');
  assert.deepEqual(catalog.models.slice(0, 5).map(row => [row.value, row.label]), [
    ['default', 'Default (recommended)'], ['opus', 'Opus 5.5'], ['fable', 'Fable 5.2'], ['sonnet', 'Sonnet 5.5'], ['haiku', 'Haiku 5.5']]);
  assert.equal(catalog.models.length, 14, 'including the rows under "More models"');
  assert.deepEqual(catalog.models.find(row => row.value === 'opus')?.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(catalog.models.find(row => row.value === 'claude-sonnet-4-6')?.efforts, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(catalog.models.find(row => row.value === 'claude-haiku-4-5-20251001')?.efforts, [], 'no effort control');
  assert.deepEqual(catalog.defaults, { model: 'claude-opus-5-5', settingModel: 'opus', effort: 'xhigh', ultracodeAvailable: true });
  assert.equal(defaultModelChoice(catalog)?.label, 'Opus 5.5', 'the "model" setting\'s row');
  assert.ok(!JSON.stringify(catalog).includes('redacted') && !('account' in catalog), 'no account details are kept');
});

test('Claude Code 2.1.328 behind a gateway: custom model IDs, the default resolved through the gateway', () => {
  const catalog = parseModelProbe(fixture('gateway-2.1.328'));
  assert.equal(catalog.models.length, 20);
  assert.deepEqual(catalog.models.find(row => row.label === 'Fable'), { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', label: 'Fable',
    description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.ok(catalog.models.some(row => row.value === 'codex/gpt-6-luna'));
  assert.equal(catalog.defaults.model, 'gateway/claude-opus-5-5');
  assert.equal(defaultModelChoice(catalog)?.value, 'opus');
});

test('only valid rows survive; a CLI without get_settings still yields its models; a refusal or silence is an error', () => {
  const response = (id: string, body: object, subtype = 'success') => JSON.stringify({ type: 'control_response', response: { subtype, request_id: id, response: body } });
  const models = [
    { value: 'opus', displayName: 'Opus', description: 'x', supportsEffort: true, supportedEffortLevels: ['max', 'low', 'turbo'] },
    { value: '--model', displayName: 'Injected' }, { value: 'a b', displayName: 'Spaces' }, { value: 'ok', displayName: '' },
    { value: 'zdr', displayName: 'Blocked', disabled: true }, { value: 'plain', displayName: 'Plain', supportsEffort: false, supportedEffortLevels: ['low'] },
  ];
  const catalog = parseModelProbe(['noise', '{"type":"system"}', response('lectern-initialize', { models })].join('\n'));
  assert.deepEqual(catalog.models.map(row => [row.value, row.efforts]), [['opus', ['low', 'max']], ['plain', []]]);
  assert.deepEqual(catalog.defaults, {});
  assert.throws(() => parseModelProbe(''), /没有回应/);
  assert.throws(() => parseModelProbe(response('lectern-initialize', {}, 'error')), /拒绝/);
  assert.throws(() => parseModelProbe(response('lectern-initialize', { models: [{ value: '-x', displayName: 'Bad' }] })), /为空/);
});

test('the probe asks two control requests with no prompt and no transcript', () => {
  assert.deepEqual(PROBE_ARGS, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']);
  assert.deepEqual(PROBE_INPUT.trim().split('\n').map(line => JSON.parse(line).request.subtype), ['initialize', 'get_settings']);
  assert.doesNotMatch(PROBE_INPUT, /"type":"user"/);
});

test('launch choices become --model/--effort; "default" adds nothing; anything else is refused', () => {
  assert.deepEqual(launchChoiceArgs({ model: 'claude-fable-5-1[1m]', effort: 'xhigh' }), ['--model', 'claude-fable-5-1[1m]', '--effort', 'xhigh']);
  assert.deepEqual(launchChoiceArgs({ model: 'codex/gpt-6-luna' }), ['--model', 'codex/gpt-6-luna']);
  assert.deepEqual(launchChoiceArgs({ model: 'default' }), []);
  assert.deepEqual(launchChoiceArgs({}), []);
  for (const bad of [{ model: '-x' }, { model: 'a b' }, { model: 'a\nb' }, { model: "x'y" }, { effort: 'auto' }, { effort: 'ultracode' }] as object[])
    assert.throws(() => launchChoiceArgs(bad as never), /无效/, JSON.stringify(bad));
});

test('draft choices keep only rows and levels the folder\'s machine offers', () => {
  const catalog = parseModelProbe(fixture('first-party-2.1.329'));
  assert.deepEqual(effortsFor(catalog), ['low', 'medium', 'high', 'xhigh', 'max'], 'the default row\'s levels');
  assert.deepEqual(validLaunchChoices(catalog, { model: 'claude-sonnet-4-6', effort: 'xhigh' }), { model: 'claude-sonnet-4-6' }, 'Sonnet 4.6 has no xhigh');
  assert.deepEqual(validLaunchChoices(catalog, { model: 'default', effort: 'high' }), { effort: 'high' });
  assert.deepEqual(validLaunchChoices(catalog, { model: 'gone', effort: 'low' }), { effort: 'low' });
  assert.deepEqual(validLaunchChoices(undefined, { model: 'opus' }), {});
});

test('a session\'s model row comes from its status line by value, display name, then resolved ID; ambiguity marks nothing', async () => {
  const { currentModelIndex, effortLevels } = await import('../src/main/session-settings-cache');
  const catalog = parseModelProbe(fixture('first-party-2.1.329')), gateway = parseModelProbe(fixture('gateway-2.1.328'));
  const label = (list: typeof catalog, index?: number) => index === undefined ? undefined : list.models[index].label;
  const line = (modelId: string, modelName?: string) => ({ sessionId: 's', modelId, ...(modelName && { modelName }) });
  assert.equal(label(catalog, currentModelIndex(catalog, undefined, line('claude-opus-5-5', 'Opus 5.5'))), 'Opus 5.5', 'not the default row');
  assert.equal(label(catalog, currentModelIndex(catalog, undefined, line('claude-sonnet-4-6'))), 'Sonnet 4.6');
  assert.equal(label(catalog, currentModelIndex(catalog, undefined, line('claude-fable-5-2[1m]'))), 'Fable 5.2', 'the 1M context suffix');
  assert.equal(label(gateway, currentModelIndex(gateway, undefined, line('claude-fable-5-1[1m]', 'Fable'))), 'Fable');
  assert.equal(currentModelIndex(catalog, undefined, line('unlisted-model')), undefined);
  assert.equal(label(catalog, currentModelIndex(catalog, { label: 'Haiku 4.5', description: 'Fastest for quick answers' }, line('claude-opus-5-5'))), 'Haiku 4.5', 'a verified selection wins');
  assert.deepEqual(effortLevels(catalog, catalog.models.findIndex(row => row.value === 'claude-opus-4-6')), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(effortLevels(catalog), ['low', 'medium', 'high', 'xhigh', 'max'], 'unknown model: every level some model accepts');
});
