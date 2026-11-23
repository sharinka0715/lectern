// node scripts/cc-matrix/probe-cache-ttl.mjs [--versions a,b] [--variants id,id] [--output dir]
// Samples which prompt-cache lifetime each Claude Code release asks for, in the matrix sandbox
// (loopback fake API as ANTHROPIC_BASE_URL, an API key, private tmux): the `ttl` of the
// `cache_control` markers in the main conversation's requests and in a subagent's, and the
// status line's `prompt_cache`, under per-process settings (`--settings`), the user's own
// settings file, its `env`, the process environment and FORCE_PROMPT_CACHING_5M.
// Each variant starts an interactive session (as Lectern does), asks the model to start one
// subagent and waits for the subagent's request and the main conversation's reply.
// Writes <output>/<version>.json and prints one line per variant.
// Found (Linux; 2.1.300, 2.1.310, 2.1.321 and 2.1.330 alike): with an API key both kinds of
// request ask for 5 minutes by default (a marker without `ttl`). Each kind follows its own
// setting or variable; 1h adds `ttl: "1h"` and the extended-cache-ttl beta; other values are
// ignored. A variable (process environment or the user's settings `env`) beats any setting
// (--settings or the user's file), --settings beats the user's file, the `env` in --settings
// beats both the process environment and the user's settings `env` (the user's other
// variables stay), and FORCE_PROMPT_CACHING_5M=1 beats everything. The status line's
// `prompt_cache.ttl` follows the main conversation's; settings variables reach child processes.
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureVersion } from './install.mjs';
import { startFakeApi } from './fake-api.mjs';
import { createSandbox } from './sandbox.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = path.resolve(option('--output') ?? path.join('test-results', 'cc-cache-ttl-probe'));
const versions = (option('--versions') ?? '2.1.300,2.1.330').split(',').filter(Boolean);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const both = ttl => ({ promptCacheTtl: ttl, subagentPromptCacheTtl: ttl });
const bothEnv = ttl => ({ CLAUDE_CODE_PROMPT_CACHE_TTL: ttl, CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: ttl });
// settings: Lectern-style --settings additions; userSettings: the user's settings.json;
// env: the process environment Claude Code starts with (the user's shell, through tmux).
const allVariants = [
  { id: 'default' },
  { id: 'settings-1h', settings: both('1h') },
  { id: 'settings-main-1h', settings: { promptCacheTtl: '1h' } },
  { id: 'settings-sub-1h', settings: { subagentPromptCacheTtl: '1h' } },
  { id: 'settings-invalid', settings: { promptCacheTtl: '30m', subagentPromptCacheTtl: '1H' } },
  { id: 'user-1h', userSettings: both('1h') },
  { id: 'user-1h-settings-5m', userSettings: both('1h'), settings: both('5m') },
  { id: 'env-1h', env: bothEnv('1h') },
  { id: 'env-5m-settings-1h', env: bothEnv('5m'), settings: both('1h') },
  { id: 'userenv-5m-settings-1h', userSettings: { env: bothEnv('5m') }, settings: both('1h') },
  { id: 'settingsenv-1h', settings: { env: bothEnv('1h') } },
  { id: 'env-5m-settingsenv-1h', env: bothEnv('5m'), settings: { env: bothEnv('1h') } },
  { id: 'userenv-5m-settingsenv-1h', userSettings: { env: bothEnv('5m') }, settings: { env: bothEnv('1h') } },
  // The user's other settings env stays (settings env objects merge), and what the settings
  // env sets reaches Claude Code's child processes (the status line command records it).
  { id: 'userenv-other-settingsenv-1h', userSettings: { env: { CCM_USER_VAR: 'kept' } }, settings: { env: bothEnv('1h') } },
  { id: 'force5m-settings-1h', env: { FORCE_PROMPT_CACHING_5M: '1' }, settings: both('1h') },
  { id: 'userforce5m-settings-1h', userSettings: { env: { FORCE_PROMPT_CACHING_5M: '1' } }, settings: both('1h') },
  { id: 'enable1h', env: { ENABLE_PROMPT_CACHING_1H: '1' } },
  { id: 'enable1h-settings-5m', env: { ENABLE_PROMPT_CACHING_1H: '1' }, settings: both('5m') },
];
const only = (option('--variants') ?? '').split(',').filter(Boolean);
const variants = only.length ? allVariants.filter(variant => only.includes(variant.id)) : allVariants;
const composerReady = screen => /^❯\s*$/m.test(screen) && /^\s*─{20,}/m.test(screen);
const quote = arg => `'${arg.replaceAll("'", "'\\''")}'`;

async function waitFor(condition, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(250)) if (await condition()) return true;
  return false;
}

