import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessionTitle } from '../src/shared/session-title';

test('native titles count Unicode code points and normalize invisible formatting before submission', () => {
  assert.equal(normalizeSessionTitle('  新\u2060方案  '), '新 方案');
  assert.equal(normalizeSessionTitle('🧭'.repeat(200)), '🧭'.repeat(200));
  for (const name of ['🧭'.repeat(201), ' \u200b ', 'a\nb', 'a\u001bb', '\ud800'])
    assert.throws(() => normalizeSessionTitle(name));
});
