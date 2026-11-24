#!/usr/bin/env node
// One entry for the complete offline test suite, locally and in CI:
//   typecheck → unit tests (with the installed-CLI branch cases) → build → every
//   offline desktop e2e script, one after another.
//
//   npm run test:all                       everything
//   npm run test:all -- --e2e-only         reuse the current dist/, run only e2e
//   npm run test:all -- --only e2e,saved-history-ui-e2e
//   npm run test:all -- --from settings-e2e
//   npm run test:all -- --list
//   npm run test:all -- --shard 1/2        half the steps, balanced by time (CI)
//
// Logs go to test-results/test-all/<step>.log, a summary to summary.txt/json.
// tmux is isolated: TMUX/TMUX_PANE are unset and TMUX_TMPDIR points at a fresh
// private directory per step. Each step closes its sockets before the suite
// removes its private directories.
// On Linux without a display the whole run is re-executed under xvfb-run.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOTATIONS_PER_STEP, annotation, inGitHubActions, tailSummary } from './gh-annotations.mjs';
import { oneAtATime, runsAlone, shardOf, skipReason } from './test-all-plan.mjs';
import { createPrivateTmux, privateTmux } from './fixtures/private-tmux.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

/** Offline desktop e2e scripts (scripts/<name>.mjs). None reaches a real model or SSH host. */
export const e2eScripts = [
  'e2e', 'conversation-settings-e2e', 'workbench-ui-e2e', 'history-pagination-e2e', 'history-resume-bar-e2e', 'history-e2e',
  'history-images-e2e', 'handoff-history-ui-e2e', 'ssh-ui-e2e', 'ssh-status-ui-e2e', 'ssh-login-ui-e2e', 'host-check-e2e',
  'ssh-config-import-e2e', 'sidebar-notifications-e2e', 'sidebar-paging-e2e', 'sidebar-layout-e2e', 'sidebar-split-e2e', 'sidebar-folds-e2e',
  'titlebar-ui-e2e', 'manual-ui-e2e', 'artifacts-ui-e2e', 'chat-image-thumbnail-e2e', 'settings-e2e',
  'question-ui-e2e', 'permission-early-e2e', 'trust-ui-e2e', 'session-rename-ui-e2e', 'saved-history-ui-e2e', 'release-notes-ui-e2e',
  'update-ui-e2e', 'i18n-ui-e2e', 'composer-completion-ui', 'file-index-e2e', 'conversation-progress-ui', 'goal-status-ui-e2e', 'context-menu-e2e',
  'scroll-anchor-e2e', 'content-fade-e2e', 'attachment-ui-e2e', 'composer-chips-e2e', 'composer-focus-e2e',
  'attachment-thumbnail-e2e', 'subagent-column-e2e', 'task-column-e2e', 'quit-dialog-e2e',
  // These start the installed Claude Code against a loopback fake model (no real request).
  'foreground-shell-e2e', 'permission-ui-e2e', 'native-dialog-ui-e2e', 'question-early-e2e', 'background-work-e2e', 'cache-ttl-e2e',
  // The same two with Settings → Session's recording hooks on.
  'question-early-hooks-e2e', 'permission-hooks-e2e',
];
const needsClaude = new Set(['foreground-shell-e2e', 'permission-ui-e2e', 'native-dialog-ui-e2e', 'question-early-e2e', 'background-work-e2e', 'cache-ttl-e2e',
  'question-early-hooks-e2e', 'permission-hooks-e2e']);

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  console.log(`Usage: node scripts/test-all.mjs [options]
  --e2e-only           skip typecheck, unit tests and build (uses the current dist/)
  --skip-unit          skip the unit tests
  --skip-build         skip the build (typecheck still runs unless --e2e-only)
  --no-e2e             stop after the build
  --only a,b           run only these steps (typecheck, unit, build or e2e names)
  --from name          start the e2e list at this script
  --retries n          rerun a failing e2e up to n times (reported as flaky)
  --timeout-min n      per-step timeout in minutes (default 10, unit tests 20)
  --shard i/n          run only shard i of n: build in each, the other steps split by
                       their usual time (scripts/test-all-plan.mjs), the same every run
  --all-platforms      also run steps that do not apply on this platform (Windows runs
                       only a subset, see scripts/test-all-plan.mjs; --only implies it)
  --jobs n             run up to n steps at a time (default 1); e2e wait for the build
  --list               print the steps and exit`);
  process.exit(0);
}

