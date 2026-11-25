import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArtifactReferenceResult, ArtifactResolution, Workspace } from '../src/shared/types';
import { ArtifactReferenceCache, artifactReferences } from '../src/renderer/artifact-reference-cache';
import { ArtifactReferenceScope, ReplyCwd, useArtifactResolutions } from '../src/renderer/ArtifactReferenceScope';
import { FileLink } from '../src/renderer/ArtifactLinks';

const workspace: Workspace = { id: 'fixture', name: 'Fixture', kind: 'ssh', host: 'fixture-host', cwd: '/project' };
const lookupFor = (cache: ArtifactReferenceCache, ws = workspace) => cache.forWorkspace(ws.id, JSON.stringify(ws));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const hit = (path: string) => ({ path });

test('mounting overlapping scopes batches once and a late reply warms the shared cache without notifying unmounted consumers', async () => {
  const cache = new ArtifactReferenceCache(async (id, references, identity) => {
    calls.push(references);
    assert.equal(id, workspace.id);
    assert.equal(identity, JSON.stringify(workspace));
    return pending;
  });
  const calls: unknown[][] = [];
  let finish!: (matches: ArtifactReferenceResult[]) => void;
  const pending = new Promise<ArtifactReferenceResult[]>(resolve => { finish = resolve; });
  const first = lookupFor(cache), second = lookupFor(cache), updates: ArtifactResolution[] = [];
  const stopA = first.watch('note.md', '/project/sub', match => updates.push(match));
  const stopB = second.watch('note.md', '/project/sub', match => updates.push(match));
  const stopC = first.watch('note.md', '/project', match => updates.push(match));
  assert.equal(first.peek('note.md', '/project/sub'), undefined);
  await tick();
  stopA?.();
  stopB?.();
  stopC?.();
  finish([hit('sub/note.md'), hit('note.md')]);
  await tick();
  assert.deepEqual(calls, [[{ path: 'note.md', cwd: '/project/sub' }, { path: 'note.md', cwd: '/project' }]]);
  assert.deepEqual(updates, []);
  assert.deepEqual(lookupFor(cache).peek('note.md', '/project/sub'), hit('sub/note.md'));
  assert.deepEqual(lookupFor(cache).peek('note.md', '/project'), hit('note.md'));
});

test('a new transcript or drawer uses cached links on its first render', async t => {
  const ws = { ...workspace, id: 'first-render-fixture' };
  const desktop = { resolveArtifactReferences: t.mock.fn(async () => [hit('sub/note.md'), hit('sub/note.md')]) };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { desktop } });
  t.after(() => {
    artifactReferences.syncWorkspaces([]);
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  artifactReferences.syncWorkspaces([ws]);
  const lookup = lookupFor(artifactReferences, ws);
  const warmReply = lookup.watch('note.md', '/project/sub', () => {});
  const warmDrawer = lookup.watch('sub/note.md', undefined, () => {});
  await tick();
  warmReply?.();
  warmDrawer?.();

  const link = createElement(FileLink, { path: 'note.md', onOpen: () => {}, children: 'note.md' });
  const render = (props: { sessionId?: string; file?: string }, children: ReactNode) =>
    renderToStaticMarkup(createElement(ArtifactReferenceScope, { workspace: ws, ...props, children }));
  const reply = createElement(ReplyCwd, { cwd: '/project/sub', children: link });
  for (const sessionId of ['chat-a', 'chat-b']) {
    assert.match(render({ sessionId }, reply), /data-file-path="sub\/note.md"/);
  }
  assert.match(render({ file: 'sub/guide.md' }, link), /data-file-path="sub\/note.md"/);
  assert.doesNotMatch(render({ file: 'other/guide.md' }, link), /data-file-path=/);
  function Mentions() {
    const matches = useArtifactResolutions(['sub/note.md']);
    return createElement('span', null, JSON.stringify([...matches ?? []]));
  }
  assert.match(render({ sessionId: 'chat-b' }, createElement(Mentions)), /sub\/note.md/);
  assert.equal(desktop.resolveArtifactReferences.mock.callCount(), 1);
});

