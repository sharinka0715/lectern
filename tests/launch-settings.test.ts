import test from 'node:test';
import assert from 'node:assert/strict';
import { launchSettings } from '../src/backend/launch-settings';

test('every Lectern starts gets auto mode as its default through per-process settings', () => {
  const statusLine = { statusLine: { type: 'command', command: 'true' } };
  const settings = launchSettings({ statusLine, enableWorkflows: true });
  assert.deepEqual(settings.permissions, { defaultMode: 'auto' });
  assert.deepEqual(settings.statusLine, statusLine.statusLine);
  assert.equal(settings.promptSuggestionEnabled, false);
  assert.equal(settings.enableWorkflows, true);
  // Auto mode's check is left where Claude Code puts it: no environment of Lectern's own.
  assert.equal('env' in settings, false);
  // The same settings without a status line (the model-list probe) or workflows.
  const plain = launchSettings({ enableWorkflows: false });
  assert.deepEqual(plain.permissions, { defaultMode: 'auto' });
  assert.equal('enableWorkflows' in plain, false);
  assert.equal('statusLine' in plain, false);
});

test('a chosen prompt-cache lifetime goes into the settings env; the default sets nothing', () => {
  const env = (options: Parameters<typeof launchSettings>[0]) => launchSettings(options).env;
  // "Claude Code default" for both: no env at all, the user's own setup decides.
  assert.equal(env({ enableWorkflows: true }), undefined);
  assert.equal(env({ enableWorkflows: true, promptCacheTtl: '', subagentPromptCacheTtl: '' }), undefined);
  // Each choice sets only its own variable (env outranks the user's own variables and settings).
  assert.deepEqual(env({ enableWorkflows: true, promptCacheTtl: '1h' }), { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  assert.deepEqual(env({ enableWorkflows: false, subagentPromptCacheTtl: '5m' }), { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' });
  assert.deepEqual(env({ enableWorkflows: true, promptCacheTtl: '5m', subagentPromptCacheTtl: '1h' }),
    { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
  // Never the settings keys, never anything Claude Code would ignore.
  const both = launchSettings({ enableWorkflows: true, promptCacheTtl: '1h', subagentPromptCacheTtl: '1h' });
  assert.equal('promptCacheTtl' in both, false);
  assert.equal('subagentPromptCacheTtl' in both, false);
  assert.deepEqual(both.permissions, { defaultMode: 'auto' }, 'the other per-process settings stay');
  assert.equal(env({ enableWorkflows: true, promptCacheTtl: '30m' as never, subagentPromptCacheTtl: '1H' as never }), undefined);
});
