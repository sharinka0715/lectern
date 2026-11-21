// npm run test:cc-matrix -- [--versions 2.1.329,stable] [--scenarios new-chat,tools] [--keep | --keep-failed]
//                           [--build] [--from 2.1.300] [--output dir] [--executable packaged-app]
// Drives the desktop app against real Claude Code releases in tmux, each in a
// sandbox with a loopback fake Anthropic API: no model requests, no access to the
// user's own Claude configuration or tmux server. Writes report.json and report.md
// (feature × version) under test-results/cc-matrix/ (or --output).
// Environment: CC_MATRIX_VERSIONS, CC_MATRIX_SCENARIOS, CC_MATRIX_CACHE (where
// releases are installed), CC_MATRIX_KEEP=1, CC_MATRIX_VERSION_TIMEOUT (seconds per
// release, default 1200; also --version-timeout).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureVersion } from './install.mjs';
import { resolveVersions } from './versions.mjs';
import { startFakeApi } from './fake-api.mjs';
import { createSandbox, descendants, reap } from './sandbox.mjs';
import { launchApp, ui, writeWorkspaces, observeNativeNudges } from './app.mjs';
import { FEATURES, SCENARIOS, prepareFolders } from './scenarios.mjs';
import { writeReport } from './report.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = name => args.includes(name);

// Electron needs a display; on a headless Linux box run under xvfb-run.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.CC_MATRIX_NO_XVFB) {
  const result = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, CC_MATRIX_NO_XVFB: '1' } });
  process.exit(result.status ?? 1);
}

const keep = flag('--keep') || process.env.CC_MATRIX_KEEP === '1';
// Each release gets a bounded run; scenarios past the budget are reported, not run.
const budgetMs = Number(option('--version-timeout') ?? process.env.CC_MATRIX_VERSION_TIMEOUT ?? 20 * 60) * 1000;
const executable = option('--executable');
const output = path.resolve(option('--output') ?? path.join('test-results', 'cc-matrix'));
const wanted = (option('--scenarios') ?? process.env.CC_MATRIX_SCENARIOS ?? '').split(/[\s,]+/).filter(Boolean);
const scenarios = wanted.length ? SCENARIOS.filter(scenario => wanted.includes(scenario.id)) : SCENARIOS;
if (wanted.length && scenarios.length !== wanted.length) throw new Error(`Unknown scenario: ${wanted.filter(id => !SCENARIOS.some(s => s.id === id)).join(', ')}. Known: ${SCENARIOS.map(s => s.id).join(', ')}`);
const log = (...parts) => console.log(`[cc-matrix ${new Date().toISOString().slice(11, 19)}]`, ...parts);

if (!executable && (flag('--build') || !existsSync('dist/main/index.cjs'))) {
  log('building the app');
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
}
const { versions, distTags } = await resolveVersions({ list: option('--versions'), from: option('--from') });
log(`versions: ${versions.join(', ')}; scenarios: ${scenarios.map(s => s.id).join(', ')}`);
const appVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, appVersion, distTags,
  features: Object.fromEntries(FEATURES.map(feature => [feature.id, feature.title])), runs: [] };
let failed = 0;
// Ctrl+C or a CI cancel: close the app and the sandbox's private tmux server first.
let active;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  log(`${signal}: cleaning up`);
  const app = active?.launched?.app.process()?.pid;
  const tracked = app ? descendants(app) : [];
  await active?.launched?.app.close().catch(() => {});
  await active?.sandbox?.close({ keep }).catch(() => {});
  await reap(tracked);
  await active?.api?.close().catch(() => {});
  process.exit(130);
});

