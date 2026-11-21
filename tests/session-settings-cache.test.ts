import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionSettingsCache, type SessionSettingsHandle } from '../src/main/session-settings-cache';
import { SessionSettingsDiskStore } from '../src/main/session-settings-disk-store';
import type { SessionSettingKind, SessionSettingSnapshot } from '../src/shared/types';

function snapshot(handle: SessionSettingsHandle, kind: SessionSettingKind, token = `${kind}-ticket`): SessionSettingSnapshot {
  return {
    kind, token, sessionId: handle.sessionId, paneId: handle.paneId,
    observedAt: '2026-01-01T00:00:00.000Z', command: `/${kind}`, complete: true,
    options: [{ id: `${kind}-native`, label: kind === 'model' ? 'Tenant model λ' : 'Custom focus λ', current: true }],
    currentOptionId: `${kind}-native`,
  };
}

function savePair(cache: SessionSettingsCache, handle: SessionSettingsHandle) {
  for (const kind of ['model', 'effort'] as const) cache.rememberApplied(handle, snapshot(handle, kind));
}

test('replacement and disposal reject stale pane responses and cannot restore an old ticket', () => {
  const cache = new SessionSettingsCache();
  const a = cache.observe('target', 'chat', '%1', true, 300)!;
  assert.equal(cache.observe('target', 'chat', '%1', true, 300), a);
  const b = cache.observe('target', 'chat', '%1', true, 301)!;
  assert.equal(cache.rememberApplied(a, snapshot(a, 'model')), false);
  assert.throws(() => cache.rememberApplied(b, { ...snapshot(b, 'model'), paneId: '%elsewhere' }), /不属于/);
  cache.invalidate(a);
  assert.deepEqual(cache.state(b), { initialization: 'pending', menus: {} });
  cache.dispose();
  assert.equal(cache.state(b), undefined);
  assert.equal(cache.observe('target', 'chat', '%1'), undefined);
});

function profile(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'lectern-settings-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, restart: () => new SessionSettingsCache(new SessionSettingsDiskStore(directory)) };
}

function attach(cache: SessionSettingsCache, instanceId = 'cli-instance', target = 'ssh:private-target', sessionId = 'session-uuid') {
  return cache.observe(target, sessionId, '%5', true, 4100, instanceId)!;
}

test('a cold restart of the same CLI instance restores only selected display values and sends no native input', async t => {
  const { directory, restart } = profile(t);
  const first = restart(), handle = attach(first);
  for (const kind of ['model', 'effort'] as const) {
    const menu = snapshot(handle, kind);
    first.rememberApplied(handle, { ...menu, command: '/sensitive_command', detail: 'screen contents', nativeFeedback: 'terminal feedback',
      options: [...menu.options, { current: false, id: 'other-option-id', label: 'Other tenant option' }] });
  }
  first.dispose();
  const subdirectory = path.join(directory, 'session-settings');
  const [name] = readdirSync(subdirectory);
  const file = path.join(subdirectory, name), record = readFileSync(file, 'utf8');
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.equal(statSync(subdirectory).mode & 0o077, 0);
  }
  for (const privateValue of ['ticket', '-native', 'other-option-id', 'Other tenant option', '/sensitive_command',
    'screen contents', 'terminal feedback', 'cli-instance', handle.targetKey, handle.sessionId, handle.paneId]) {
    assert.ok(!(name + record).includes(privateValue), privateValue);
  }
  const second = restart(), restored = attach(second);
  assert.deepEqual(second.state(restored), { initialization: 'pending', menus: {},
    observed: { model: { label: 'Tenant model λ' }, effort: { label: 'Custom focus λ' } } });
});

