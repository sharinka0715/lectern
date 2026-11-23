#!/usr/bin/env node
// One entry for the complete offline test suite, locally and in CI:
//   typecheck → unit tests (with the installed-CLI branch cases) → build → every
//   offline desktop e2e script, one after another.
//
//   npm run test:all                       everything
//   npm run test:all -- --e2e-only         reuse the current dist/, run only e2e
//   npm run test:all -- --only e2e,archive-ui-e2e
//   npm run test:all -- --from settings-e2e
//   npm run test:all -- --list
//
// Logs go to test-results/test-all/<step>.log, a summary to summary.txt/json.
// tmux is isolated: TMUX/TMUX_PANE are unset and TMUX_TMPDIR points at a fresh
// private directory whose servers (and only those) are killed at the end, so
// the suite never talks to the developer's own tmux server. On Linux without a
// display the whole run is re-executed under xvfb-run.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOTATIONS_PER_STEP, annotation, inGitHubActions, tailSummary } from './gh-annotations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

/** Offline desktop e2e scripts (scripts/<name>.mjs). None reaches a real model or SSH host. */
export const e2eScripts = [
  'e2e', 'workbench-ui-e2e', 'history-pagination-e2e', 'history-resume-bar-e2e', 'history-e2e',
  'history-images-e2e', 'handoff-history-ui-e2e', 'ssh-ui-e2e', 'ssh-status-ui-e2e', 'ssh-login-ui-e2e', 'host-check-e2e',
  'ssh-config-import-e2e', 'sidebar-notifications-e2e', 'sidebar-paging-e2e', 'sidebar-layout-e2e', 'sidebar-split-e2e',
  'titlebar-ui-e2e', 'manual-ui-e2e', 'artifacts-ui-e2e', 'chat-image-thumbnail-e2e', 'settings-e2e',
  'question-ui-e2e', 'permission-early-e2e', 'trust-ui-e2e', 'session-rename-ui-e2e', 'task-notice-ui-e2e', 'release-notes-ui-e2e',
  'update-ui-e2e', 'i18n-ui-e2e', 'composer-completion-ui', 'file-index-e2e', 'conversation-progress-ui', 'context-menu-e2e',
  'transcript-render-e2e', 'archive-ui-e2e', 'scroll-anchor-e2e', 'attachment-ui-e2e', 'composer-chips-e2e',
  'attachment-thumbnail-e2e', 'subagent-column-e2e', 'task-column-e2e', 'quit-dialog-e2e',
  // These start the installed Claude Code against a loopback fake model (no real request).
  'foreground-shell-e2e', 'permission-ui-e2e', 'native-dialog-ui-e2e', 'question-early-e2e', 'background-work-e2e',
];
const needsClaude = new Set(['foreground-shell-e2e', 'permission-ui-e2e', 'native-dialog-ui-e2e', 'question-early-e2e', 'background-work-e2e']);

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

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [
  { name: 'typecheck', command: [npx, 'tsc', '--noEmit'], skip: e2eOnly },
  { name: 'unit', command: [npm, 'test'], env: { LECTERN_NATIVE_BRANCH_TEST: '1' }, timeout: 20, skip: e2eOnly || flag('--skip-unit') },
  // `npm run build` repeats tsc; the separate typecheck step names the failure clearly.
  { name: 'build', command: [npm, 'run', 'build'], skip: e2eOnly || flag('--skip-build') },
  ...(flag('--no-e2e') ? [] : e2eList.map(name => ({ name, command: [process.execPath, `scripts/${name}.mjs`], e2e: true, retries }))),
].filter(step => !step.skip && (!only || only.includes(step.name)));

if (flag('--list')) {
  for (const step of steps) console.log(step.name);
  process.exit(0);
}

const results = path.join(root, 'test-results');
const logs = path.join(results, 'test-all');
rmSync(logs, { recursive: true, force: true });
mkdirSync(logs, { recursive: true });

// Private tmux: every server any step starts lives below this directory.
const tmuxRoot = mkdtempSync(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'lectern-test-all-'));
const baseEnv = { ...process.env, TMUX_TMPDIR: tmuxRoot, LECTERN_LOCALE: 'zh-CN', FORCE_COLOR: '0' };
delete baseEnv.TMUX; delete baseEnv.TMUX_PANE; delete baseEnv.ELECTRON_RUN_AS_NODE; delete baseEnv.LECTERN_DEV_URL;
delete baseEnv.LECTERN_SHOW_TEST_WINDOWS;
// A CLAUDE_CODE_AUTO_MODE_SERVER of the developer's own (inherited, e.g., from a Claude Code
// session) would decide where auto mode checks actions for every real CLI the suite starts;
// the scripts that need the local check set it themselves.
delete baseEnv.CLAUDE_CODE_AUTO_MODE_SERVER;

function killPrivateTmux() {
  if (process.platform === 'win32') return;
  const env = { ...baseEnv };
  const sockets = [];
  try {
    for (const dir of readdirSync(tmuxRoot)) {
      if (!dir.startsWith('tmux-')) continue;
      for (const socket of readdirSync(path.join(tmuxRoot, dir))) sockets.push(path.join(tmuxRoot, dir, socket));
    }
  } catch { /* nothing started */ }
  for (const socket of sockets) spawnSync('tmux', ['-S', socket, 'kill-server'], { env, stdio: 'ignore', timeout: 10_000 });
  rmSync(tmuxRoot, { recursive: true, force: true });
}