for (const version of versions) {
  const started = Date.now();
  const dir = path.join(output, version);
  await mkdir(dir, { recursive: true });
  const run = { version, tags: Object.entries(distTags).filter(([tag, value]) => value === version && tag !== 'next').map(([tag]) => tag), features: {}, scenarios: {}, notes: {} };
  for (const scenario of scenarios) for (const feature of scenario.features) run.features[feature] = { status: 'not-covered' };
  const nudges = new Set();
  let api, sandbox, launched;
  try {
    const binary = await ensureVersion(version, { log });
    api = await startFakeApi({ logFile: path.join(dir, 'fake-api.jsonl') });
    sandbox = await createSandbox({ version, binary, api });
    active = { api, sandbox };
    const folders = await prepareFolders(sandbox);
    await writeWorkspaces(sandbox, Object.values(folders));
    launched = await launchApp(sandbox, { output: dir, executable });
    active.launched = launched;
    const helpers = ui(launched.page, sandbox);
    let watching = true;
    // Native one-time prompts are recorded for the report, never answered here.
    const watcher = (async () => { while (watching) { observeNativeNudges(sandbox, nudges); await new Promise(resolve => setTimeout(resolve, 400)); } })();
    for (const scenario of scenarios) {
      const t0 = Date.now();
      if (t0 - started > budgetMs) {
        for (const feature of scenario.features) run.features[feature] = { status: 'fail', error: `not run: the ${budgetMs / 60000} min budget for this release was used up` };
        continue;
      }
      log(`${version} · ${scenario.id}`);
      const results = {};
      const ctx = {
        version, api, sandbox, folders, page: launched.page, app: launched.app, ui: helpers, dir,
        note: (key, value) => { run.notes[`${scenario.id}.${key}`] = JSON.parse(JSON.stringify(value ?? null).replaceAll(sandbox.root, '<sandbox>')); },
        /** One feature row: pass unless fn throws; `skip(reason)` marks it n/a. */
        async check(feature, fn) {
          if (!scenario.features.includes(feature)) throw new Error(`${scenario.id} does not declare ${feature}`);
          try {
            const outcome = await fn();
            results[feature] = outcome?.skip ? { status: 'skip', reason: outcome.skip } : { status: 'pass' };
          } catch (error) {
            results[feature] = { status: 'fail', error: String(error?.stack ?? error).slice(0, 2000) };
            throw error;
          }
        },
      };
      let error;
      try {
        await Promise.race([scenario.run(ctx), new Promise((_, reject) => setTimeout(() => reject(new Error(`scenario timed out after ${scenario.timeoutMs / 1000}s`)), scenario.timeoutMs))]);
      } catch (caught) { error = caught; }
      if (error) {
        const pane = await helpers.pane().catch(() => undefined);
        const evidence = { error: String(error?.stack ?? error), screen: sandbox.capture(pane).split('\n'), transcript: await helpers.transcript().catch(() => []), tools: await helpers.tools().catch(() => []),
          requests: api.requests.slice(-12) };
        await writeFile(path.join(dir, `${scenario.id}.failure.json`), JSON.stringify(evidence, null, 2));
        await launched.page.screenshot({ path: path.join(dir, `${scenario.id}.failure.png`) }).catch(() => {});
        log(`${version} · ${scenario.id} FAILED: ${String(error?.message ?? error).split('\n')[0]}`);
      }
      // Rows the scenario never reached fail with it; rows it finished keep their result.
      for (const feature of scenario.features) run.features[feature] = results[feature] ?? (error ? { status: 'fail', error: `not reached: ${String(error?.message ?? error).split('\n')[0]}` } : { status: 'pass' });
      run.scenarios[scenario.id] = { ms: Date.now() - t0, ok: !error };
      await helpers.closeChat().catch(() => {});
      await launched.page.keyboard.press('Escape').catch(() => {});
    }
    watching = false;
    await watcher;
  } catch (error) {
    run.error = String(error?.stack ?? error);
    log(`${version} aborted: ${error?.message ?? error}`);
    for (const [id, item] of Object.entries(run.features)) if (item.status === 'not-covered') run.features[id] = { status: 'fail', error: `run aborted: ${error?.message ?? error}` };
  } finally {
    // Everything the app started (its own shells, the model-list probe) is tracked by PID.
    const appTree = launched?.app.process()?.pid ? descendants(launched.app.process().pid) : [];
    if (launched) {
      run.rendererErrors = launched.errors.slice(0, 20);
      await launched.app.close().catch(() => {});
    }
    if (api) {
      const ssh = sandbox ? (await sandbox.blockedSsh()).map(args => `ssh:${args.split(/\s+/).find(arg => /@|^[a-z0-9.-]+\.[a-z]+$/i.test(arg)) ?? args.slice(0, 40)}`) : [];
      const hosts = [...new Set([...api.external.map(entry => entry.host), ...ssh])];
      run.api = { requests: api.requests.length, kinds: api.requests.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {}), unknown: api.unknown, externalHosts: hosts };
      // Every outside connection was refused; one aimed at the Anthropic API means
      // the sandbox let a real model request through, which fails the run.
      if (hosts.some(host => /(^|\.)anthropic\.com(:\d+)?$/.test(host))) {
        run.features.isolation = { status: 'fail', error: `attempted connections to ${hosts.join(', ')}` };
      } else run.features.isolation = { status: 'pass' };
      await api.close();
    }
    run.nudges = [...nudges];
    const anyFailed = Object.values(run.features).some(item => item.status === 'fail');
    const leftovers = [...(sandbox ? await sandbox.close({ keep: keep || anyFailed && process.env.CI !== 'true' && flag('--keep-failed') }) : []), ...await reap(appTree)];
    // A process that outlives the run (a Claude, a shell, the app) is a bug in what was tested.
    run.leftovers = leftovers;
    run.features.cleanup = leftovers.length ? { status: 'fail', error: `still running after the run: ${leftovers.map(item => `${item.pid} ${item.command}`).join('; ')}` } : { status: 'pass' };
    if (leftovers.length) failed += anyFailed ? 0 : 1;
    run.durationMs = Date.now() - started;
    if (anyFailed) failed++;
    report.runs.push(run);
    await writeFile(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
    await writeReport(output, report, FEATURES);
    log(`${version} done in ${Math.round(run.durationMs / 1000)}s: ${Object.entries(run.features).map(([id, item]) => `${id}=${item.status}`).join(' ')}`);
  }
}
log(`report: ${path.join(output, 'report.md')}`);
process.exit(failed ? 1 : 0);
