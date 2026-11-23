// node scripts/cc-matrix/probe-question-order.mjs [--versions a,b] [--runs 3] [--tail-ms 3000] [--output dir] [--frames]
// Samples when Claude Code writes an AskUserQuestion call relative to its dialog, and what its
// own session record (sessions/<pid>.json) says meanwhile, in the matrix sandbox (loopback fake
// API, private tmux, Lectern's launch settings). The model streams like a real one: a reply text,
// then the call, then --tail-ms before the end of the stream (a gateway's late end of stream).
// Each run asks one question (answered with Enter) and then two (a choice, a checked box, submit).
// Found (Linux): with --tail-ms 3000, 2.1.300, 2.1.310, 2.1.321 and 2.1.330 alike write neither the
// reply text nor the call while the question is up, before or after the end of the stream; the
// assistant record comes once the question is answered, together with its result (within 3 ms).
// With --tail-ms 0 the call follows the dialog by about 170 ms (2.1.300, 2.1.310) or at once
// (2.1.321, 2.1.330). Either way the record says status "waiting", waitingFor "input needed" the
// whole time. --frames writes the screens at the dialog to <output>/<version>-<case>.txt.
// Writes <output>/<version>.json.
import crypto from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureVersion } from './install.mjs';
import { resolveVersions } from './versions.mjs';
import { startFakeApi } from './fake-api.mjs';
import { createSandbox } from './sandbox.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = path.resolve(option('--output') ?? path.join('test-results', 'cc-question-order'));
const runs = Number(option('--runs') ?? 3), tailMs = Number(option('--tail-ms') ?? 3000), frames = args.includes('--frames');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { versions } = await resolveVersions({ list: option('--versions') });
const settings = JSON.stringify({ promptSuggestionEnabled: false, enableWorkflows: true, permissions: { defaultMode: 'auto' } });
const drink = { header: 'Drink', question: 'Which drink should we serve?', multiSelect: false, options: [
  { label: 'Tea', description: 'A warm infusion.' }, { label: 'Juice', description: 'A cold drink.' }] };
const snacks = { header: 'Snacks', question: 'Which snacks should we pack?', multiSelect: true, options: [
  { label: 'Fruit', description: 'Fresh fruit.' }, { label: 'Bread', description: 'Fresh bread.' }] };
const cases = { single: { questions: [drink], keys: ['Enter'] }, multi: { questions: [drink, snacks], keys: ['Enter', 'Space', 'Right', 'Enter'] } };

/** Where the call, its reply text and its result are in the session JSONL. */
async function transcript(config) {
  const projects = path.join(config, 'projects');
  let file;
  for (const dir of await readdir(projects).catch(() => [])) for (const name of await readdir(path.join(projects, dir))) if (name.endsWith('.jsonl')) file = path.join(projects, dir, name);
  const rows = file ? (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }) : [];
  const blocks = row => Array.isArray(row.message?.content) ? row.message.content : [];
  return { rows: rows.length,
    call: rows.some(row => row.type === 'assistant' && blocks(row).some(b => b.type === 'tool_use' && b.name === 'AskUserQuestion')),
    text: rows.some(row => row.type === 'assistant' && blocks(row).some(b => b.type === 'text' && /Let me ask/.test(b.text))),
    result: rows.some(row => row.type === 'user' && blocks(row).some(b => b.type === 'tool_result')) };
}
const presence = async (config, pid) => { try { const r = JSON.parse(await readFile(path.join(config, 'sessions', `${pid}.json`), 'utf8')); return { status: r.status, waitingFor: r.waitingFor }; } catch { return {}; } };