// Re-execute under a virtual display on headless Linux.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.LECTERN_TEST_ALL_XVFB) {
  if (spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status !== 0) {
    console.error('No DISPLAY and xvfb-run is missing. Install xvfb (apt-get install xvfb) or set DISPLAY.');
    process.exit(2);
  }
  const child = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, fileURLToPath(import.meta.url), ...args],
    { stdio: 'inherit', env: { ...process.env, LECTERN_TEST_ALL_XVFB: '1' } });
  process.exit(child.status ?? 1);
}

const only = option('--only')?.split(',').map(s => s.trim()).filter(Boolean);
const e2eOnly = flag('--e2e-only');
const retries = Math.max(0, Number(option('--retries') ?? 0) || 0);
const timeoutMinutes = Number(option('--timeout-min') ?? 10) || 10;
const jobs = Math.max(1, Math.floor(Number(option('--jobs') ?? 1)) || 1);
let e2eList = e2eScripts;
const from = option('--from');
if (from) {
  const index = e2eList.indexOf(from);
  if (index < 0) { console.error(`Unknown e2e script: ${from}`); process.exit(2); }
  e2eList = e2eList.slice(index);
}
for (const name of only ?? []) {
  if (!['typecheck', 'unit', 'build', ...e2eScripts].includes(name)) { console.error(`Unknown step: ${name}`); process.exit(2); }
}
const shardMatch = option('--shard')?.match(/^(\d+)\/(\d+)$/);
const shard = shardMatch && { index: Number(shardMatch[1]), count: Number(shardMatch[2]) };
if (option('--shard') !== undefined && !(shard && shard.index >= 1 && shard.index <= shard.count)) {
  console.error(`--shard takes i/n with 1 <= i <= n, not ${option('--shard')}`); process.exit(2);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [
  { name: 'typecheck', command: [npx, 'tsc', '--noEmit'], skip: e2eOnly },
  { name: 'unit', command: [npm, 'test'], env: { LECTERN_NATIVE_BRANCH_TEST: '1' }, timeout: 20, skip: e2eOnly || flag('--skip-unit') },
  // `npm run build` repeats tsc; the separate typecheck step names the failure clearly.
  { name: 'build', command: [npm, 'run', 'build'], skip: e2eOnly || flag('--skip-build') },
  ...(flag('--no-e2e') ? [] : e2eList.map(name => ({ name, command: [process.execPath, `scripts/${name}.mjs`], e2e: true, retries }))),
].filter(step => !step.skip && (!only || only.includes(step.name)));

// Steps that do not apply on this platform stay out unless named with --only (scripts/test-all-plan.mjs).
const notHere = only || flag('--all-platforms') ? [] : steps.filter(step => skipReason(process.platform, step.name));
const applicable = steps.filter(step => !notHere.includes(step));
const planned = shard ? shardOf(applicable.map(step => step.name), shard.index, shard.count, jobs) : undefined;
const selected = planned ? applicable.filter(step => planned.steps.includes(step.name)) : applicable;
const shardLabel = shard ? `shard ${shard.index}/${shard.count}` : '';
selected.forEach((step, index) => { step.number = index + 1; });

if (flag('--list')) {
  for (const step of selected) console.log(step.name);
  for (const step of notHere) console.error(`(not on ${process.platform}: ${step.name}, ${skipReason(process.platform, step.name)})`);
  if (planned) console.error(`(${shardLabel}: about ${Math.round(planned.seconds)} s on the ${process.platform} CI runner)`);
  process.exit(0);
}

const results = path.join(root, 'test-results');
const logs = path.join(results, 'test-all');
rmSync(logs, { recursive: true, force: true });
mkdirSync(logs, { recursive: true });

// Parent for the tmux directories inherited by the steps.
const tmuxRoot = mkdtempSync(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'lectern-test-all-'));
const baseEnv = { ...process.env, LECTERN_LOCALE: 'zh-CN', FORCE_COLOR: '0' };
delete baseEnv.ELECTRON_RUN_AS_NODE; delete baseEnv.LECTERN_DEV_URL;
delete baseEnv.LECTERN_SHOW_TEST_WINDOWS;
// A CLAUDE_CODE_AUTO_MODE_SERVER of the developer's own (inherited, e.g., from a Claude Code
// session) would decide where auto mode checks actions for every real CLI the suite starts;
// the scripts that need the local check set it themselves.
delete baseEnv.CLAUDE_CODE_AUTO_MODE_SERVER;