test('positive and negative answers revalidate in the background and only changed answers notify existing views', async () => {
  let now = 0;
  const replies: ArtifactReferenceResult[][] = [[hit('old/file.md'), 'missing'], [hit('new.md')], [hit('old/file.md')], [hit('new/file.md')], [null]];
  const calls: unknown[][] = [];
  const lookup = lookupFor(new ArtifactReferenceCache(async (_id, refs) => {
    calls.push(refs);
    return replies.shift()!;
  }, () => now));
  const updates: ArtifactResolution[] = [];
  const stopFile = lookup.watch('file.md', undefined, match => updates.push(match));
  const stopMissing = lookup.watch('new.md', undefined, () => {});
  await tick();
  assert.equal(lookup.peek('new.md'), 'missing');
  now = 2000;
  lookup.watch('new.md', undefined, () => {})?.();
  assert.equal(lookup.peek('new.md'), 'missing');
  await tick();
  assert.deepEqual(lookup.peek('new.md'), hit('new.md'));

  now = 29_999;
  lookup.watch('file.md', undefined, () => {})?.();
  await tick();
  assert.equal(calls.length, 2);
  now = 30_000;
  lookup.watch('file.md', undefined, () => {})?.();
  assert.deepEqual(lookup.peek('file.md'), hit('old/file.md'));
  await tick();
  assert.deepEqual(updates, [hit('old/file.md')], 'an unchanged target does not notify mounted views');
  now = 60_000;
  lookup.watch('file.md', undefined, () => {})?.();
  await tick();
  now = 90_000;
  lookup.watch('file.md', undefined, () => {})?.();
  await tick();
  assert.deepEqual(updates, [hit('old/file.md'), hit('new/file.md'), null]);
  assert.equal(lookup.peek('file.md'), null);
  assert.deepEqual(calls, [['file.md', 'new.md'], ['new.md'], ['file.md'], ['file.md'], ['file.md']]);
  stopFile?.();
  stopMissing?.();
});

test('unavailable hosts and incomplete searches leave stale links in place', async () => {
  let now = 0, calls = 0;
  const match = hit('file.md');
  const lookup = lookupFor(new ArtifactReferenceCache(async () => {
    calls++;
    if (calls === 2) throw new Error('fixture host unavailable');
    return calls === 3 ? [undefined] : [match];
  }, () => now));
  const updates: ArtifactResolution[] = [];
  const stop = lookup.watch('file.md', undefined, answer => updates.push(answer));
  await tick();
  now = 30_000;
  lookup.watch('file.md', undefined, () => {})?.();
  await tick();
  assert.deepEqual(lookup.peek('file.md'), match);
  now += 2000;
  lookup.watch('file.md', undefined, () => {})?.();
  await tick();
  assert.equal(calls, 3);
  assert.deepEqual(lookup.peek('file.md'), match);
  assert.deepEqual(updates, [match]);
  stop?.();
});

test('least recently used answers are evicted across workspaces', async () => {
  const other = { ...workspace, id: 'other-fixture', host: 'other-host' };
  const cache = new ArtifactReferenceCache(async (id, refs) => refs.map(ref => hit(id + '/' + ref)), () => 0, 2);
  cache.syncWorkspaces([workspace, other]);
  const first = lookupFor(cache), second = lookupFor(cache, other);
  const warm = async (lookup: typeof first, path: string) => {
    const stop = lookup.watch(path, undefined, () => {});
    await tick();
    stop?.();
  };
  await warm(first, 'file.md');
  assert.equal(second.peek('file.md'), undefined);
  await warm(second, 'file.md');
  assert.deepEqual(second.peek('file.md'), hit('other-fixture/file.md'));
  await warm(first, 'file.md');
  await warm(first, 'new.md');
  assert.equal(second.peek('file.md'), undefined);
  assert.deepEqual(first.peek('file.md'), hit('fixture/file.md'));
  assert.deepEqual(first.peek('new.md'), hit('fixture/new.md'));
});

test('changed and removed workspaces discard cached and in-flight results', async () => {
  let finish!: (answers: ArtifactReferenceResult[]) => void;
  const pending = new Promise<ArtifactReferenceResult[]>(resolve => { finish = resolve; });
  const cache = new ArtifactReferenceCache(async (_id, refs) => refs[0] === 'pending.md' ? pending : [hit('file.md')]);
  const changed = { ...workspace, host: 'new-fixture-host' };
  cache.syncWorkspaces([workspace]);
  const old = lookupFor(cache);
  const stop = old.watch('file.md', undefined, () => {});
  await tick();
  stop?.();
  const stopPending = old.watch('pending.md', undefined, () => {});
  await tick();
  stopPending?.();

  cache.syncWorkspaces([changed]);
  const current = lookupFor(cache, changed);
  assert.equal(old.peek('file.md'), undefined);
  assert.equal(current.peek('file.md'), undefined);
  const stopCurrent = current.watch('file.md', undefined, () => {});
  await tick();
  cache.syncWorkspaces([]);
  stopCurrent?.();
  assert.equal(current.peek('file.md'), undefined);

  finish([hit('pending.md')]);
  await tick();
  cache.syncWorkspaces([workspace]);
  const restored = lookupFor(cache);
  assert.equal(restored.peek('file.md'), undefined);
  assert.equal(restored.peek('pending.md'), undefined);
});