test('disk restoration requires the exact target, session, pane, and CLI instance', async t => {
  const { restart } = profile(t);
  const first = restart(), handle = attach(first);
  savePair(first, handle);
  first.dispose();
  const inputs: Parameters<SessionSettingsCache['observe']>[] = [
    [handle.targetKey, handle.sessionId, handle.paneId, true, handle.panePid, undefined],
    [handle.targetKey, handle.sessionId, handle.paneId, true, handle.panePid, 'restarted-with-reused-pid'],
    [handle.targetKey, handle.sessionId, '%other', true, handle.panePid, handle.instanceId],
    [handle.targetKey, handle.sessionId, handle.paneId, true, 4200, handle.instanceId],
    ['different-target', handle.sessionId, handle.paneId, true, handle.panePid, handle.instanceId],
    [handle.targetKey, 'another-session', handle.paneId, true, handle.panePid, handle.instanceId],
  ];
  for (const args of inputs) {
    const second = restart();
    const next = second.observe(...args)!;
    assert.deepEqual(second.state(next), { initialization: 'pending', menus: {} });
  }
  const withoutEvidence = restart();
  const unknown = withoutEvidence.observe('target-b', 'uuid-b', '%1', true, 4200)!;
  savePair(withoutEvidence, unknown);
  const another = restart();
  assert.equal(another.state(another.observe('target-b', 'uuid-b', '%1', true, 4200)!)?.observed, undefined);

  const running = restart(), old = attach(running), replacement = attach(running, 'new-cli');
  assert.notEqual(old, replacement);
  assert.equal(running.state(old), undefined);
  assert.equal(running.state(replacement)?.observed, undefined);
});

test('evicts affected selections before mutation or handoff, and saves verified readbacks', async t => {
  const { restart } = profile(t);
  const cache = restart(), handle = attach(cache);
  const afterRestart = () => { const next = restart(); return next.state(attach(next)); };
  savePair(cache, handle);
  cache.invalidateSelection(handle, 'effort');
  assert.equal(afterRestart()?.observed?.effort, undefined, 'a crash during native apply cannot resurrect the previous effort');
  assert.deepEqual(afterRestart()?.observed, { model: { label: 'Tenant model λ' } });
  const changed = snapshot(handle, 'effort');
  changed.options[0].label = 'Stronger focus';
  cache.rememberApplied(handle, changed);
  assert.deepEqual(afterRestart()?.observed, { model: { label: 'Tenant model λ' }, effort: { label: 'Stronger focus' } });
  cache.invalidateSelection(handle, 'model');
  assert.equal(afterRestart()?.observed, undefined);
  cache.rememberApplied(handle, snapshot(handle, 'model'));
  assert.equal(afterRestart()?.observed?.effort, undefined, 'effort for the new model must be verified first');
  savePair(cache, handle);
  assert.equal(afterRestart()?.observed?.effort?.label, 'Custom focus λ');
  cache.invalidate(handle);
  assert.equal(afterRestart()?.observed, undefined, 'handoff clears even a complete observation');
});

test('gaining process evidence on the same provisional pane restores without copying provisional tickets', async t => {
  const { restart } = profile(t);
  const prior = restart();
  const handle = attach(prior);
  savePair(prior, handle);
  const opening = restart(), provisional = opening.observe(handle.targetKey, handle.sessionId, handle.paneId, true, handle.panePid)!;
  assert.equal(opening.state(provisional)?.observed, undefined);
  assert.equal(opening.state(attach(opening))?.observed?.model?.label, 'Tenant model λ');
  const late = restart(), tentative = late.observe(handle.targetKey, handle.sessionId, handle.paneId, true, handle.panePid)!;
  late.rememberApplied(tentative, snapshot(tentative, 'model', 'provisional-only'));
  assert.deepEqual(late.state(attach(late)), { initialization: 'pending', menus: {} });
});

