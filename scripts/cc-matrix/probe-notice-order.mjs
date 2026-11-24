// node scripts/cc-matrix/probe-notice-order.mjs --versions 2.1.300,2.1.331 --output <dir>
// Capture the JSONL and terminal at each queue and delivery milestone in the matrix sandbox.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureVersion } from './install.mjs';
import { startFakeApi, textOf } from './fake-api.mjs';
import { createSandbox } from './sandbox.mjs';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const versions = (args.includes('--versions') ? option('--versions') : '2.1.300,2.1.331').split(',');
const output = path.resolve(args.includes('--output') ? option('--output') : 'test-results/cc-notice-order');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const prose = text => ({ type: 'text', text });
const call = (name, input) => ({ type: 'tool_use', name, input });
const gate = file => `until test -f ${file}; do sleep 0.05; done`;
const bash = (command, description, run_in_background = false) => call('Bash', { command, description, run_in_background });

for (const version of versions) {
  const dir = path.join(output, version);
  await mkdir(dir, { recursive: true });
  const binary = await ensureVersion(version, { log: console.log });
  const api = await startFakeApi();
  let toolsSearched = false, launched = false, monitor = false, foreground = false, initial = false;
  api.script('notice-order', ({ body, messages }) => {
    const tools = body.tools.map(tool => tool.name);
    if (!toolsSearched && !tools.includes('Monitor') && tools.includes('ToolSearch')) {
      toolsSearched = true;
      return { blocks: [call('ToolSearch', { query: 'select:Monitor', max_results: 1 })] };
    }
    if (!launched) {
      launched = true;
      monitor = tools.includes('Monitor');
      return { blocks: [prose('Starting the sample tasks.'),
        bash(`${gate('release-pair')}; echo pair-a-done`, 'Sample pair A', true),
        bash(`${gate('release-pair')}; echo pair-b-done`, 'Sample pair B', true),
        bash(`${gate('release-idle')}; echo idle-done`, 'Sample idle task', true),
        call('Agent', { description: 'Sample helper', prompt: 'Return the sample report ccm:notice-child', subagent_type: 'general-purpose', run_in_background: true }),
        ...(monitor ? [call('Monitor', { command: `${gate('release-monitor')}; echo monitor-event; ${gate('finish-monitor')}`, description: 'Sample monitor', timeout_ms: 90_000 })] : [])] };
    }
    if (!foreground) {
      foreground = true;
      return { blocks: [prose('Before the foreground call.'), bash(`${gate('finish-foreground')}; echo foreground-done`, 'Sample foreground call')] };
    }
    if (!initial) {
      initial = true;
      return { blocks: [prose('After the foreground call.'), bash('echo next-call', 'Sample next call')] };
    }
    const last = textOf(messages.at(-1)?.content);
    if (last.includes('Sample idle task')) return { text: 'Reply to the idle task.' };
    if (last.includes('Sample helper') || last.includes('Sample child report.')) return { text: 'Reply to the helper.' };
    if (last.includes('monitor-event')) return { text: 'Reply to the monitor event.' };
    if (last.includes('Sample monitor')) return { text: 'Reply to the monitor completion.' };
    return { text: 'Initial answer complete.' };
  });
  api.script('notice-child', () => ({ gate: 'notice-child', text: 'Sample child report.' }));
  const sandbox = await createSandbox({ version, binary, api, label: `${version}-notice` });
  const sid = randomUUID();
  const clean = value => value.replaceAll(sandbox.root, '/tmp/ccm-sandbox');
  let pane, file;
  const screen = () => clean(sandbox.tmux('capture-pane', '-p', '-J', '-S', '-2000', '-t', pane));
  const session = async () => {
    file ??= (await sandbox.projectFiles()).find(name => name.endsWith(`${sid}.jsonl`));
    return file ? clean(await readFile(file, 'utf8')) : '';
  };
  const frames = [];
  async function stage(name, ready) {
    console.log(`${version}: waiting for ${name}`);
    for (const end = Date.now() + 30_000; Date.now() < end; await delay(50)) {
      const plain = screen(), jsonl = await session();
      if (!ready(plain, jsonl)) continue;
      frames.push({ name, records: jsonl.trimEnd().split('\n').length, plain });
      return;
    }
    throw new Error(`Timed out waiting for ${name}`);
  }
  const release = file => writeFile(path.join(sandbox.work, file), '');
  const countEnqueues = (jsonl, match) => jsonl.split('\n').filter(line => line.includes('"operation":"enqueue"') && match.test(line)).length;
  const idle = plain => /^❯\s*$/m.test(plain) && !/esc to interrupt/i.test(plain.split('\n').slice(-8).join('\n'));
  const answered = text => (plain, jsonl) => plain.includes(text) && idle(plain) && jsonl.split('\n').some(line =>
    line.includes('"type":"assistant"') && line.includes(`"text":${JSON.stringify(text)}`));
  try {
    const settings = { permissions: { disableAutoMode: 'disable', allow: ['Bash', 'Agent', 'Monitor', 'ToolSearch'] } };
    await mkdir(path.join(sandbox.work, '.claude'));
    await writeFile(path.join(sandbox.work, '.claude', 'settings.json'), JSON.stringify(settings));
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--session-id', sid].map(quote).join(' ');
    sandbox.tmux('new-session', '-d', '-s', 'lectern-notice', '-x', '120', '-y', '60', '-c', sandbox.work, command);
    pane = sandbox.panes()[0];
    assert.ok(pane);
    await stage('input ready', idle);
    sandbox.tmux('send-keys', '-t', pane, '-l', 'Sample task notification order ccm:notice-order');
    await delay(250);
    sandbox.tmux('send-keys', '-t', pane, 'Enter');
    await stage('foreground call running', (plain, jsonl) => plain.includes('Before the foreground call.') && jsonl.includes('Sample foreground call'));
    await release('release-pair');
    await stage('pair enqueued during foreground call', (_, jsonl) => countEnqueues(jsonl, /Sample pair [AB]/) >= 2);
    await release('finish-foreground');
    await stage('initial answer complete', answered('Initial answer complete.'));
    await release('release-idle');
    await stage('idle task answered', answered('Reply to the idle task.'));
    api.release('notice-child');
    await stage('helper answered', answered('Reply to the helper.'));
    if (monitor) {
      await release('release-monitor');
      await stage('monitor event answered', answered('Reply to the monitor event.'));
      await release('finish-monitor');
      await stage('monitor completion answered', answered('Reply to the monitor completion.'));
    }
    assert.deepEqual(api.external, []);
    assert.deepEqual(await sandbox.blockedSsh(), []);
  } finally {
    try {
      frames.push({ name: 'final', plain: screen() });
      await writeFile(path.join(dir, 'frames.json'), JSON.stringify({ version, monitor, frames }, null, 2) + '\n');
      await writeFile(path.join(dir, 'session.jsonl'), await session());
    } finally {
      await sandbox.close();
      await api.close();
    }
  }
}
