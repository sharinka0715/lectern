// node scripts/cc-matrix/probe-preview-rows.mjs [--versions a,b] [--term screen|tmux-256color] [--theme dark|light]
//   [--output dir] [--interval-ms 120]
// Samples the rows Claude Code draws around a reply while background work runs, in the matrix
// sandbox (loopback fake API, private tmux, Lectern's launch settings, a 120×40 pane). The main
// loop starts a background shell, three background subagents (and a Monitor where offered), runs
// two foreground commands (folded into "Ran 2 shell commands") and the file tools (an edit's
// diff), thinks, and streams its reply slowly, Markdown of every kind and prose that reads like
// the rows around it included. Once the turn ends ("Waiting for N background agents to finish"), one subagent sends the
// main session a message and hands back, another hands back; each arrival starts a turn without a
// prompt that streams prose and runs a foreground `sleep` ("Running 1 shell command…").
// Every --interval-ms it captures the scrollback the way Lectern does (capture-pane -p -J -S -2000),
// the same with -e (colours and attributes), and the viewport, in one tmux command list, together
// with the session JSONL's size at that moment. Writes <output>/<version>/frames.json (distinct
// frames) and session.jsonl, the sandbox path replaced by /tmp/ccm-sandbox.
import crypto from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureVersion } from './install.mjs';
import { startFakeApi } from './fake-api.mjs';
import { createSandbox } from './sandbox.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = path.resolve(option('--output') ?? path.join('test-results', 'cc-preview-rows'));
const versions = (option('--versions') ?? '2.1.331').split(',').filter(Boolean);
// tmux's default-terminal and Claude Code's theme, as a user's setup may have them. Claude Code paints
// 16 colours under tmux's default "screen", 256 under "tmux-256color" or with COLORTERM set (also
// truecolor: tmux gets 256), whatever FORCE_COLOR says.
const term = option('--term') ?? 'screen', theme = option('--theme') ?? 'dark';
const colors = term === 'screen' ? '16' : '256';
const interval = Number(option('--interval-ms') ?? 120);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settings = JSON.stringify({ promptSuggestionEnabled: false, enableWorkflows: true, permissions: { defaultMode: 'auto' } });
const PROMPT = 'Sample the preview rows ccm:rows';
const prose = n => `Paragraph ${n} streams slowly so the screen shows it before the transcript has it. ` +
  'It mentions ● bullets, › pointers and Ran 1 shell command in plain prose, and 中文的句子也在这里。';
const slow = { chunk: 10, delayMs: 110 };
// Prose that looks like the rows around it, and every kind of Markdown block.
const rich = ['## A heading', '', 'Some **bold**, *italic*, `inline code` and a [link](https://example.com).', '',
  '> A quoted line.', '', '1. first', '2. second', '', '| Name | Value |', '|------|-------|', '| a | 1 |', '',
  '```js', 'const x = 1; // ● not a bullet', '```', '', '● Agent "Prose" finished · 2s', '› Message from @prose', '✻ Waiting for 2 background agents to finish',
  'Running 1 shell command…', '', '---', '', '### A small heading', '', '- [ ] a task', '  - a nested item', '', '`only inline code`', '',
  '```sh', '# only a comment', '```', '', '中文段落：结束。'].join('\n');