// Each step gets its own directory below it (<tmuxRoot>/<step number>), so steps that
// run at the same time (--jobs) never share a tmux server.
function killPrivateTmux() {
  if (process.platform !== 'win32' && existsSync(tmuxRoot)) {
    for (const step of readdirSync(tmuxRoot)) privateTmux(path.join(tmuxRoot, step), { env: baseEnv }).killAll();
  }
  rmSync(tmuxRoot, { recursive: true, force: true });
}

const running = new Set();
let cancelled = false;
function stopChild(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else process.kill(-child.pid, signal);
  } catch { /* already gone */ }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (cancelled) return;
    cancelled = true;
    for (const child of running) stopChild(child);
    setTimeout(() => { for (const child of running) stopChild(child, 'SIGKILL'); }, 2000).unref();
  });
}

function runStep(step, attempt) {
  const log = path.join(logs, attempt ? `${step.name}.retry${attempt}.log` : `${step.name}.log`);
  const out = createWriteStream(log);
  const started = Date.now();
  const limit = (step.timeout ?? timeoutMinutes) * 60_000;
  const tmux = createPrivateTmux(path.join(tmuxRoot, String(step.number)), { env: { ...baseEnv, ...step.env } });
  return new Promise((resolve, reject) => {
    out.write(`$ ${step.command.join(' ')}\n`);
    const child = spawn(step.command[0], step.command.slice(1), {
      cwd: root, env: tmux.env, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', shell: process.platform === 'win32',
    });
    running.add(child);
    let tail = '';
    let partial = '';
    const notes = new Set();
    const annotations = [];
    const keep = chunk => {
      out.write(chunk);
      // Long enough to reach the header of an uncaught error whose properties Node prints after it.
      tail = (tail + chunk).slice(-20000);
      // Scripts print "NOTE: …" when the machine lacks an optional tool and a fallback was checked.
      for (const match of String(chunk).matchAll(/^NOTE: (.+)$/gm)) notes.add(match[1].trim());
      // GitHub error annotations a step prints (the unit test reporter) are repeated on our own output.
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) if (line.startsWith('::error')) annotations.push(line.trimEnd());
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; keep(`\n[test-all] timed out after ${limit / 60_000} min\n`); stopChild(child);
      // Only this step's own process group, and only while it still runs.
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) stopChild(child, 'SIGKILL'); }, 5000); }, limit);
    child.on('error', error => keep(`\n[test-all] ${error.message}\n`));
    child.on('close', code => {
      clearTimeout(timer);
      running.delete(child);
      // A test may leave helpers (tmux clients, Electron helpers) in its group.
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      const seconds = (Date.now() - started) / 1000;
      out.end(`\n[test-all] exit ${code} after ${seconds.toFixed(1)} s\n`);
      try { tmux.killAll(); } catch (error) { reject(error); return; }
      if (partial.startsWith('::error')) annotations.push(partial.trimEnd());
      resolve({ ok: code === 0 && !timedOut, code, seconds, timedOut, tail, log, notes: [...notes], annotations });
    });
  });
}