test('workspace edits and inactive sessions invalidate disk records even in a fresh app', async t => {
  const { restart } = profile(t);
  const cache = restart();
  const a = attach(cache), b = attach(cache, 'cli-b', a.targetKey, 'uuid-b'), other = attach(cache, 'cli-c', 'other-target');
  for (const handle of [a, b, other]) savePair(cache, handle);
  const closed = restart();
  closed.observe(a.targetKey, a.sessionId, undefined, false);
  assert.equal(closed.state(attach(closed))?.observed, undefined);
  const edited = restart();
  edited.invalidateTarget(a.targetKey);
  assert.equal(edited.state(attach(edited, 'cli-b', a.targetKey, 'uuid-b'))?.observed, undefined);
  assert.equal(edited.state(attach(edited, 'cli-c', 'other-target'))?.observed?.model?.label, 'Tenant model λ');
});

test('the private disk cache evicts the oldest observation at its session bound', t => {
  const { directory, restart } = profile(t);
  const cache = restart();
  function saveModel(id: string) {
    const handle = attach(cache, 'cli', 'target', id);
    cache.rememberApplied(handle, snapshot(handle, 'model'));
  }
  saveModel('oldest');
  const records = path.join(directory, 'session-settings');
  utimesSync(path.join(records, readdirSync(records)[0]), new Date(0), new Date(0));
  for (let n = 1; n <= 128; n++) saveModel(String(n));
  assert.equal(readdirSync(records).length, 128);
  const next = restart();
  assert.equal(next.state(attach(next, 'cli', 'target', 'oldest'))?.observed, undefined);
  assert.equal(next.state(attach(next, 'cli', 'target', '128'))?.observed?.model?.label, 'Tenant model λ');
});

test('ambiguous menus, unsupported catalogs, corrupt files and unavailable storage are cache misses', async t => {
  const { directory, restart } = profile(t);
  const cache = restart(), handle = attach(cache);
  const effort = snapshot(handle, 'effort');
  cache.rememberApplied(handle, snapshot(handle, 'model'));
  const afterRestart = () => { const next = restart(); return next.state(attach(next)); };
  for (const unsuitable of [
    { ...effort, complete: false }, { ...effort, currentOptionId: 'another-id' },
    { ...effort, options: [...effort.options, { current: true, id: 'another', label: 'also selected' }] },
    { ...effort, options: [{ ...effort.options[0], description: 'Bearer secret-credential' }] },
  ]) {
    cache.rememberApplied(handle, unsuitable);
    assert.equal(afterRestart()?.observed?.effort, undefined);
  }
  cache.rememberApplied(handle, effort);
  const subdirectory = path.join(directory, 'session-settings');
  const file = path.join(subdirectory, readdirSync(subdirectory)[0]), record = readFileSync(file, 'utf8');
  for (const broken of ['truncated {', ' '.repeat(16 * 1024) + record,
    JSON.stringify({ ...JSON.parse(record), model: { label: { token: 'invalid' } } })]) {
    writeFileSync(file, broken);
    assert.deepEqual(afterRestart(), { initialization: 'pending', menus: {} });
  }
  rmSync(subdirectory, { recursive: true });
  writeFileSync(subdirectory, 'unavailable directory');
  const live = restart(), liveHandle = attach(live);
  savePair(live, liveHandle);
  assert.equal(live.state(liveHandle)?.observed?.model?.label, 'Tenant model λ');
  live.invalidateSelection(liveHandle, 'effort');
  assert.equal(live.rememberApplied(liveHandle, effort), true);
});

test('effort alone survives restart and a provisional handoff revokes it before identity is known', t => {
  const { restart } = profile(t);
  const first = restart(), handle = attach(first);
  first.rememberApplied(handle, snapshot(handle, 'effort'));
  const second = restart();
  assert.deepEqual(second.state(attach(second))?.observed, { effort: { label: 'Custom focus λ' } });
  const third = restart();
  const provisional = third.observe(handle.targetKey, handle.sessionId, handle.paneId, true, handle.panePid)!;
  third.invalidateSelection(provisional, 'model');
  assert.equal(third.state(attach(third))?.observed, undefined);
});