let current;
function stopCurrent(signal = 'SIGTERM') {
  if (!current?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(current.pid), '/t', '/f'], { stdio: 'ignore' });
    else process.kill(-current.pid, signal);
  } catch { /* already gone */ }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopCurrent();
    setTimeout(() => { stopCurrent('SIGKILL'); killPrivateTmux(); process.exit(130); }, 2000);
  });
}

function runStep(step, attempt) {
  const log = path.join(logs, attempt ? `${step.name}.retry${attempt}.log` : `${step.name}.log`);
  const out = createWriteStream(log);
  const started = Date.now();
  const limit = (step.timeout ?? timeoutMinutes) * 60_000;
  return new Promise(resolve => {
    out.write(`$ ${step.command.join(' ')}\n`);
    const child = spawn(step.command[0], step.command.slice(1), {
      cwd: root, env: { ...baseEnv, ...step.env }, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', shell: process.platform === 'win32',
    });
    current = child;
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
    const timer = setTimeout(() => { timedOut = true; keep(`\n[test-all] timed out after ${limit / 60_000} min\n`); stopCurrent(); setTimeout(() => stopCurrent('SIGKILL'), 5000); }, limit);
    child.on('error', error => keep(`\n[test-all] ${error.message}\n`));
    child.on('close', code => {
      clearTimeout(timer);
      current = undefined;
      // A test may leave helpers (tmux clients, Electron helpers) in its group.
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      const seconds = (Date.now() - started) / 1000;
      out.end(`\n[test-all] exit ${code} after ${seconds.toFixed(1)} s\n`);
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
console.log(`test-all: ${steps.length} steps, logs in ${path.relative(root, logs)}/ (tmux in ${tmuxRoot})`);
try {
  for (const step of steps) {
    if (needsClaude.has(step.name) && !claudeAvailable) {
      console.log(`✖ ${step.name}  needs Claude Code on PATH (npm install -g @anthropic-ai/claude-code)`);
      summary.push({ name: step.name, ok: false, seconds: 0, note: 'claude not installed' });
      failureAnnotations.set(step.name, [annotation('error', { title: `${step.name} not run` }, 'Claude Code is not on PATH')]);
      continue;
    }
    process.stdout.write(`… ${step.name}\r`);
    let result = await runStep(step, 0);
    const first = result;
    let attempts = 1;
    while (!result.ok && step.e2e && attempts <= (step.retries ?? 0)) {
      console.log(`↻ ${step.name} failed (exit ${result.code}), retry ${attempts}`);
      result = await runStep(step, attempts++);
    }
    const flaky = result.ok && attempts > 1;
    if (!result.ok) failureAnnotations.set(step.name, result.annotations.length ? result.annotations
      : [annotation('error', { title: `${step.name} failed${result.timedOut ? ' (timed out)' : ` (exit ${result.code})`}` }, tailSummary(result.tail))]);
    if (flaky) retryWarnings.push(annotation('warning', { title: `${step.name} passed only on retry` }, tailSummary(first.tail)));
    const note = step.name === 'unit' ? unitSummary(result.tail) : result.notes.join(' ');
    summary.push({ name: step.name, ok: result.ok, flaky, seconds: Math.round(result.seconds), note, log: path.relative(root, result.log), timedOut: result.timedOut });
    console.log(`${result.ok ? (flaky ? '⚠' : '✔') : '✖'} ${step.name}  ${result.seconds.toFixed(1)} s${flaky ? '  (passed on retry)' : ''}${note ? `  ${note}` : ''}`);
    if (!result.ok) {
      console.log(result.tail.split('\n').slice(-25).map(line => `    ${line}`).join('\n'));
      // Without a build nothing after it can run meaningfully.
      if (step.name === 'build') break;
    }
  }
} finally {
  killPrivateTmux();
}
const failed = summary.filter(s => !s.ok);
const flaky = summary.filter(s => s.flaky);
const minutes = ((Date.now() - began) / 60_000).toFixed(1);
const lines = [
  `test-all ${failed.length ? 'FAILED' : 'PASSED'} in ${minutes} min on ${process.platform}-${process.arch}, node ${process.version}`,
  ...summary.map(s => `${s.ok ? (s.flaky ? 'FLAKY' : 'PASS ') : 'FAIL '} ${s.name.padEnd(28)} ${String(s.seconds).padStart(5)} s${s.note ? `  ${s.note}` : ''}`),
  `${summary.length - failed.length}/${summary.length} passed${flaky.length ? `, ${flaky.length} only on retry` : ''}${failed.length ? `; failed: ${failed.map(s => s.name).join(', ')}` : ''}`,
];
writeFileSync(path.join(logs, 'summary.txt'), lines.join('\n') + '\n');
writeFileSync(path.join(logs, 'summary.json'), JSON.stringify({ ok: !failed.length, minutes: Number(minutes), steps: summary }, null, 2));
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
  const lists = [...failureAnnotations.values()];
  const ordered = [...lists.map(list => list[0]), ...lists.flatMap(list => list.slice(1))];
  const shown = ordered.length > ANNOTATIONS_PER_STEP + 1 ? ordered.slice(0, ANNOTATIONS_PER_STEP) : ordered;
  for (const line of shown) console.log(line);
  if (shown.length < ordered.length) {
    console.log(annotation('error', { title: `${ordered.length - shown.length} more failures` }, `Failed steps: ${failed.map(s => s.name).join(', ')}`));
  }
  for (const line of retryWarnings) console.log(line);
}
