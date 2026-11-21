// node scripts/cc-matrix/probe-startup.mjs [--versions a,b] [--variants id,id] [--output dir]
// Samples how each Claude Code release starts with different permission-mode
// launch options, in the matrix sandbox (fresh config, loopback fake API, private
// tmux): the --help text, every distinct startup screen, the footer's mode, what
// a first Bash tool call does, and the side requests (e.g. an auto-mode classifier)
// the release sends. Writes JSON per version for writing parsers and unit tests.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureVersion } from './install.mjs';
import { resolveVersions } from './versions.mjs';
import { startFakeApi } from './fake-api.mjs';
import { createSandbox } from './sandbox.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = path.resolve(option('--output') ?? path.join('test-results', 'cc-startup-probe'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { versions } = await resolveVersions({ list: option('--versions') });
// The per-process settings Lectern passes (statusLine aside), plus each variant's own.
// Like Lectern they leave auto mode's check on the server: the probe's command is one
// auto mode runs unchecked, so neither the billing notice nor "Auto mode can't check
// actions" comes up (a variant's `env` can set CLAUDE_CODE_AUTO_MODE_SERVER=0).
const appSettings = extra => JSON.stringify({ promptSuggestionEnabled: false, enableWorkflows: true, ...extra });
const manual = { permissions: { defaultMode: 'default' } };
const allVariants = [
  { id: 'plain', args: [] },
  { id: 'flag-auto', args: ['--permission-mode', 'auto'] },
  { id: 'settings-auto', settings: { permissions: { defaultMode: 'auto' } } },
  { id: 'flag-auto-haiku', args: ['--permission-mode', 'auto', '--model', 'haiku'] },
  { id: 'flag-auto-disabled', args: ['--permission-mode', 'auto'], userSettings: { permissions: { disableAutoMode: 'disable' } } },
  // A user whose own default is manual: the auto-mode nudge, answered both ways.
  { id: 'user-manual-yes', userSettings: manual, answer: ['Enter'] },
  { id: 'user-manual-no', userSettings: manual, answer: ['Down', 'Enter'] },
  { id: 'user-manual-flag-auto', args: ['--permission-mode', 'auto'], userSettings: manual, answer: ['Down', 'Enter'] },
  { id: 'user-manual-settings-auto', settings: { permissions: { defaultMode: 'auto' } }, userSettings: manual, answer: ['Down', 'Enter'] },
  { id: 'user-manual2-flag-auto', args: ['--permission-mode', 'auto'], userSettings: { permissions: { defaultMode: 'manual' } }, answer: ['Down', 'Enter'] },
];
const only = (option('--variants') ?? '').split(',').filter(Boolean);
const variants = only.length ? allVariants.filter(variant => only.includes(variant.id)) : allVariants;
const footerMode = screen => {
  const line = screen.split('\n').map(row => row.trim()).filter(Boolean).reverse().find(row => /mode on|manual mode|accept edits|bypass/i.test(row));
  return line ?? '';
};

/** Distinct screens of one pane until `until(screen)` or the time runs out. */
async function sample(sandbox, pane, ms, until) {
  const frames = [];
  for (const end = Date.now() + ms; Date.now() < end;) {
    const screen = sandbox.capture(pane).split('\n').map(row => row.trimEnd()).join('\n').replace(/\n+$/, '');
    if (screen && frames.at(-1) !== screen) frames.push(screen);
    if (until?.(screen)) break;
    await delay(250);
  }
  return frames;
}

async function launch(sandbox, variant, extraArgs, cwd) {
  const settings = appSettings(variant.settings ?? {});
  const env = { ...sandbox.env, ...(variant.env ?? {}) };
  const quote = arg => `'${arg.replaceAll("'", "'\\''")}'`;
  const command = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--settings', settings, ...(variant.args ?? []), ...extraArgs].map(quote).join(' ');
  const name = `lectern-probe-${variant.id}-${Date.now() % 100000}`;
  // tmux runs the command with the default shell (SHELL=/bin/sh in the sandbox).
  sandbox.tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), command);
  return sandbox.tmux('list-panes', '-t', name, '-F', '#{pane_id}').trim();
}

const send = async (sandbox, pane, text) => {
  sandbox.tmux('send-keys', '-t', pane, '-l', text);
  await delay(400);
  sandbox.tmux('send-keys', '-t', pane, 'Enter');
};

const composerReady = screen => /^❯\s*$/m.test(screen) && /^\s*─{20,}/m.test(screen);
const dialog = screen => /(Make auto mode your default|auto mode|Auto mode)[^\n]*\?/.test(screen) && /❯\s*\d?\.?\s*\S/.test(screen) && !composerReady(screen);