await mkdir(output, { recursive: true });
for (const version of versions) {
  const binary = await ensureVersion(version, { log: line => console.log(line) });
  const samples = [];
  for (let run = 1; run <= runs; run++) for (const [name, plan] of Object.entries(cases)) {
    const api = await startFakeApi({});
    let streamEnd;
    api.script('ask', ({ step }) => step === 0
      ? { blocks: [{ type: 'text', text: 'Let me ask before I start.' }, { type: 'tool_use', name: 'AskUserQuestion', input: { questions: plan.questions } }], tailMs }
      : { text: 'Thanks, noted.' });
    const sandbox = await createSandbox({ version, binary, api, label: `${version}-question` });
    const stop = async () => { await sandbox.close(); await api.close(); process.exit(130); };
    process.once('SIGINT', stop).once('SIGTERM', stop);
    const sample = { run, case: name, timeline: [] };
    try {
      const quote = arg => `'${arg.replaceAll("'", "'\\''")}'`;
      const command = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--settings', settings, '--session-id', crypto.randomUUID()].map(quote).join(' ');
      sandbox.tmux('new-session', '-d', '-s', 'lectern-question', '-x', '120', '-y', '40', '-c', sandbox.work, ...Object.entries(sandbox.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), command);
      const pane = sandbox.tmux('list-panes', '-t', 'lectern-question', '-F', '#{pane_id}').trim();
      const pid = sandbox.tmux('display-message', '-p', '-t', pane, '#{pane_pid}').trim();
      for (const end = Date.now() + 30_000; Date.now() < end && !/^❯\s*$/m.test(sandbox.capture(pane));) await delay(100);
      sandbox.tmux('send-keys', '-t', pane, '-l', 'Ask me first ccm:ask');
      await delay(300);
      const start = Date.now();
      sandbox.tmux('send-keys', '-t', pane, 'Enter');
      for (const end = Date.now() + 30_000; Date.now() < end && sample.dialogMs === undefined; await delay(20))
        if (/Enter to select/.test(sandbox.capture(pane))) sample.dialogMs = Date.now() - start;
      if (sample.dialogMs !== undefined) {
        if (frames) await writeFile(path.join(output, `${version}-${name}.txt`), sandbox.capture(pane).replaceAll(sandbox.root, '/tmp/ccm-sandbox'));
        // The dialog stays up: sample until well after the stream ended.
        for (const end = Date.now() + tailMs + 1500; Date.now() < end; await delay(150)) {
          const request = api.requests.find(r => r.script === 'ask' && r.step === 0);
          streamEnd ??= request?.done ? request.done - start : undefined;
          sample.timeline.push({ ms: Date.now() - start, streamEnded: streamEnd !== undefined, ...await transcript(sandbox.config), ...await presence(sandbox.config, pid) });
        }
        sample.streamEndMs = streamEnd;
        for (const key of plan.keys) { sandbox.tmux('send-keys', '-t', pane, key); await delay(400); }
        const answered = Date.now();
        for (const end = Date.now() + 5000; Date.now() < end && sample.callAfterAnswerMs === undefined; await delay(30)) {
          const now = await transcript(sandbox.config);
          if (now.call) Object.assign(sample, { callAfterAnswerMs: Date.now() - answered, resultWithCall: now.result });
        }
        sample.after = { ...await transcript(sandbox.config), ...await presence(sandbox.config, pid) };
      }
    } catch (error) { sample.error = String(error); }
    finally {
      const leftovers = await sandbox.close();
      if (leftovers.length) sample.leftovers = leftovers;
      await api.close();
      process.removeListener('SIGINT', stop).removeListener('SIGTERM', stop);
    }
    samples.push(sample);
    const up = sample.timeline;
    const states = [...new Set(up.map(s => `${s.status}/${s.waitingFor ?? '-'}`))].join(', ');
    console.log(`${version} #${run} ${name}: dialog ${sample.dialogMs} ms, stream end ${sample.streamEndMs} ms; call in transcript while up: ${up.filter(s => s.call).length}/${up.length} samples (first at ${up.find(s => s.call)?.ms} ms); reply text: ${up.filter(s => s.text).length}; record: ${states}; call written ${sample.callAfterAnswerMs ?? '-'} ms after answering${sample.error ? ' ' + sample.error : ''}`);
  }
  await writeFile(path.join(output, `${version}.json`), JSON.stringify({ version, tailMs, samples }, null, 2));
}
