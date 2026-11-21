// node scripts/cc-matrix/probe-classifier-failure.mjs [--versions a,b] [--modes ok,500,hang] [--local]
//   [--keys Enter/Down,Enter] [--then] [--restart] [--simple-first] [--rows 24] [--env K=V] [--rename name] [--output dir]
// Samples what each Claude Code release shows when auto mode's safety check fails,
// in the matrix sandbox (loopback fake API, private tmux, Lectern's launch settings).
// The fake model runs a pipeline marked ccm-unchecked. Like Lectern, the probe leaves
// CLAUDE_CODE_AUTO_MODE_SERVER unset, so the check is to run on the server, which this
// third-party endpoint never does: 2.1.300/2.1.310 show the classifier billing notice,
// 2.1.321+ "Auto mode can't check actions in this session". --local sets the variable
// to 0 in Claude Code's environment (as the test sandboxes do): the check runs locally,
// and the fake API answers or fails it in one way per mode (see MODES). Records every
// distinct screen, the check requests and how they failed, and, with --keys, what the
// keys pressed on each resulting prompt did (footer mode, files written, later
// requests); --then sends a second message afterwards, --restart a new Claude Code
// process in the same configuration, --simple-first runs a command auto mode does not
// check before the pipeline. Writes <output>/<version>/<mode>[.<variant>].json.
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureVersion } from './install.mjs';
import { resolveVersions } from './versions.mjs';
import { startFakeApi } from './fake-api.mjs';
import { createSandbox, readJsonl } from './sandbox.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = path.resolve(option('--output') ?? path.join('test-results', 'cc-classifier-probe'));
const keys = (option('--keys') ?? '').split(',').filter(Boolean); // a,b/c: a and b, then c on the next prompt
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { versions } = await resolveVersions({ list: option('--versions') });
// What the fake API does with the check of an unchecked action.
const MODES = {
  ok: answer => ({ text: answer() }),
  500: () => ({ status: 500, errorType: 'api_error', errorMessage: 'Internal server error' }),
  529: () => ({ status: 529, errorType: 'overloaded_error', errorMessage: 'Overloaded' }),
  429: () => ({ status: 429, errorType: 'rate_limit_error', errorMessage: 'Rate limited' }),
  garbage: () => ({ text: 'I am not able to help with that.' }),
  hang: () => ({ hangMs: 15 * 60_000 }),
  reset: () => ({ reset: true }),
  refused: () => ({ refuseMs: 90_000 }),
};
const modes = (option('--modes') ?? Object.keys(MODES).join(',')).split(',').filter(Boolean);
// Lectern's per-process settings (src/backend/launch-settings.ts), statusLine aside.
const settings = JSON.stringify({ promptSuggestionEnabled: false, enableWorkflows: true, permissions: { defaultMode: 'auto' } });
// --local: the local check, from the environment Claude Code starts in.
const localCheck = args.includes('--local') ? { CLAUDE_CODE_AUTO_MODE_SERVER: '0' } : {};

const screenOf = (sandbox, pane) => sandbox.capture(pane).split('\n').map(row => row.trimEnd()).join('\n').replace(/\n+$/, '');
const composerReady = screen => /^❯\s*$/m.test(screen) && /^\s*─{20,}/m.test(screen);
// A native prompt waiting for an answer: an option list or a key-hint footer at the bottom.
const prompting = screen => /(?:Esc to cancel(?: · [^\n]*)?|Enter to \S[^\n]*)\s*$/.test(screen) && !composerReady(screen.split('\n').slice(-4).join('\n'));
const running = screen => /esc to interrupt/i.test(screen);
const footerMode = screen => screen.split('\n').map(row => row.trim()).filter(Boolean).reverse().find(row => /mode on|manual mode|accept edits|bypass|shift\+tab/i.test(row)) ?? '';

/** Distinct screens until `until(screen)`, a screen unchanged and not running for
 * `stillMs`, or the time runs out. */
async function sample(sandbox, pane, { ms, until, stillMs = 10_000 }) {
  const frames = [];
  let since = Date.now(), reason = 'timeout';
  for (const end = Date.now() + ms; Date.now() < end;) {
    const screen = screenOf(sandbox, pane);
    if (screen && frames.at(-1)?.screen !== screen) { frames.push({ at: Date.now(), screen }); since = Date.now(); }
    if (until?.(screen)) { reason = 'until'; break; }
    if (Date.now() - since > stillMs && !running(screen)) { reason = 'still'; break; }
    await delay(300);
  }
  return { frames, reason };
}