for (const version of versions) {
  const dir = path.join(output, version);
  await mkdir(path.join(dir, 'bodies'), { recursive: true });
  process.env.CC_MATRIX_DUMP = path.join(dir, 'bodies');
  const binary = await ensureVersion(version, { log: line => console.log(line) });
  const api = await startFakeApi({ logFile: path.join(dir, 'fake-api.jsonl') });
  api.script('probe', ({ step }) => step === 0 ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo probe > probe.txt', description: 'Write a probe file' } }] } : { text: 'Probe finished (ccm-probe-done).' });
  const sandbox = await createSandbox({ version, binary, api });
  const result = { version, help: '', variants: {} };
  try {
    const help = execFileSync(path.join(sandbox.home, '.local', 'bin', 'claude'), ['--help'], { env: sandbox.env, timeout: 30_000 }).toString();
    result.help = help.split('\n').filter((line, i, all) => /permission|auto/i.test(line) || /permission-mode/.test(all[i - 1] ?? '')).join('\n');
    for (const variant of variants) {
      console.log(`${version} · ${variant.id}`);
      const cwd = path.join(sandbox.root, `probe-${variant.id}`);
      await mkdir(cwd, { recursive: true });
      const configFile = path.join(sandbox.config, '.claude.json'), settingsFile = path.join(sandbox.config, 'settings.json');
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      config.projects[cwd] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
      await writeFile(configFile, JSON.stringify(config, null, 2));
      // Each variant starts from the same config: what one variant answered is undone after it.
      const configText = await readFile(configFile, 'utf8'), userSettings = await readFile(settingsFile, 'utf8');
      if (variant.userSettings) await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(userSettings), ...variant.userSettings }));
      const sessionId = crypto.randomUUID();
      const record = { args: variant.args ?? [], settings: variant.settings, env: variant.env, userSettings: variant.userSettings };
      const before = api.requests.length;
      let pane = await launch(sandbox, variant, ['--session-id', sessionId], cwd);
      record.startup = await sample(sandbox, pane, 10_000, screen => composerReady(screen) || dialog(screen));
      record.startupMode = footerMode(record.startup.at(-1) ?? '');
      record.dialog = dialog(record.startup.at(-1) ?? '');
      if (record.dialog) {
        // Settle the prompt the way a user keeping auto mode would, and look again.
        record.answer = variant.answer ?? ['Enter'];
        for (const key of record.answer) { sandbox.tmux('send-keys', '-t', pane, key); await delay(300); }
        record.afterDialog = await sample(sandbox, pane, 6_000, composerReady);
      }
      await send(sandbox, pane, 'Run the probe ccm:probe');
      record.turn = await sample(sandbox, pane, 15_000, screen => /ccm-probe-done/.test(screen) || /Do you want to proceed\?/.test(screen));
      record.endMode = footerMode(record.turn.at(-1) ?? '');
      record.fileWritten = await readFile(path.join(cwd, 'probe.txt'), 'utf8').then(() => true, () => false);
      record.requests = api.requests.slice(before).map(r => ({ kind: r.kind, script: r.script, step: r.step, model: r.model, tools: r.tools?.length, blocks: r.blocks }));
      sandbox.tmux('kill-session', '-t', pane);
      await delay(800);
      pane = await launch(sandbox, variant, ['--resume', sessionId], cwd);
      record.resume = await sample(sandbox, pane, 8_000, screen => composerReady(screen) || dialog(screen));
      record.resumeMode = footerMode(record.resume.at(-1) ?? '');
      sandbox.tmux('kill-session', '-t', pane);
      record.settingsAfter = JSON.parse(await readFile(settingsFile, 'utf8').catch(() => '{}'));
      await writeFile(settingsFile, userSettings);
      record.configAfter = JSON.parse(await readFile(configFile, 'utf8').catch(() => '{}'));
      record.configAfter = Object.fromEntries(Object.entries(record.configAfter).filter(([key]) => /auto|permission|mode/i.test(key)));
      await writeFile(configFile, configText);
      result.variants[variant.id] = record;
      await delay(500);
    }
  } finally {
    result.leftovers = await sandbox.close();
    result.external = api.external.map(entry => entry.host);
    await api.close();
    await writeFile(path.join(dir, 'probe.json'), JSON.stringify(result, null, 2));
  }
  for (const [id, record] of Object.entries(result.variants)) console.log(`${version} ${id}: start="${record.startupMode}" dialog=${record.dialog} end="${record.endMode}" file=${record.fileWritten} resume="${record.resumeMode}"`);
}