await mkdir(output, { recursive: true });
for (const version of versions) {
  const binary = await ensureVersion(version, { log: line => console.log(line) });
  const api = await startFakeApi({ logFile: path.join(output, `${version}-fake-api.jsonl`) });
  api.script('ttl', ({ step }) => step === 0
    ? { blocks: [{ type: 'tool_use', name: 'Agent', input: { description: 'Cache probe helper', prompt: 'Report at once ccm:ttl-child', subagent_type: 'general-purpose' } }] }
    : { text: 'Probe finished (ccm-ttl-done).' });
  api.script('ttl-child', () => ({ text: 'Child finished.' }));
  const sandbox = await createSandbox({ version, binary, api, label: `${version}-ttl` });
  const recorder = path.join(sandbox.root, 'status-recorder.mjs');
  // The status line command appends what Claude Code passes it, one JSON per line.
  await writeFile(recorder, "import { appendFileSync, readFileSync } from 'node:fs';\nconst raw = readFileSync(0, 'utf8');\nconst env = Object.fromEntries(['CCM_USER_VAR', 'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'].map(name => [name, process.env[name]]));\ntry { appendFileSync(process.argv[2], JSON.stringify({ ...JSON.parse(raw), env }) + '\\n'); } catch {}\nprocess.stdout.write('probe');\n");
  const result = { version, variants: {} };
  const stop = async () => { await sandbox.close(); await api.close(); process.exit(130); };
  process.once('SIGINT', stop);
  try {
    for (const variant of variants) {
      const cwd = path.join(sandbox.root, `probe-${variant.id}`);
      await mkdir(cwd, { recursive: true });
      const configFile = path.join(sandbox.config, '.claude.json'), settingsFile = path.join(sandbox.config, 'settings.json');
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      config.projects[cwd] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
      await writeFile(configFile, JSON.stringify(config, null, 2));
      const userSettings = await readFile(settingsFile, 'utf8');
      if (variant.userSettings) await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(userSettings), ...variant.userSettings }));
      const statusFile = path.join(sandbox.root, `status-${variant.id}.jsonl`);
      // Accept edits mode starts subagents without asking (auto mode would want its server check,
      // which the fake API, a gateway, does not pass through).
      const settings = { promptSuggestionEnabled: false, permissions: { defaultMode: 'acceptEdits' }, statusLine: { type: 'command', command: `node ${quote(recorder)} ${quote(statusFile)}` }, ...variant.settings };
      const env = { ...sandbox.env, ...variant.env };
      const command = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--settings', JSON.stringify(settings), '--session-id', crypto.randomUUID()].map(quote).join(' ');
      const name = `ttl-${variant.id}`.slice(0, 40);
      const before = api.requests.length;
      sandbox.tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), command);
      const pane = sandbox.tmux('list-panes', '-t', name, '-F', '#{pane_id}').trim();
      const record = { settings: variant.settings, userSettings: variant.userSettings, env: variant.env };
      record.ready = await waitFor(() => composerReady(sandbox.capture(pane)), 20_000);
      sandbox.tmux('send-keys', '-t', pane, '-l', 'Probe the cache ccm:ttl');
      await delay(400);
      sandbox.tmux('send-keys', '-t', pane, 'Enter');
      const mine = () => api.requests.slice(before);
      record.finished = await waitFor(() => /ccm-ttl-done/.test(sandbox.capture(pane)) && mine().some(r => r.script === 'ttl-child' && r.done), 40_000);
      // The status line runs again about 300 ms after a new reply; give the subagent's
      // completion notice its own main-conversation turn too.
      await delay(3000);
      const requests = mine().filter(r => !['count_tokens', 'models'].includes(r.kind));
      // Which conversation a request belongs to goes by its script: 2.1.330 offers subagents
      // the Agent tool too, so the fake API's own `kind` calls both "main".
      const bucket = r => r.script === 'ttl' ? 'main' : r.script === 'ttl-child' ? 'agent' : r.kind;
      record.requests = requests.map(r => ({ bucket: bucket(r), kind: r.kind, script: r.script, step: r.step, cacheTtl: r.cacheTtl, beta: String(r.beta ?? '').split(',').map(b => b.trim()).filter(b => /cache|ttl/i.test(b)) }));
      const ttls = kind => [...new Set(requests.filter(r => bucket(r) === kind).flatMap(r => r.cacheTtl))].sort();
      record.main = ttls('main');
      record.agent = ttls('agent');
      record.other = [...new Set(requests.filter(r => !['main', 'agent'].includes(bucket(r))).flatMap(r => r.cacheTtl.map(ttl => `${r.kind}:${ttl}`)))].sort();
      const samples = (await readFile(statusFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      record.statusLine = samples.map(sample => sample.prompt_cache).filter(Boolean).at(-1);
      record.childEnv = samples.at(-1)?.env;
      if (!record.finished) record.screen = sandbox.capture(pane);
      sandbox.tmux('kill-session', '-t', name);
      await writeFile(settingsFile, userSettings);
      result.variants[variant.id] = record;
      console.log(`${version} ${variant.id}: main=${record.main.join('+') || '-'} agent=${record.agent.join('+') || '-'} other=${record.other.join('+') || '-'} statusLine.ttl=${record.statusLine?.ttl ?? '-'} childEnv=${JSON.stringify(record.childEnv ?? {})}${record.finished ? '' : ' (not finished)'}`);
      await delay(500);
    }
  } finally {
    result.leftovers = await sandbox.close();
    result.external = api.external.map(entry => entry.host);
    await api.close();
    await writeFile(path.join(output, `${version}.json`), JSON.stringify(result, null, 2));
  }
}
