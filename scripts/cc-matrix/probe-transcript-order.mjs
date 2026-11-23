// node scripts/cc-matrix/probe-transcript-order.mjs [--versions a,b] [--runs 10] [--config-root dir] [--output dir]
// Samples when Claude Code writes a new session's first tool call relative to its permission
// dialog, and in which order (prompt, attachments, call), in the matrix sandbox (loopback fake
// API, private tmux, Lectern's launch settings, manual mode). --config-root puts CLAUDE_CONFIG_DIR
// (the session JSONL) under that directory instead, e.g. on a slow network disk. Found so far
// (Linux): the dialog always comes first, the call follows about 100 ms later (writes are flushed in
// batches); with the config on a slow disk 2.1.300 (10 of 15 runs) and 2.1.310 (8 of 10) wrote the
// call ahead of its prompt and attachments, parents intact; 2.1.321 and 2.1.330 did not (0 of 10).
// Writes <output>/<version>.json.
import crypto from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureVersion } from './install.mjs';
import { resolveVersions } from './versions.mjs';
import { startFakeApi } from './fake-api.mjs';
import { createSandbox } from './sandbox.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = path.resolve(option('--output') ?? path.join('test-results', 'cc-transcript-order'));
const runs = Number(option('--runs') ?? 10), configRoot = option('--config-root');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { versions } = await resolveVersions({ list: option('--versions') });
const settings = JSON.stringify({ promptSuggestionEnabled: false, enableWorkflows: true, permissions: { defaultMode: 'auto' } });

/** The session JSONL as record types, and where the prompt and the call are in it. */
async function transcript(config) {
  const projects = path.join(config, 'projects');
  let file;
  for (const dir of await readdir(projects).catch(() => [])) for (const name of await readdir(path.join(projects, dir))) if (name.endsWith('.jsonl')) file = path.join(projects, dir, name);
  const rows = file ? (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }) : [];
  return { rows: rows.length, types: rows.map(row => row.type),
    prompt: rows.findIndex(row => row.type === 'user' && /ccm:perm/.test(JSON.stringify(row.message?.content ?? ''))),
    call: rows.findIndex(row => row.type === 'assistant' && row.message?.content?.some?.(block => block.type === 'tool_use')) };
}

await mkdir(output, { recursive: true });
for (const version of versions) {
  const binary = await ensureVersion(version, { log: line => console.log(line) });
  const samples = [];
  for (let run = 1; run <= runs; run++) {
    const api = await startFakeApi({});
    api.script('perm', ({ step }) => step === 0
      ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo allowed > allowed.txt', description: 'Write a marker file' } }] } : { text: 'Done.' });
    const sandbox = await createSandbox({ version, binary, api, label: `${version}-order` });
    const config = configRoot ? path.join(path.resolve(configRoot), `ccm-order-${crypto.randomUUID()}`) : sandbox.config;
    const stop = async () => { await sandbox.close(); await api.close(); if (configRoot) await rm(config, { recursive: true, force: true }); process.exit(130); };
    process.once('SIGINT', stop).once('SIGTERM', stop);
    const sample = { run };
    try {
      if (configRoot) await cp(sandbox.config, config, { recursive: true });
      // Manual mode (as the matrix's perm folder): the call waits in its permission dialog.
      await mkdir(path.join(sandbox.work, '.claude'), { recursive: true });
      await writeFile(path.join(sandbox.work, '.claude', 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' } }));
      const quote = arg => `'${arg.replaceAll("'", "'\\''")}'`;
      const command = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--settings', settings, '--session-id', crypto.randomUUID()].map(quote).join(' ');
      const env = { ...sandbox.env, CLAUDE_CONFIG_DIR: config };
      sandbox.tmux('new-session', '-d', '-s', 'lectern-order', '-x', '120', '-y', '40', '-c', sandbox.work, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), command);
      const pane = sandbox.tmux('list-panes', '-t', 'lectern-order', '-F', '#{pane_id}').trim();
      for (const end = Date.now() + 30_000; Date.now() < end && !/^❯\s*$/m.test(sandbox.capture(pane));) await delay(100);
      sandbox.tmux('send-keys', '-t', pane, '-l', 'Write a marker ccm:perm');
      await delay(300);
      const start = Date.now();
      sandbox.tmux('send-keys', '-t', pane, 'Enter');
      for (const end = Date.now() + 30_000; Date.now() < end && sample.dialogMs === undefined; await delay(20))
        if (/Do you want to proceed\?/.test(sandbox.capture(pane))) sample.dialogMs = Date.now() - start;
      if (sample.dialogMs !== undefined) {
        sample.atDialog = await transcript(config);
        for (const end = Date.now() + 5000; Date.now() < end && sample.callMs === undefined; await delay(20)) {
          const now = await transcript(config);
          if (now.call >= 0) Object.assign(sample, { callMs: Date.now() - start, callFirst: now.call < now.prompt, types: now.types });
        }
      }
    } catch (error) { sample.error = String(error); }
    finally {
      const leftovers = await sandbox.close();
      if (leftovers.length) sample.leftovers = leftovers;
      await api.close();
      if (configRoot) await rm(config, { recursive: true, force: true });
      process.removeListener('SIGINT', stop).removeListener('SIGTERM', stop);
    }
    samples.push(sample);
    console.log(`${version} #${run}: dialog ${sample.dialogMs} ms, call written ${sample.callMs} ms${sample.callFirst ? ', ahead of its prompt' : ''}${sample.error ? ' ' + sample.error : ''}`);
  }
  await writeFile(path.join(output, `${version}.json`), JSON.stringify({ version, configRoot: configRoot ? 'custom' : 'sandbox', samples }, null, 2));
  console.log(`${version}: call ahead of its prompt in ${samples.filter(s => s.callFirst).length} of ${samples.length} runs; not written within 5 s of the dialog in ${samples.filter(s => s.dialogMs !== undefined && s.callMs === undefined).length}`);
}
