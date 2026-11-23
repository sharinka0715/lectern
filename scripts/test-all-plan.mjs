// How `npm run test:all` (scripts/test-all.mjs) splits its steps across CI jobs
// (`--shard i/n`) and which steps apply on which platform. Kept apart from the
// step list itself so adding, merging or renaming an e2e needs no change here:
// an unknown step costs `defaultSeconds` and runs on every platform but Windows.
// Importing this module runs nothing.

/** Seconds per step on the GitHub Linux runner (ubuntu-latest, run 45221577792; the e2e
 * sped up later by their local gain), used only to balance the shards. Update after a
 * large change in a step's time: test-results/test-all/summary.json of a CI run lists
 * `seconds` per step. */
export const stepSeconds = {
  typecheck: 11, unit: 99, build: 11,
  e2e: 34, 'workbench-ui-e2e': 10, 'history-pagination-e2e': 23, 'history-resume-bar-e2e': 35,
  'history-e2e': 3, 'history-images-e2e': 2, 'handoff-history-ui-e2e': 4, 'ssh-ui-e2e': 14,
  'ssh-status-ui-e2e': 6, 'ssh-login-ui-e2e': 16, 'host-check-e2e': 5, 'ssh-config-import-e2e': 3,
  'sidebar-notifications-e2e': 35, 'sidebar-paging-e2e': 6, 'sidebar-layout-e2e': 21, 'sidebar-split-e2e': 10,
  'sidebar-folds-e2e': 6,
  'titlebar-ui-e2e': 6, 'manual-ui-e2e': 12, 'artifacts-ui-e2e': 15, 'chat-image-thumbnail-e2e': 4,
  'settings-e2e': 12, 'question-ui-e2e': 7, 'permission-early-e2e': 13, 'trust-ui-e2e': 8,
  'session-rename-ui-e2e': 7, 'saved-history-ui-e2e': 3, 'release-notes-ui-e2e': 2, 'update-ui-e2e': 12,
  'i18n-ui-e2e': 8, 'composer-completion-ui': 8, 'file-index-e2e': 27, 'conversation-progress-ui': 9,
  'context-menu-e2e': 2, 'scroll-anchor-e2e': 6, 'content-fade-e2e': 28, 'attachment-ui-e2e': 13,
  'composer-chips-e2e': 22, 'composer-focus-e2e': 30, 'attachment-thumbnail-e2e': 7, 'subagent-column-e2e': 22,
  'task-column-e2e': 17, 'quit-dialog-e2e': 35,
  'foreground-shell-e2e': 11, 'permission-ui-e2e': 24, 'native-dialog-ui-e2e': 12, 'question-early-e2e': 12,
  'background-work-e2e': 16, 'cache-ttl-e2e': 26,
};
/** A step missing from the table (new or renamed) is assumed to take about the mean e2e time. */
export const defaultSeconds = 15;
/** Seconds per step on a runner much slower than the Linux one, used instead of `stepSeconds`
 * there: the macOS runner (macos-latest, runs 45248906264 and 45251269568, two steps at a time as
 * CI runs them) takes 1.3-2.5x per e2e and 1.8x for the unit tests. A step missing here falls
 * back to `stepSeconds`. */
export const platformSeconds = {
  darwin: {
    build: 17, typecheck: 16, unit: 182, 'artifacts-ui-e2e': 34, 'attachment-thumbnail-e2e': 11,
    'attachment-ui-e2e': 20, 'background-work-e2e': 29, 'cache-ttl-e2e': 43,
    'chat-image-thumbnail-e2e': 8, 'composer-chips-e2e': 46, 'composer-completion-ui': 5,
    'composer-focus-e2e': 49, 'content-fade-e2e': 50, 'context-menu-e2e': 7,
    'conversation-progress-ui': 14, e2e: 50, 'file-index-e2e': 60, 'foreground-shell-e2e': 22,
    'handoff-history-ui-e2e': 16, 'history-e2e': 19, 'history-images-e2e': 9,
    'history-pagination-e2e': 30, 'history-resume-bar-e2e': 39, 'host-check-e2e': 15,
    'i18n-ui-e2e': 16, 'manual-ui-e2e': 20, 'native-dialog-ui-e2e': 17, 'permission-early-e2e': 22,
    'permission-ui-e2e': 38, 'question-early-e2e': 26, 'question-ui-e2e': 16, 'quit-dialog-e2e': 78,
    'release-notes-ui-e2e': 7, 'saved-history-ui-e2e': 10, 'scroll-anchor-e2e': 15,
    'session-rename-ui-e2e': 14, 'settings-e2e': 19, 'sidebar-layout-e2e': 36,
    'sidebar-notifications-e2e': 41, 'sidebar-paging-e2e': 12, 'sidebar-split-e2e': 27, 'sidebar-folds-e2e': 12,
    'ssh-config-import-e2e': 5, 'ssh-login-ui-e2e': 29, 'ssh-status-ui-e2e': 10, 'ssh-ui-e2e': 17,
    'subagent-column-e2e': 32, 'task-column-e2e': 25, 'titlebar-ui-e2e': 22, 'trust-ui-e2e': 13,
    'update-ui-e2e': 20, 'workbench-ui-e2e': 16,
  },
};
/** Steps every shard runs (the e2e need dist/); all others go to exactly one shard. */
export const everyShard = new Set(['build']);

