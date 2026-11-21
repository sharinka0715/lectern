import assert from 'node:assert/strict';
import test from 'node:test';
import { activeDirectoryTrust, confirmedDirectoryTrustResult } from '../src/renderer/directory-trust-state';
import type { DirectoryTrustSnapshot, SessionSnapshot } from '../src/shared/types';

const prompt: DirectoryTrustSnapshot = {
  token: 'observed-prompt', sessionId: 'session', paneId: '%1', cwd: '/Users/example',
  observedAt: '2026-01-01T00:00:00Z', acceptLabel: 'Yes, I trust this folder', cancelLabel: 'No, exit', scope: 'session',
};
const snapshot: SessionSnapshot = { workspaceId: 'work', sessionId: 'session', paneId: '%1', messages: [], screen: '', status: 'waiting', directoryTrust: prompt };

test('trust buttons require an explicit current backend folder prompt, never generic waiting or screen text', () => {
  assert.equal(activeDirectoryTrust(snapshot), prompt);
  assert.equal(activeDirectoryTrust({ ...snapshot, directoryTrust: undefined, screen: 'Yes, I trust this folder /Users/example' }), undefined);
  assert.equal(activeDirectoryTrust({ ...snapshot, directoryTrust: undefined }), undefined);
  assert.equal(activeDirectoryTrust(undefined), undefined);
});

test('stale prompts cannot enable trust after pane, session, or connection state changes', () => {
  assert.equal(activeDirectoryTrust({ ...snapshot, paneId: '%2' }), undefined);
  assert.equal(activeDirectoryTrust({ ...snapshot, paneId: undefined }), undefined);
  assert.equal(activeDirectoryTrust({ ...snapshot, sessionId: 'other-session' }), undefined);
  for (const status of ['idle', 'working', 'offline', 'connecting', 'error'] as const) assert.equal(activeDirectoryTrust({ ...snapshot, status }), undefined);
  for (const missing of ['token', 'cwd', 'acceptLabel', 'cancelLabel'] as const) assert.equal(activeDirectoryTrust({ ...snapshot, directoryTrust: { ...prompt, [missing]: '' } }), undefined);
});

test('only explicit native scope is preserved, without inferring permanent trust', () => {
  assert.equal(activeDirectoryTrust(snapshot)?.scope, 'session');
  assert.equal(activeDirectoryTrust({ ...snapshot, directoryTrust: { ...prompt, scope: 'unspecified' } })?.scope, 'unspecified');
  assert.equal(activeDirectoryTrust({ ...snapshot, directoryTrust: { ...prompt, scope: 'permanent' as DirectoryTrustSnapshot['scope'] } }), undefined);
});

test('a successful trust result must confirm the specific decision, pane and session', () => {
  const expected = { decision: 'trust' as const, sessionId: 'session', paneId: '%1' };
  const result = { ...expected, closed: true as const };
  assert.equal(confirmedDirectoryTrustResult(result, expected), true);
  assert.equal(confirmedDirectoryTrustResult({ ...result, decision: 'exit' }, expected), false);
  assert.equal(confirmedDirectoryTrustResult({ ...result, sessionId: 'other' }, expected), false);
  assert.equal(confirmedDirectoryTrustResult({ ...result, paneId: '%2' }, expected), false);
});