function scripts(api) {
  const answers = new Map();
  let turns = 0;
  api.script('rows', ({ step, body, messages, toolResults }) => {
    if (answers.has(step)) return answers.get(step);
    const offered = (body.tools ?? []).map(tool => tool.name);
    let answer;
    if (step === 0 && !offered.includes('Monitor') && offered.includes('ToolSearch') && !answers.size) answer = { blocks: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:Monitor', max_results: 1 } }] };
    else if (![...answers.values()].some(a => a.launch)) answer = { launch: true, blocks: [
      { type: 'text', text: 'Starting the background work.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'sleep 1; echo shell-finished', description: 'Background sleeper', run_in_background: true } },
      ...(offered.includes('Monitor') ? [{ type: 'tool_use', name: 'Monitor', input: { command: 'for i in 1 2; do echo tick-$i; sleep 1; done', description: 'Tick watcher', timeout_ms: 60000 } }] : []),
      { type: 'tool_use', name: 'Agent', input: { description: 'Quick helper', prompt: 'Check quickly ccm:rows-a', subagent_type: 'general-purpose', run_in_background: true } },
      { type: 'tool_use', name: 'Agent', input: { description: 'Messenger helper', prompt: 'Report by message ccm:rows-b', subagent_type: 'general-purpose', run_in_background: true } },
      { type: 'tool_use', name: 'Agent', input: { description: 'Long helper', prompt: 'Keep working ccm:rows-c', subagent_type: 'general-purpose', run_in_background: true } }] };
    else if (![...answers.values()].some(a => a.checks)) answer = { checks: true, blocks: [
      { type: 'thinking', thinking: 'Two quick checks before the summary.' },
      { type: 'text', text: 'Two quick checks first.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'echo one', description: 'First check' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'echo two', description: 'Second check' } },
      { type: 'tool_use', name: 'Write', input: { file_path: 'notes.txt', content: 'alpha\nbeta\n' } }] };
    else if (![...answers.values()].some(a => a.edit)) answer = { edit: true, blocks: [
      { type: 'text', text: 'Now a small edit.' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'notes.txt', old_string: 'beta', new_string: 'gamma' } },
      { type: 'tool_use', name: 'Read', input: { file_path: 'notes.txt' } }] };
    else if (toolResults.some(result => /slept/.test(result.text))) answer = { ...slow, text: `${prose(++turns)}\n\n- a list item\n- another item\n\n${rich}` };
    else if (![...answers.values()].some(a => a.first)) answer = { first: true, ...slow, text: `${prose(++turns)}\n\n${prose(++turns)}` };
    else answer = { ...slow, blocks: [{ type: 'text', text: prose(++turns) }, { type: 'tool_use', name: 'Bash', input: { command: 'sleep 3; echo slept', description: 'Short wait' } }] };
    answers.set(step, answer);
    return answer;
  });
  // Subagents, held at their gates: hand back where Claude Code offers it (2.1.33x; shown in the main
  // session as "› Message from @general-purpose"), else end with text. The messenger also tries a
  // SendMessage to the main session first.
  const helper = (gate, report, message) => ({ step, body, messages }) => {
    const offered = (body.tools ?? []).map(tool => tool.name);
    if (step === 0) return { gate, text: 'Looking.', ...(message && offered.includes('ToolSearch') && !offered.includes('SendMessage') ? { blocks: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'select:SendMessage', max_results: 1 } }] } : {}) };
    if (message && offered.includes('SendMessage') && !messages.some(m => JSON.stringify(m.content).includes('Progress from the messenger')))
      return { blocks: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'main', summary: 'Progress', message: 'Progress from the messenger: halfway there.' } }] };
    if (offered.includes('SubagentHandback')) return { blocks: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] };
    return { text: report };
  };
  api.script('rows-a', helper('rows-a', 'Quick helper report: nothing to fix.'));
  api.script('rows-b', helper('rows-b', 'Messenger report: all checks pass.', true));
  api.script('rows-c', helper('rows-c', 'Long helper report: done at last.'));
}