for (const version of versions) {
  const binary = await ensureVersion(version, { log: line => console.log(line) });
  for (const mode of modes) {
    const dir = path.join(output, version);
    await mkdir(dir, { recursive: true });
    const api = await startFakeApi({ logFile: path.join(dir, `${mode}.fake-api.jsonl`) });
    let unchecked = 0;
    api.script('@classifier', ({ action, answer }) => {
      if (!/ccm-unchecked/.test(action)) return { text: answer() };
      unchecked++;
      return MODES[mode](answer);
    });
    // --simple-first: a command auto mode runs without its check comes first.
    const simple = args.includes('--simple-first') ? 1 : 0;
    api.script('probe', ({ step }) => step < simple
      ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo simple > simple.txt', description: 'Simple step' } }] }
      : step < simple + 1
      ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `seq -w 1 3 | sed 's/$/ ccm-unchecked/' | tee unchecked-${step}.txt`, description: `Unchecked step ${step + 1}` } }] }
      : { text: 'Probe finished (ccm-probe-done).' });
    api.script('again', ({ step }) => step < 1
      ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `seq -w 1 3 | sed 's/$/ ccm-unchecked/' | tee again-${step}.txt`, description: 'Unchecked again' } }] }
      : { text: 'Second probe finished (ccm-again-done).' });
    const sandbox = await createSandbox({ version, binary, api, label: `${version}-${mode}` });
    // Interrupted: close this sandbox's tmux server (and so its Claude) before leaving.
    const stop = async () => { await sandbox.close(); await api.close(); process.exit(130); };
    process.once('SIGINT', stop).once('SIGTERM', stop);
    const record = { version, mode, keys, settings: JSON.parse(settings), env: localCheck };
    console.log(`${version} · ${mode}`);
    try {
      const cwd = sandbox.work;
      await mkdir(path.join(cwd, '.claude'), { recursive: true });
      const quote = arg => `'${arg.replaceAll("'", "'\\''")}'`;
      const command = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--settings', settings, '--session-id', crypto.randomUUID()].map(quote).join(' ');
      // --rows N: a shorter terminal; --env K=V: extra variables in Claude Code's environment.
      const env = { ...sandbox.env, ...localCheck, ...Object.fromEntries(args.flatMap((arg, i) => arg === '--env' ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [])) };
      sandbox.tmux('new-session', '-d', '-s', `lectern-probe-${mode}`, '-x', '120', '-y', option('--rows') ?? '50', '-c', cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), command);
      const pane = sandbox.tmux('list-panes', '-t', `lectern-probe-${mode}`, '-F', '#{pane_id}').trim();
      record.startup = (await sample(sandbox, pane, { ms: 20_000, until: composerReady, stillMs: 15_000 })).frames.at(-1)?.screen;
      const send = async text => { sandbox.tmux('send-keys', '-t', pane, '-l', text); await delay(400); sandbox.tmux('send-keys', '-t', pane, 'Enter'); };
      // --rename NAME: a named session (2.1.329+ repeats the name in a rule under some dialogs).
      if (option('--rename')) { await send(`/rename ${option('--rename')}`); await sample(sandbox, pane, { ms: 8000, stillMs: 3000 }); }
      const t0 = Date.now();
      await send('Run the probe ccm:probe');
      const turn = await sample(sandbox, pane, { ms: 5 * 60_000, until: screen => /ccm-probe-done/.test(screen) && composerReady(screen) || prompting(screen), stillMs: 12_000 });
      if (prompting(turn.frames.at(-1)?.screen ?? '')) { await delay(1500); turn.frames.push({ at: Date.now(), screen: screenOf(sandbox, pane) }); turn.reason = 'prompt'; }
      record.turn = turn.frames.map(frame => ({ t: frame.at - t0, screen: frame.screen }));
      record.turnEnd = turn.reason;
      record.checks = api.requests.filter(r => r.kind === 'classifier').map(r => ({ t: r.at - t0, stream: r.stream, maxTokens: r.maxTokens, failed: r.failed, aborted: r.aborted }));
      record.stuck = turn.reason === 'until' ? undefined : turn.frames.at(-1)?.screen;
      record.footerBefore = footerMode(turn.frames.at(-1)?.screen ?? '');
      // --keys: groups separated by "/", each pressed on the prompt the previous one led to.
      const tail = screen => screen.split('\n').slice(-6).join('\n');
      let prompt = record.stuck;
      record.afterKeys = [];
      for (const group of keys.join(',').split('/').map(part => part.split(',').filter(Boolean)).filter(part => part.length)) {
        if (!prompt) break;
        const before = api.requests.length;
        for (const key of group) { sandbox.tmux('send-keys', '-t', pane, key); await delay(500); }
        const after = await sample(sandbox, pane, { ms: 60_000, until: screen => /ccm-probe-done/.test(screen) && composerReady(screen) || prompting(screen) && tail(screen) !== tail(prompt), stillMs: 8_000 });
        const last = after.frames.at(-1)?.screen ?? screenOf(sandbox, pane);
        record.afterKeys.push({ keys: group, frames: after.frames.map(frame => frame.screen), end: after.reason, footer: footerMode(last),
          requests: api.requests.slice(before).map(r => ({ kind: r.kind, script: r.script, step: r.step, failed: r.failed })) });
        record.footerAfter = footerMode(last);
        record.afterKeysEnd = after.reason;
        prompt = prompting(last) && !/ccm-probe-done/.test(last) ? last : undefined;
      }
      if (keys.length && args.includes('--then')) {
        const again = api.requests.length;
        await send('Run it again ccm:again');
        const next = await sample(sandbox, pane, { ms: 3 * 60_000, until: screen => /ccm-again-done/.test(screen) && composerReady(screen) || prompting(screen), stillMs: 12_000 });
        record.next = next.frames.map(frame => frame.screen);
        record.nextEnd = next.reason;
        record.requestsNext = api.requests.slice(again).map(r => ({ kind: r.kind, script: r.script, step: r.step, failed: r.failed }));
      }
      record.files = (await readdir(cwd)).filter(name => /\.txt$/.test(name));
      record.uncheckedChecks = unchecked;
      const transcripts = await sandbox.projectFiles();
      record.transcript = transcripts.length ? (await readJsonl(transcripts[0])).map(entry => ({ type: entry.type, subtype: entry.subtype, level: entry.level,
        text: JSON.stringify(entry.message?.content ?? entry.content ?? '').slice(0, 400) })) : [];
      record.settingsAfter = await readFile(path.join(sandbox.config, 'settings.json'), 'utf8').catch(() => '');
      // What Claude Code remembered in its global config (e.g. the billing notice's acknowledgement).
      const globalConfig = JSON.parse(await readFile(path.join(sandbox.config, '.claude.json'), 'utf8').catch(() => '{}'));
      record.globalAuto = Object.fromEntries(Object.entries(globalConfig).filter(([key]) => /auto|classifier|billing/i.test(key)));
      // --restart: a new Claude Code process in the same configuration runs a checked action again.
      if (args.includes('--restart')) {
        sandbox.tmux('kill-session', '-t', `lectern-probe-${mode}`);
        await delay(1000);
        const again = api.requests.length;
        const second = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--settings', settings, '--session-id', crypto.randomUUID()].map(quote).join(' ');
        sandbox.tmux('new-session', '-d', '-s', `lectern-probe-${mode}-2`, '-x', '120', '-y', option('--rows') ?? '50', '-c', cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), second);
        const pane2 = sandbox.tmux('list-panes', '-t', `lectern-probe-${mode}-2`, '-F', '#{pane_id}').trim();
        await sample(sandbox, pane2, { ms: 20_000, until: composerReady, stillMs: 15_000 });
        sandbox.tmux('send-keys', '-t', pane2, '-l', 'Run it again ccm:again'); await delay(400); sandbox.tmux('send-keys', '-t', pane2, 'Enter');
        const next = await sample(sandbox, pane2, { ms: 3 * 60_000, until: screen => /ccm-again-done/.test(screen) && composerReady(screen) || prompting(screen), stillMs: 12_000 });
        record.restart = next.frames.map(frame => frame.screen);
        record.restartEnd = next.reason;
        record.requestsRestart = api.requests.slice(again).map(r => ({ kind: r.kind, script: r.script, step: r.step, failed: r.failed }));
      }
      record.projectSettings = existsSync(path.join(cwd, '.claude', 'settings.local.json')) ? await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf8') : undefined;
    } catch (error) {
      record.error = String(error?.stack ?? error);
    } finally {
      process.off('SIGINT', stop).off('SIGTERM', stop);
      record.leftovers = await sandbox.close();
      record.external = api.external.map(entry => entry.host);
      await api.close();
      const name = [mode, ...keys.length ? [keys.join('-').replaceAll('/', '+')] : [], ...args.includes('--then') ? ['then'] : [], ...args.includes('--local') ? ['local'] : [],
        ...args.includes('--restart') ? ['restart'] : [], ...args.includes('--simple-first') ? ['simple'] : [],
        ...option('--rows') ? [`rows${option('--rows')}`] : [], ...option('--rename') ? ['named'] : [],
        ...args.flatMap((arg, i) => arg === '--env' ? [args[i + 1].replace(/[^A-Za-z0-9=]/g, '')] : [])].join('.');
      await writeFile(path.join(dir, `${name}.json`), JSON.stringify(record, null, 2));
    }
    console.log(`${version} ${mode}: end=${record.turnEnd} checks=${record.checks?.length} unchecked=${record.uncheckedChecks} files=${record.files?.join('|')} footer="${record.footerBefore}"${keys.length ? ` → "${record.footerAfter}" (${record.afterKeysEnd})` : ''}`);
    if (record.stuck) console.log(record.stuck.split('\n').slice(-30).join('\n'));
  }
}
