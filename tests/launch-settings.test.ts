import test from 'node:test';
import assert from 'node:assert/strict';
import { launchSettings } from '../src/backend/launch-settings';

test('every Lectern starts gets auto mode as its default through per-process settings', () => {
  const statusLine = { statusLine: { type: 'command', command: 'true' } };
  const settings = launchSettings({ statusLine, enableWorkflows: true });
  assert.deepEqual(settings.permissions, { defaultMode: 'auto' });
  assert.deepEqual(settings.statusLine, statusLine.statusLine);
  assert.equal('promptSuggestionEnabled' in settings, false);
  assert.equal(settings.enableWorkflows, true);
  // Auto mode's check is left where Claude Code puts it: no environment of Lectern's own.
  assert.equal('env' in settings, false);
  // The same settings without a status line (the model-list probe) or workflows.
  const plain = launchSettings({ enableWorkflows: false });
  assert.deepEqual(plain.permissions, { defaultMode: 'auto' });
  assert.equal('enableWorkflows' in plain, false);
  assert.equal('statusLine' in plain, false);
});

test('a prompt-cache preset sets both variables in the settings env; the default sets nothing', () => {
  const env = (options: Parameters<typeof launchSettings>[0]) => launchSettings(options).env;
  // The default: no env at all, Claude Code decides (subscription or API, the user's own setup).
  assert.equal(env({ enableWorkflows: true }), undefined);
  assert.equal(env({ enableWorkflows: true, promptCacheTtlPreset: 'default' }), undefined);
  // Each preset sets both variables (env outranks the user's own variables and settings).
  assert.deepEqual(env({ enableWorkflows: true, promptCacheTtlPreset: 'both-5m' }),
    { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' });
  assert.deepEqual(env({ enableWorkflows: false, promptCacheTtlPreset: 'both-1h' }),
    { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
  assert.deepEqual(env({ enableWorkflows: true, promptCacheTtlPreset: 'main-1h-other-5m' }),
    { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' });
  // Never the settings keys, never anything Claude Code would ignore.
  const both = launchSettings({ enableWorkflows: true, promptCacheTtlPreset: 'both-1h' });
  for (const key of ['promptCacheTtl', 'subagentPromptCacheTtl', 'promptCacheTtlPreset']) assert.equal(key in both, false, key);
  assert.deepEqual(both.permissions, { defaultMode: 'auto' }, 'the other per-process settings stay');
  // Anything that is not one of the four values is the default: main 5m with others 1h
  // is not offered, nor are the old separate choices or a lifetime on its own.
  for (const value of ['main-5m-other-1h', '5m', '1h', '', 'BOTH-1H', 1, null, {}]) {
    assert.equal(env({ enableWorkflows: true, promptCacheTtlPreset: value as never }), undefined, String(value));
  }
});