/** Windows connects only over SSH (README): no local sessions, no tmux, no `--demo`
 * (its fixture is a local tmux session; on Windows the demo never opens a window), no
 * in-app SSH login. Only these steps run there. The other e2e open local folders or
 * local history, start the demo or tmux, drive Claude Code in tmux, or log in over SSH
 * through a scripted POSIX `ssh` (CI run 45228678404 tried every one on Windows). */
export const windowsSteps = new Set([
  'typecheck', 'unit', 'build',
  'ssh-status-ui-e2e', 'ssh-config-import-e2e', 'update-ui-e2e', 'release-notes-ui-e2e', 'composer-completion-ui',
]);

/** With --jobs, steps that use the system clipboard (one per desktop session, also under
 * Xvfb) never run beside each other. Add a new e2e here when it copies or pastes. */
export const oneAtATime = new Set([
  'e2e', 'workbench-ui-e2e', 'history-pagination-e2e', 'host-check-e2e', 'sidebar-split-e2e', 'manual-ui-e2e',
  'artifacts-ui-e2e', 'chat-image-thumbnail-e2e', 'session-rename-ui-e2e', 'context-menu-e2e', 'attachment-ui-e2e',
  'composer-chips-e2e',
]);

/** With --jobs, steps that run with nothing beside them, after the others (one after another,
 * so no job idles waiting for them). Next to another step on the 3-core macOS runner these failed: the unit tests
 * drive tmux and mock TUIs that redraw every 40–250 ms (screen guards refused), the real CLI
 * did not take the answer of a permission or billing-notice card, the resume bar's layout
 * measurements moved, and the 120,000-file index missed its time limits. */
export const runsAlone = new Set(['unit', 'history-resume-bar-e2e', 'permission-ui-e2e', 'native-dialog-ui-e2e', 'file-index-e2e']);

/** Steps that do not apply on macOS or Linux, each with its reason. */
const skipped = { darwin: {}, linux: {} };

/** Why `step` does not run on `platform` (undefined when it does). */
export function skipReason(platform, step) {
  if (platform === 'win32') return windowsSteps.has(step) ? undefined : 'Windows connects only over SSH: no local sessions, tmux or demo';
  return skipped[platform]?.[step];
}

/** The steps of shard `index` (1-based) of `count`: `everyShard` steps in every shard, the
 * rest split greedily by `stepSeconds` (longest first, each to the currently lightest shard,
 * ties to the lower shard), so the same step list and --jobs always give the same split.
 * With `jobs` steps at a time a step counts 1/jobs of its time, except those in `alone`. Steps
 * keep their order within a shard. Returns the steps and the shard's estimated seconds. */
export function shardOf(names, index, count, jobs = 1, alone = runsAlone, platform = process.platform) {
  const seconds = name => (platformSeconds[platform]?.[name] ?? stepSeconds[name] ?? defaultSeconds) / (alone.has(name) ? 1 : jobs);
  const loads = Array(count).fill(0);
  const owner = new Map();
  const shared = names.filter(name => everyShard.has(name));
  const ranked = names.filter(name => !everyShard.has(name))
    .map((name, order) => ({ name, order })).sort((a, b) => seconds(b.name) - seconds(a.name) || a.order - b.order);
  for (const { name } of ranked) {
    const lightest = loads.indexOf(Math.min(...loads));
    owner.set(name, lightest);
    loads[lightest] += seconds(name);
  }
  const steps = names.filter(name => everyShard.has(name) || owner.get(name) === index - 1);
  const shardSeconds = loads[index - 1] + shared.reduce((sum, name) => sum + seconds(name), 0);
  return { steps, seconds: shardSeconds };
}