function unitSummary(tail) {
  const pick = key => tail.match(new RegExp(`ℹ ${key} (\\d+)`))?.[1];
  const [tests, pass, fail, skipped] = ['tests', 'pass', 'fail', 'skipped'].map(pick);
  return tests ? `${tests} tests: ${pass} passed, ${fail} failed, ${skipped} skipped` : '';
}

const claudeAvailable = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? ['claude'] : ['-c', 'command -v claude'], { stdio: 'ignore' }).status === 0;
const summary = [];
// GitHub annotations per failed step (see emitAnnotations) and for steps that passed only on retry.
const failureAnnotations = new Map();
const retryWarnings = [];
const began = Date.now();
console.log(`test-all: ${selected.length} steps${shard ? ` (${shardLabel}, about ${(planned.seconds / 60).toFixed(1)} min on the ${process.platform} CI runner)` : ''}${jobs > 1 ? `, ${jobs} at a time` : ''}, logs in ${path.relative(root, logs)}/ (tmux in ${tmuxRoot})`);
for (const reason of new Set(notHere.map(step => skipReason(process.platform, step.name)))) {
  console.log(`Not on ${process.platform} (${reason}): ${notHere.filter(step => skipReason(process.platform, step.name) === reason).map(step => step.name).join(', ')}`);
}
/** One step with its retries; records the result and returns whether it passed. */
async function runOne(step) {
  if (needsClaude.has(step.name) && !claudeAvailable) {
    console.log(`✖ ${step.name}  needs Claude Code on PATH (npm install -g @anthropic-ai/claude-code)`);
    summary.push({ number: step.number, name: step.name, ok: false, seconds: 0, note: 'claude not installed' });
    failureAnnotations.set(step.name, [annotation('error', { title: `${step.name} not run` }, 'Claude Code is not on PATH')]);
    return false;
  }
  if (jobs > 1) console.log(`… ${step.name}`); else process.stdout.write(`… ${step.name}\r`);
  let result = await runStep(step, 0);
  const first = result;
  let attempts = 1;
  while (!cancelled && !result.ok && step.e2e && attempts <= (step.retries ?? 0)) {
    console.log(`↻ ${step.name} failed (exit ${result.code}), retry ${attempts}`);
    result = await runStep(step, attempts++);
  }
  const flaky = result.ok && attempts > 1;
  if (!result.ok) failureAnnotations.set(step.name, result.annotations.length ? result.annotations
    : [annotation('error', { title: `${step.name} failed${result.timedOut ? ' (timed out)' : ` (exit ${result.code})`}` }, tailSummary(result.tail))]);
  if (flaky) retryWarnings.push(annotation('warning', { title: `${step.name} passed only on retry` }, tailSummary(first.tail)));
  const note = step.name === 'unit' ? unitSummary(result.tail) : result.notes.join(' ');
  summary.push({ number: step.number, name: step.name, ok: result.ok, flaky, seconds: Math.round(result.seconds), note, log: path.relative(root, result.log), timedOut: result.timedOut });
  console.log(`${result.ok ? (flaky ? '⚠' : '✔') : '✖'} ${step.name}  ${result.seconds.toFixed(1)} s${flaky ? '  (passed on retry)' : ''}${note ? `  ${note}` : ''}`);
  if (!result.ok) console.log(result.tail.split('\n').slice(-25).map(line => `    ${line}`).join('\n'));
  return result.ok;
}

