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
  assert.deepEqual(settings.env, { CLAUDE_CODE_AUTO_MODE_SERVER: '0' });
  // The same settings without a status line (the model-list probe) or workflows.
  const plain = launchSettings({ enableWorkflows: false });
  assert.deepEqual(plain.permissions, { defaultMode: 'auto' });
  assert.equal('enableWorkflows' in plain, false);
  assert.equal('statusLine' in plain, false);
});
