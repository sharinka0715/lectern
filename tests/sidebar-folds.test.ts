import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseGroup, collapseMachine, desktopState, foldsKept, forgetProject, legacyExpandedKey, listFolder, listGroup,
  loadDesktopState, prunedFolds, pruneSidebarFolds, setDesktop, sidebarFoldsOf, type SidebarFolds,
} from '../src/renderer/desktop-state';

const preferencesKey = 'lectern.desktop.preferences.v1';
const none: SidebarFolds = { expandedFolders: [], collapsedMachines: [], collapsedGroups: [], folderListed: {}, groupListed: {} };
const storage = (entries: Record<string, string>) => ({ getItem: (key: string) => entries[key] ?? null });
/** A localStorage for the module's own reads and writes. */
function memoryStorage() {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  return store;
}

test('folds start empty: folders closed, machines and groups open, lists at their first page', () => {
  assert.deepEqual(sidebarFoldsOf(undefined), none);
  assert.deepEqual(loadDesktopState(storage({})).sidebarFolds, none);
  assert.deepEqual(loadDesktopState(storage({ [preferencesKey]: JSON.stringify({ theme: 'dark' }) })).sidebarFolds, none);
  assert.equal(foldsKept(none), false);
});

test('the expanded folders of the legacy key carry over until folds are stored', () => {
  const legacy = JSON.stringify(['w1', 'w2', 3, '', 'w1']);
  assert.deepEqual(loadDesktopState(storage({ [legacyExpandedKey]: legacy })).sidebarFolds, { ...none, expandedFolders: ['w1', 'w2'] },
    'no preferences yet');
  assert.deepEqual(loadDesktopState(storage({ [preferencesKey]: JSON.stringify({ sidebarSort: 'recent' }), [legacyExpandedKey]: legacy })).sidebarFolds.expandedFolders,
    ['w1', 'w2'], 'preferences from before the folds');
  const stored = { ...none, expandedFolders: ['w3'] };
  assert.deepEqual(loadDesktopState(storage({ [preferencesKey]: JSON.stringify({ sidebarFolds: stored }), [legacyExpandedKey]: legacy })).sidebarFolds,
    stored, 'stored folds win over the legacy key');
  assert.deepEqual(sidebarFoldsOf(undefined, '{not json'), none);
  assert.deepEqual(sidebarFoldsOf(undefined, '{"w1": true}'), none);
  assert.equal(foldsKept(sidebarFoldsOf(undefined, legacy)), true);
});

test('malformed folds are dropped piece by piece', () => {
  const folds = sidebarFoldsOf({
    expandedFolders: ['w1', 'w1', 7, null, '', 'x'.repeat(2000), 'w2'],
    collapsedMachines: 'local',
    collapsedGroups: ['other', 'nope', 'recent', 'other'],
    folderListed: { w1: 15, w2: 0, w3: 2.5, w4: '25', w5: -1, w6: 1e9, w7: 25 },
    groupListed: { recent: 50, active: 'x', other: 75, elsewhere: 25 },
  });
  assert.deepEqual(folds, {
    expandedFolders: ['w1', 'w2'], collapsedMachines: [], collapsedGroups: ['recent', 'other'],
    folderListed: { w1: 15, w7: 25 }, groupListed: { recent: 50, other: 75 },
  });
  assert.deepEqual(sidebarFoldsOf([]), none, 'an array is not folds');
  assert.deepEqual(sidebarFoldsOf({ expandedFolders: Array.from({ length: 1500 }, (_, i) => `w${i}`) }).expandedFolders.length, 1000, 'bounded');
});

test('folding a machine or group, and paging a folder or group, is saved and read back', () => {
  const store = memoryStorage();
  store.set(legacyExpandedKey, '["old"]');
  const saved = () => loadDesktopState(storage(Object.fromEntries(store))).sidebarFolds;
  collapseMachine('local', true);
  collapseMachine(JSON.stringify(['ssh', 'box', 22]), true);
  collapseMachine('local', true);
  assert.equal(store.has(legacyExpandedKey), false, 'the first save leaves the legacy key behind');
  collapseGroup('other', true);
  listFolder('w1', 15);
  listFolder('w2', 25);
  listGroup('recent', 50);
  assert.deepEqual(saved(), {
    expandedFolders: [], collapsedMachines: ['local', '["ssh","box",22]'], collapsedGroups: ['other'],
    folderListed: { w1: 15, w2: 25 }, groupListed: { recent: 50 },
  });
  collapseMachine('local', false);
  collapseGroup('other', false);
  listFolder('w1');
  listGroup('recent');
  assert.deepEqual(saved(), { ...none, collapsedMachines: ['["ssh","box",22]'], folderListed: { w2: 25 } }, 'back to the defaults');
  assert.deepEqual(desktopState().sidebarFolds, saved());
  // Switching the sort mode keeps them as they are.
  setDesktop({ sidebarSort: 'recent' });
  setDesktop({ sidebarSort: 'projects' });
  assert.deepEqual(saved(), { ...none, collapsedMachines: ['["ssh","box",22]'], folderListed: { w2: 25 } });
});

test('folds of folders and machines that left the sidebar are dropped', () => {
  const folds: SidebarFolds = {
    expandedFolders: ['w1', 'gone'], collapsedMachines: ['local', 'old-machine'], collapsedGroups: ['active'],
    folderListed: { w1: 15, gone: 25 }, groupListed: { other: 50 },
  };
  assert.deepEqual(prunedFolds(folds, ['w1', 'w2'], ['local']), {
    expandedFolders: ['w1'], collapsedMachines: ['local'], collapsedGroups: ['active'], folderListed: { w1: 15 }, groupListed: { other: 50 },
  });
  assert.equal(prunedFolds(folds, ['w1', 'gone'], ['local', 'old-machine']), folds, 'nothing to drop: the same object');

  const store = memoryStorage();
  setDesktop({ sidebarFolds: folds });
  const writes = () => store.get(preferencesKey);
  pruneSidebarFolds(['w1', 'gone'], ['local', 'old-machine']);
  assert.deepEqual(desktopState().sidebarFolds, folds);
  const before = writes();
  pruneSidebarFolds(['w1'], ['local']);
  assert.notEqual(writes(), before);
  assert.deepEqual(desktopState().sidebarFolds.expandedFolders, ['w1']);
  assert.deepEqual(desktopState().sidebarFolds.collapsedMachines, ['local']);

  // Removing a folder drops its folds at once.
  setDesktop({ sidebarFolds: { ...folds, expandedFolders: ['w1', 'w2'], folderListed: { w1: 15, w2: 25 } } });
  forgetProject('w2');
  assert.deepEqual(desktopState().sidebarFolds.expandedFolders, ['w1']);
  assert.deepEqual(desktopState().sidebarFolds.folderListed, { w1: 15 });
  assert.deepEqual(loadDesktopState(storage(Object.fromEntries(store))).sidebarFolds.folderListed, { w1: 15 });
});

test('a profile that kept any fold opens the sidebar as it was left', () => {
  assert.equal(foldsKept({ ...none, collapsedMachines: ['local'] }), true);
  assert.equal(foldsKept({ ...none, collapsedGroups: ['recent'] }), true);
  assert.equal(foldsKept({ ...none, folderListed: { w: 15 } }), true);
  assert.equal(foldsKept({ ...none, groupListed: { other: 50 } }), true);
});