// Up to --jobs steps at a time, taken in list order: an e2e starts once the build has passed
// (without it nothing after it can run meaningfully) and steps in `oneAtATime` never overlap one
// another. With more than one job, the steps in `runsAlone` (scripts/test-all-plan.mjs) wait until
// the others are done and then run one after another. With one job: one after another, in order.
const pending = [...selected];
const active = new Map();
let build = selected.some(step => step.name === 'build') ? 'pending' : 'passed';
try {
  while (pending.length || active.size) {
    if (cancelled || build === 'failed') pending.length = 0;
    const busy = [...active.values()];
    const together = pending.filter(step => jobs === 1 || !runsAlone.has(step.name));
    const ready = step => (!step.e2e || build === 'passed') && !(oneAtATime.has(step.name) && busy.some(other => oneAtATime.has(other.name)));
    const step = active.size >= jobs || busy.some(other => jobs > 1 && runsAlone.has(other.name)) ? undefined
      : together.length ? together.find(ready) : active.size ? undefined : pending.find(ready);
    if (step) {
      pending.splice(pending.indexOf(step), 1);
      const run = runOne(step).then(ok => { if (step.name === 'build') build = ok ? 'passed' : 'failed'; active.delete(run); });
      active.set(run, step);
    } else if (active.size) await Promise.race(active.keys());
    else break;
  }
} finally {
  // Other steps can still be closing if one step's cleanup threw.
  await Promise.allSettled(active.keys());
  killPrivateTmux();
}
if (cancelled) process.exit(130);
summary.sort((a, b) => a.number - b.number);
const failed = summary.filter(s => !s.ok);
const flaky = summary.filter(s => s.flaky);
const minutes = ((Date.now() - began) / 60_000).toFixed(1);
const lines = [
  `test-all ${failed.length ? 'FAILED' : 'PASSED'} in ${minutes} min on ${process.platform}-${process.arch}, node ${process.version}${shard ? `, ${shardLabel}` : ''}`,
  ...summary.map(s => `${s.ok ? (s.flaky ? 'FLAKY' : 'PASS ') : 'FAIL '} ${s.name.padEnd(28)} ${String(s.seconds).padStart(5)} s${s.note ? `  ${s.note}` : ''}`),
  `${summary.length - failed.length}/${summary.length} passed${flaky.length ? `, ${flaky.length} only on retry` : ''}${failed.length ? `; failed: ${failed.map(s => s.name).join(', ')}` : ''}`,
];
writeFileSync(path.join(logs, 'summary.txt'), lines.join('\n') + '\n');
writeFileSync(path.join(logs, 'summary.json'), JSON.stringify({ ok: !failed.length, minutes: Number(minutes), platform: process.platform, ...(shard && { shard: shardLabel }), steps: summary }, null, 2));
console.log('\n' + lines.join('\n'));
if (inGitHubActions) emitAnnotations();
if (process.env.GITHUB_STEP_SUMMARY && existsSync(path.dirname(process.env.GITHUB_STEP_SUMMARY))) {
  const table = ['| Step | Result | Seconds | Note |', '| --- | --- | ---: | --- |',
    ...summary.map(s => `| ${s.name} | ${s.ok ? (s.flaky ? '⚠ flaky' : '✅') : '❌'} | ${s.seconds} | ${s.note ?? ''} |`)];
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${lines[0]}\n\n${table.join('\n')}\n`, { flag: 'a' });
}
process.exit(failed.length ? 1 : 0);

/** GitHub keeps about 10 error annotations per step: the first annotation of every
 * failed step comes first, then the remaining ones in step order, then one naming
 * whatever did not fit. Steps that needed a retry get a warning with the first failure. */
function emitAnnotations() {
  const lists = selected.filter(step => failureAnnotations.has(step.name)).map(step => failureAnnotations.get(step.name));
  const ordered = [...lists.map(list => list[0]), ...lists.flatMap(list => list.slice(1))];
  const shown = ordered.length > ANNOTATIONS_PER_STEP + 1 ? ordered.slice(0, ANNOTATIONS_PER_STEP) : ordered;
  for (const line of shown) console.log(line);
  if (shown.length < ordered.length) {
    console.log(annotation('error', { title: `${ordered.length - shown.length} more failures` }, `Failed steps: ${failed.map(s => s.name).join(', ')}`));
  }
  for (const line of retryWarnings) console.log(line);
}