await mkdir(output, { recursive: true });
for (const version of versions) {
  const binary = await ensureVersion(version, { log: line => console.log(line) });
  const api = await startFakeApi({});
  scripts(api);
  const sandbox = await createSandbox({ version, binary, api, label: `${version}-rows` });
  const dir = path.join(output, [version, colors !== '16' && colors, theme !== 'dark' && theme].filter(Boolean).join('-'));
  await mkdir(dir, { recursive: true });
  const clean = text => text.replaceAll(sandbox.root, '/tmp/ccm-sandbox');
  const frames = [], seen = new Set(), started = Date.now(), log = [];
  const note = event => { log.push({ ms: Date.now() - started, event }); console.log(`${version} +${Date.now() - started}ms ${event}`); };
  try {
    // Claude Code checks auto mode's actions itself (the fake API runs no server check).
    await writeFile(path.join(sandbox.config, 'settings.json'), JSON.stringify({ autoUpdates: false, env: { CLAUDE_CODE_AUTO_MODE_SERVER: '0' } }));
    const config = path.join(sandbox.config, '.claude.json');
    await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), theme }));
    const sessionId = crypto.randomUUID();
    const quote = arg => `'${arg.replaceAll("'", "'\\''")}'`;
    const command = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--settings', settings, '--session-id', sessionId].map(quote).join(' ');
    const conf = path.join(sandbox.root, 'tmux.conf');
    await writeFile(conf, `set -g default-terminal ${term}\n`);
    sandbox.tmux('-f', conf, 'new-session', '-d', '-s', 'lectern-rows', '-x', '120', '-y', '40', '-c', sandbox.work, ...Object.entries(sandbox.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), command);
    const pane = sandbox.tmux('list-panes', '-t', 'lectern-rows', '-F', '#{pane_id}').trim();
    for (const end = Date.now() + 30_000; Date.now() < end && !/^❯\s*$/m.test(sandbox.capture(pane));) await delay(100);
    const jsonl = async () => { for (const file of await sandbox.projectFiles()) if (file.endsWith(`${sessionId}.jsonl`)) return file; };
    const mark = `__ccm_${crypto.randomUUID()}__`;
    const capture = async () => {
      const file = await jsonl();
      const bytes = file ? (await stat(file)).size : 0;
      const raw = sandbox.tmux('capture-pane', '-p', '-J', '-S', '-2000', '-t', pane, ';', 'display-message', '-p', mark,
        ';', 'capture-pane', '-p', '-J', '-e', '-S', '-2000', '-t', pane, ';', 'display-message', '-p', mark, ';', 'capture-pane', '-p', '-J', '-t', pane);
      const [plain, ansi, viewport] = raw.split(`${mark}\n`);
      if (viewport === undefined || seen.has(ansi)) return plain ?? '';
      seen.add(ansi);
      frames.push({ ms: Date.now() - started, jsonlBytes: bytes, plain: clean(plain), ansi: clean(ansi), viewport: clean(viewport) });
      return plain;
    };
    sandbox.tmux('send-keys', '-t', pane, '-l', PROMPT);
    await delay(300);
    sandbox.tmux('send-keys', '-t', pane, 'Enter');
    note('prompt sent');
    const until = async (test, ms, label) => {
      for (const end = Date.now() + ms; Date.now() < end; await delay(interval)) if (test(await capture())) return note(label) ?? true;
      note(`timeout waiting for ${label}`);
      return false;
    };
    const waiting = screen => /Waiting for \d+ background agents? to finish/.test(screen);
    await until(screen => waiting(screen) && /^❯\s*$/m.test(screen), 60_000, 'first turn over, waiting for agents');
    api.release('rows-b');
    note('released the messenger');
    await until(screen => /Running \d+ shell command/.test(screen), 30_000, 'a notification turn runs a command');
    api.release('rows-a');
    note('released the quick helper');
    for (const end = Date.now() + 25_000; Date.now() < end; await delay(interval)) await capture();
    api.release('rows-c');
    note('released the long helper');
    await until(screen => /(?:Baked|Worked|Cooked|Brewed|Crunched|Churned|Sautéed|Cogitated) for/.test(screen.split('\n').slice(-12).join('\n')) && !waiting(screen.split('\n').slice(-12).join('\n')), 60_000, 'all done');
    for (const end = Date.now() + 2000; Date.now() < end; await delay(interval)) await capture();
    const file = await jsonl();
    if (file) await writeFile(path.join(dir, 'session.jsonl'), clean(await readFile(file, 'utf8')));
  } catch (error) { note(`error ${error?.stack ?? error}`); }
  finally {
    const leftovers = await sandbox.close();
    if (leftovers.length) note(`leftovers ${JSON.stringify(leftovers)}`);
    await api.close();
  }
  await writeFile(path.join(dir, 'frames.json'), JSON.stringify({ version, colors, theme, prompt: PROMPT, cols: 120, rows: 40, log, requests: api.requests.map(r => ({ id: r.id, kind: r.kind, script: r.script, step: r.step, blocks: r.blocks })), frames }, null, 1));
  console.log(`${version}: ${frames.length} distinct frames in ${dir}`);
}
