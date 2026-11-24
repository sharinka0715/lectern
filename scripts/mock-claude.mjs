#!/usr/bin/env node
// A deterministic offline TUI fixture. It uses a real PTY and real append-only JSONL.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const config = arg('--fixture-config');
// --alias-models: native alias labels, so `/model <alias>` and `/effort <level>` apply inline.
const aliasModels = args.includes('--alias-models');
// One model table for the native menu rows and the SDK probe, as in Claude Code.
const efforts = ['low', 'medium', 'high'];
const fixtureTable = aliasModels ? [
  { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 5.5 · Offline fixture model' },
  { value: 'haiku', label: 'Haiku', description: 'Haiku 5.5 · Offline fixture model' },
  // A configured custom model without its own description shows its ID (ANTHROPIC_CUSTOM_MODEL_OPTION).
  { value: 'gateway/custom-x', label: 'Custom X', description: 'Custom model (gateway/custom-x)' },
] : [
  { value: 'fixture-alpha', label: 'Fixture Alpha', description: 'Offline fixture model' },
  { value: 'fixture-beta', label: 'Fixture Beta', description: 'Offline fixture model' },
];
if (args.includes('-p') || args.includes('--print')) {
  // `claude -p --input-format stream-json …`: Lectern reads the model and effort
  // lists from initialize and get_settings, sends no prompt and closes stdin.
  if (!config) throw new Error('The fixture requires an isolated config');
  const behavior = (() => { try { return JSON.parse(readFileSync(path.join(config, 'probe-behavior.json'), 'utf8')); } catch { return {}; } })();
  mkdirSync(config, { recursive: true });
  appendFileSync(path.join(config, 'probe-calls.jsonl'), JSON.stringify({ args, cwd: process.cwd(), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + '\n');
  if (behavior.fail) { process.stderr.write(behavior.fail + '\n'); process.exit(1); }
  const reply = (requestId, response) => process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
  const models = behavior.models ?? fixtureTable.map(row => ({ value: row.value, resolvedModel: row.value, displayName: row.label, description: row.description,
    supportsEffort: true, supportedEffortLevels: efforts }));
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let request; try { request = JSON.parse(line); } catch { continue; }
      if (request.type !== 'control_request') continue;
      const kind = request.request?.subtype;
      if (kind === 'initialize') reply(request.request_id, { models, account: { subscriptionType: 'Fixture', apiProvider: 'firstParty' }, claude_code_version: '0.0.0-fixture' });
      else if (kind === 'get_settings' && !behavior.noSettings) reply(request.request_id, { applied: { model: models[0]?.value, effort: 'medium', ultracodeAvailable: false }, effective: {} });
      else process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: `Unsupported control request: ${kind}` } }) + '\n');
    }
  });
  process.stdin.on('end', () => setTimeout(() => process.exit(0), behavior.delayMs ?? 0));
} else {
const id = args.includes('--resume') ? arg('--resume') : arg('--session-id');
if (!id || !config) throw new Error('The fixture requires an isolated config and session ID');
// Launch options are recorded so tests can see what Lectern started.
mkdirSync(config, { recursive: true });
appendFileSync(path.join(config, 'launches.jsonl'), JSON.stringify({ args, id }) + '\n');
const cwd = process.cwd();
// Where it works now: a prompt with `mock-cd:<dir>` runs `cd <dir>` first. Like Claude Code, later
// records carry the new directory and @-mentions are read from it; the file stays in the launch's project.
let current = cwd;
const project = path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
mkdirSync(project, { recursive: true });
const file = path.join(project, `${id}.jsonl`);
const record = (type, content, extra = {}) => ({
  type, uuid: randomUUID(), sessionId: id, cwd: current, timestamp: new Date().toISOString(),
  message: { role: type, content, ...extra },
});
// The newest record with a UUID: the parent of rows written with explicit links (permission prompts below).
let lastUuid;
const append = object => { appendFileSync(file, JSON.stringify(object) + '\n'); if (object.uuid) lastUuid = object.uuid; };
function renameSession(customTitle) {
  const metadata = { type: 'custom-title', customTitle, sessionId: id };
  append(metadata);
  const directory = path.join(project, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'custom-title.json'), JSON.stringify(metadata));
}
if (args.includes('--name')) renameSession(arg('--name'));
let history = [];
if (existsSync(file)) {
  history = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const r = JSON.parse(line);
      if (r.uuid) lastUuid = r.uuid;
      if (!['user', 'assistant'].includes(r.type)) return [];
      const content = r.message.content;
      return [{ role: r.type, text: typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('\n\n') }];
    } catch { return []; }
  });
}
let input = '', pasted = false, busy = false, preview = '', generation = 0;
let nativeMenu, selectedModel = 0, selectedEffort = 1, focus = 0;
const fixtureModels = fixtureTable.map(row => row.label);
const customModel = { label: 'Custom X', id: 'gateway/custom-x' };
const inlineName = label => fixtureTable.find(row => row.label === label).value;
const fixtureEfforts = efforts;
const modelDescription = label => fixtureTable.find(row => row.label === label).description;
// `claude --model <value> --effort <level>`: the session starts with them, saved nowhere.
if (args.includes('--model')) {
  const index = fixtureTable.findIndex(row => row.value === arg('--model'));
  if (index < 0) { process.stderr.write(`Unknown model: ${arg('--model')}\n`); process.exit(1); }
  selectedModel = index;
}
if (args.includes('--effort')) {
  const index = fixtureEfforts.indexOf(arg('--effort'));
  if (index < 0) { process.stderr.write(`error: option '--effort <level>' argument '${arg('--effort')}' is invalid\n`); process.exit(1); }
  selectedEffort = index;
}
// "<state> agents" also lists background work below the footer, as Claude Code 2.1.329+ does.
// "<state> agents:N" lists N subagents as 2.1.330 does: "● main", at most five of them with
// timers that tick, "↓ N more", and "↓ to manage" in the idle footer. "agents:N@ms" ticks
// every `ms` (default 250; Claude Code itself every second).
let fixtureState = 'ready', fixtureAgents = false, tickMs = 250;
const agentsSince = Date.now();
const agentRows = () => {
  if (fixtureAgents === true) return ['', '  ⏺ main', '  ◯ general-purpose  检查归档中的版本信息          3m 8s · ↓ 141.6k tokens'];
  const tick = Math.floor((Date.now() - agentsSince) / tickMs);
  return ['', '  ● main', ...Array.from({ length: Math.min(fixtureAgents, 5) }, (_, i) => `  ◯ general-purpose  第 ${i + 1} 个子代理`.padEnd(60) + `${tick + i}s`),
    ...(fixtureAgents > 5 ? [`  ↓ ${fixtureAgents - 5} more`] : [])];
};
const stateFile = path.join(config, 'screen-state');
const draw = () => {
  const lines = ['╭─ Claude Code · offline fixture ─╮', '  Local simulation · no model requests', ''];
  // The last four messages, with the goal's own rows among them (notes).
  let from = history.length;
  for (let shown = 0; from > 0 && shown < 4;) if (history[--from].role !== 'note') shown++;
  for (const message of history.slice(from)) lines.push(message.role === 'note' ? message.text : `${message.role === 'user' ? '❯' : '⏺'} ${message.text}`, '');
  if (preview) lines.push(`⏺ ${preview}`, '');
  if (busy && !permission) lines.push(evaluating ? '✻ Thinking… (running Stop hook · 1s · esc to interrupt)' : '✻ Thinking… (esc to interrupt)', '');
  if (fixtureState === 'compacting') lines.push('✻ Compacting conversation… (20m 27s · ↓ 842 tokens)', '');
  else if (fixtureState === 'progress') lines.push('✻ Whirring… (8s · ↓ 15 tokens)', '');
  if (nativeMenu === 'model') {
    lines.push('Select model', 'Switch between Claude models.', '',
      ...fixtureModels.map((label, index) => `${index === focus ? '❯' : ' '} ${index + 1}. ${label}${index === selectedModel ? ' ✔' : ''}    ${modelDescription(label)}`),
      '', 'Enter to set as default · s to use this session only · Esc to cancel');
  } else if (nativeMenu === 'effort') {
    const labels = fixtureEfforts.map(label => label.padEnd(12)).join('');
    const pointer = focus * 12 + Math.floor((fixtureEfforts[focus].length - 1) / 2);
    const track = '─'.repeat(labels.length - 1);
    lines.push('Effort', 'Faster                Smarter', track.slice(0, pointer) + '▲' + track.slice(pointer + 1),
      labels, '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel');
  } else if (permission) {
    const rule = '╌'.repeat(64), options = ['Yes', "Yes, and don't ask again for echo commands in this project", 'No'];
    lines.push(`${permission.blink ? ' ' : '⏺'} Write a marker file`, `  ⎿  $ ${command}`, '', '─'.repeat(64), ' Bash command', ' Write a marker file', rule, ` ${command}`, rule,
      ' Do you want to proceed?', ...options.map((label, i) => ` ${i === permission.focus ? '❯' : ' '} ${i + 1}. ${label}`), '', ' Esc to cancel · Tab to amend');
  } else if (fixtureState === 'waiting') {
    lines.push('Permission required', 'Do you want to allow this action?', '❯ 1. Yes', '  2. No', 'Enter to confirm · Esc to cancel');
  } else {
    if (fixtureState === 'error') lines.push('────────────────────────────────────────────────────────────────', 'API Error: 503 Service unavailable');
    if (input === '/model' || input === '/effort') {
      lines.push(`❯ ${input}       Set the session ${input.slice(1)}`);
    }
    // The goal indicator (or a busy clear's notice) right-aligned on the row on top of the input box.
    goalIndicatorShown = goalIndicator();
    if (goalIndicatorShown) lines.push(goalIndicatorShown.padStart(64));
    lines.push('────────────────────────────────────────────────────────────────', `❯ ${input}`, '────────────────────────────────────────────────────────────────',
      ['progress', 'compacting'].includes(fixtureState) ? '  ⏸ manual mode on · esc to interrupt' : '  ⏸ manual mode on · ? for shortcuts'
        + (typeof fixtureAgents === 'number' && !input ? ' · ↓ to manage' : ''));
    if (fixtureAgents) lines.push(...agentRows());
  }
  // Ticking task rows (agents:N) and the blinking call above a permission dialog redraw in place,
  // as a TUI updates them: rows that do not change stay on screen throughout, and the frame ends up
  // as the cleared one would (erased after each row and around a bare line feed). Clearing first
  // let a read on a slow macOS runner, where the pty hands a frame over in pieces, catch the redraw
  // half done and refuse a key over rows that never changed.
  if (typeof fixtureAgents === 'number' || permission || goal || goalCleared) process.stdout.write('\x1b[H' + lines.map(line => line.replace(/\n/g, '\x1b[K\n\x1b[1K') + '\x1b[K').join('\r\n') + '\x1b[J');
  else process.stdout.write('\x1b[2J\x1b[H' + lines.join('\r\n'));
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Claude Code's own session record (<config>/sessions/<pid>.json), where Lectern reads the native
// status: written from the first permission prompt on and kept current until the process exits.
let presence;
const presenceFile = path.join(config, 'sessions', `${process.pid}.json`);
function setPresence(status, waitingFor) {
  if (!presence) {
    const procStart = process.platform === 'linux' ? readFileSync('/proc/self/stat', 'utf8').replace(/^.*\) /s, '').split(' ')[19]
      : execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim();
    const tmux = execFileSync('tmux', ['display-message', '-p', '-t', process.env.TMUX_PANE, '#{session_name}:#{window_id}.#{pane_id}']).toString().trim();
    presence = { pid: process.pid, sessionId: id, cwd, procStart, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli', tmux };
    mkdirSync(path.dirname(presenceFile), { recursive: true });
    process.on('exit', () => rmSync(presenceFile, { force: true }));
  }
  writeFileSync(presenceFile + '.tmp', JSON.stringify({ ...presence, status, ...(waitingFor && { waitingFor }) }));
  renameSync(presenceFile + '.tmp', presenceFile);
}
// A prompt with `permission-late[:ms]` asks to run a Bash command in Claude Code 2.1.328's dialog and
// writes the call to the transcript only after `ms` (default 4000) or once answered; `permission-first`
// writes it at once but ahead of the prompt and its attachments, as Claude Code 2.1.300 and 2.1.310 can
// for a new session's first response. Up/Down/Enter, 1–3 and Esc answer as in Claude Code.
// Claude Code blinks the waiting call's bullet above its dialog (⏺ and a blank, about every 0.6 s):
// LECTERN_MOCK_BLINK_MS sets the period (0: steady). A key guard must not depend on that row.
let permission;
const command = 'echo allowed > allowed.txt', blinkMs = Number(process.env.LECTERN_MOCK_BLINK_MS ?? 600);
const linked = (type, content, parentUuid, extra = {}) => ({ ...record(type, content, extra), parentUuid: parentUuid ?? null });
function askPermission(text, mode, ms) {
  busy = true;
  history.push({ role: 'user', text });
  const call = linked('assistant', [{ type: 'tool_use', id: 'toolu_mock_' + randomUUID().slice(0, 8), name: 'Bash', input: { command, description: 'Write a marker file' } }],
    undefined, { id: randomUUID(), stop_reason: 'tool_use', model: fixtureModels[selectedModel] });
  permission = { focus: 0, call, written: false, blink: false };
  if (blinkMs > 0) permission.blinker = setInterval(() => { if (permission) { permission.blink = !permission.blink; draw(); } }, blinkMs);
  const prompt = linked('user', [{ type: 'text', text }], lastUuid);
  const date = { type: 'attachment', uuid: randomUUID(), parentUuid: prompt.uuid, sessionId: id, cwd: current, attachment: { type: 'date', date: new Date().toISOString().slice(0, 10) } };
  if (mode === 'first') {
    permission.written = true;
    append({ ...call, parentUuid: date.uuid });
    append(prompt); append(date);
  } else {
    append(prompt); append(date);
    call.parentUuid = date.uuid;
    permission.timer = setTimeout(() => { if (permission && !permission.written) { permission.written = true; append(call); } }, ms);
  }
  setPresence('waiting', 'permission prompt');
}
function decide(choice) {
  const { call, written, timer, blinker } = permission;
  permission = undefined;
  clearTimeout(timer); clearInterval(blinker);
  if (!written) append(call);
  const toolId = call.message.content[0].id;
  if (choice === 1 || choice === 2) {
    writeFileSync(path.join(cwd, 'allowed.txt'), 'allowed\n');
    const output = linked('user', [{ type: 'tool_result', tool_use_id: toolId, content: '' }], lastUuid);
    append(output);
    const reply = `已允许并运行：${command}`;
    append(linked('assistant', [{ type: 'text', text: reply }], output.uuid, { id: randomUUID(), stop_reason: 'end_turn', model: fixtureModels[selectedModel] }));
    history.push({ role: 'assistant', text: reply });
  } else {
    append(linked('user', [{ type: 'tool_result', tool_use_id: toolId, is_error: true,
      content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed." }], lastUuid));
    append(linked('user', [{ type: 'text', text: '[Request interrupted by user for tool use]' }], lastUuid));
  }
  busy = false;
  setPresence('idle');
}
// Claude Code's native /goal (2.1.331's records and screen, research in CLAUDE.md "目标"): `/goal <condition>`
// sets it and starts a turn; `/goal clear` (and stop|off|reset|none|cancel) clears it, at once even while
// busy (then only the cleared record, and "Goal cleared: …" on the notice row for 3 s). The condition picks
// what happens: goal-hold (not met, then a reply that goes on until cleared or Esc), goal-impossible,
// goal-retry (the check fails, retrying), goal-pause (unmet twice, then paused), goal-pausetool (Claude
// pauses it: "◎ /goal paused"), goal-checkin (deferred for background work, then a check-in after
// LECTERN_MOCK_GOAL_CHECKIN_MS); otherwise not met once, then met. Each check shows "running Stop hook"
// for LECTERN_MOCK_GOAL_EVAL_MS (default 600). The indicator's timer ticks every LECTERN_MOCK_GOAL_TICK_MS
// (default 1000, as Claude Code), counted as seconds.
let goal, goalCleared, evaluating = false;
const goalTickMs = Number(process.env.LECTERN_MOCK_GOAL_TICK_MS) || 1000;
const goalEvalMs = Number(process.env.LECTERN_MOCK_GOAL_EVAL_MS ?? 600);
const goalClear = /^(?:clear|stop|off|reset|none|cancel)$/i;
const now = () => new Date().toISOString();
const goalStatus = fields => append({ type: 'attachment', uuid: randomUUID(), sessionId: id, cwd: current, timestamp: now(), attachment: { type: 'goal_status', ...fields } });
const systemRecord = (subtype, fields) => append({ type: 'system', subtype, uuid: randomUUID(), sessionId: id, cwd: current, timestamp: now(), isMeta: false, ...fields });
const metaUser = content => append({ ...record('user', content), isMeta: true });
const goalCommandText = args => `<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${args}</command-args>`;
function goalIndicator() {
  if (!goal) return goalCleared && Date.now() < goalCleared.until ? `Goal cleared: ${goalCleared.condition}` : undefined;
  if (goal.paused) return '◎ /goal paused';
  const ticks = Math.floor((Date.now() - goal.setAt) / goalTickMs);
  // An accelerated timer (tests) keeps counting seconds, so the row changes at every tick.
  return '◎ /goal active' + (ticks < 1 ? '' : ticks < 60 || goalTickMs < 1000 ? ` (${ticks}s)` : ` (${Math.floor(ticks / 60)}m)`);
}
let goalIndicatorShown;
setInterval(() => { if (goalIndicator() !== goalIndicatorShown) draw(); }, Math.min(50, Math.max(5, goalTickMs / 3)));
/** Streams `text` as the reply's preview, then writes it: false once Esc or a new turn took over. */
async function speak(text, token) {
  const chars = [...text], pace = Number(process.env.LECTERN_MOCK_STREAM_MS) || 100;
  for (let i = 0; i < chars.length; i += 12) {
    if (token !== generation) return false;
    preview = chars.slice(0, i + 12).join(''); draw(); await pause(pace);
  }
  if (token !== generation) return false;
  append(record('assistant', [{ type: 'text', text }], { id: randomUUID(), stop_reason: 'end_turn', model: fixtureModels[selectedModel] }));
  history.push({ role: 'assistant', text }); preview = ''; draw();
  return true;
}

/** One check of the goal when Claude would stop: "running Stop hook", then its verdict's records. */
async function evaluate(verdict, token) {
  evaluating = true; draw(); await pause(goalEvalMs); evaluating = false;
  if (token !== generation || !goal) return false;
  const { condition } = goal, hook = { hookCount: 1, hookInfos: [{ command: condition, promptText: condition }], hookErrors: [], failedHookErrorIndexes: [],
    hookAdditionalContext: [], preventedContinuation: false, stopReason: '', hasOutput: true, level: 'suggestion', toolUseID: randomUUID() };
  const stats = { iterations: ++goal.checks, durationMs: Date.now() - goal.setAt, tokens: 48 * goal.checks };
  if (verdict === 'not-met') {
    const reason = 'step two is not reported done yet';
    append({ ...record('user', `Stop hook feedback:\n[${condition}]: ${reason}`), isMeta: true, rowSource: 'harness', hookText: true });
    goalStatus({ met: false, condition, reason }); systemRecord('stop_hook_summary', hook);
    history.push({ role: 'note', text: '◯ Goal not yet met… continuing' });
  } else if (verdict === 'met') {
    goalStatus({ met: true, condition, reason: 'the assistant reported both steps done', ...stats }); systemRecord('stop_hook_summary', hook);
    history.push({ role: 'note', text: `✔ Goal achieved (${Math.round(stats.durationMs / 1000)}s · ${stats.iterations} turns · ${stats.tokens} tokens)` });
    goal = undefined;
  } else if (verdict === 'failed') {
    goalStatus({ met: false, failed: true, condition, reason: 'the condition contradicts itself', ...stats }); systemRecord('stop_hook_summary', hook);
    history.push({ role: 'note', text: `✘ Goal couldn't be achieved (0s · ${stats.iterations} turn · ${stats.tokens} tokens)` });
    goal = undefined;
  } else {
    append({ type: 'attachment', uuid: randomUUID(), sessionId: id, cwd: current, timestamp: now(), attachment: { type: 'hook_non_blocking_error', hookName: 'Stop',
      hookEvent: 'Stop', stderr: 'JSON validation failed', stdout: 'I cannot answer in JSON.', exitCode: 1, command: condition, durationMs: 9 } });
    systemRecord('stop_hook_summary', { ...hook, hookErrors: ['JSON validation failed'], failedHookErrorIndexes: [0] });
    notice('Goal still active · the goal check could not complete · retrying in 1 min (1/3) · send a message to retry now');
  }
  draw();
  return true;
}
const notice = content => { systemRecord('informational', { content, level: 'notice' }); history.push({ role: 'note', text: `⏺ ${content}` }); };
const endTurn = () => { systemRecord('turn_duration', { durationMs: 1000, messageCount: history.length }); busy = false; preview = ''; if (presence) setPresence('idle'); draw(); };

/** `/goal …` entered, idle or busy (Claude Code runs it at once). */
function goalCommand(args) {
  if (!args) return; // the status panel: Lectern never types it
  if (goalClear.test(args)) {
    const condition = goal?.condition;
    if (!condition) {
      systemRecord('local_command', { content: goalCommandText(args), level: 'info' });
      systemRecord('local_command', { content: '<local-command-stdout>No goal set</local-command-stdout>', level: 'info', commandRun: { command: 'goal', args } });
      history.push({ role: 'user', text: `/goal ${args}` }, { role: 'note', text: '  ⎿  No goal set' });
      return;
    }
    goalStatus({ met: true, sentinel: true, condition });
    goal = undefined;
    if (busy) goalCleared = { condition, until: Date.now() + 3000 };
    else {
      systemRecord('local_command', { content: goalCommandText(args), level: 'info' });
      systemRecord('local_command', { content: `<local-command-stdout>Goal cleared: ${condition}</local-command-stdout>`, level: 'info', commandRun: { command: 'goal', args } });
      history.push({ role: 'user', text: `/goal ${args}` }, { role: 'note', text: `  ⎿  Goal cleared: ${condition}` });
    }
    return;
  }
  goalStatus({ met: false, sentinel: true, condition: args });
  append(record('user', goalCommandText(args)));
  append({ ...record('user', `<local-command-stdout>Goal set: ${args}</local-command-stdout>`), turnOrigin: 'human' });
  metaUser(`A session-scoped Stop hook is now active with condition: "${args}". Briefly acknowledge the goal, then immediately start (or continue) working toward it.`);
  goal = { condition: args, setAt: Date.now(), checks: 0 };
  goalCleared = undefined;
  history.push({ role: 'user', text: `/goal ${args}` }, { role: 'note', text: `  ⎿  Goal set: ${args}` });
  if (!busy) void goalTurn(args);
}
async function goalTurn(condition) {
  busy = true;
  if (presence) setPresence('busy');
  const token = ++generation, has = marker => condition.includes(marker);
  if (has('goal-checkin')) {
    if (!await speak('Started the background work; waiting for it to finish.', token)) return;
    endTurn();
    await pause(Number(process.env.LECTERN_MOCK_GOAL_CHECKIN_MS) || 1500);
    if (!goal || goal.condition !== condition) return;
    const content = `<task-notification>\n<summary>Goal check-in: background work still running</summary>\n</task-notification>\n<system-reminder>\nGoal check-in: «${condition}» is still active, and evaluation has been deferred for 1 min because background work is still running:\n- bmock0001 · shell · sleep 80\nCheck on their progress (e.g. read their output). If they are progressing, say so briefly and keep waiting.\n</system-reminder>`;
    append({ type: 'queue-operation', operation: 'enqueue', timestamp: now(), sessionId: id, content });
    append({ type: 'queue-operation', operation: 'dequeue', timestamp: now(), sessionId: id });
    append({ ...record('user', content), origin: { kind: 'task-notification' }, promptSource: 'system', queueOrigin: { kind: 'task-notification', source: 'goal-checkin' } });
    history.push({ role: 'note', text: '⏺ Goal check-in: background work still running' });
    busy = true;
    const again = ++generation;
    if (await speak('Background work is still running; waiting for it.', again)) endTurn();
    return;
  }
  if (!await speak('Acknowledged the goal; step one done.', token)) return;
  if (has('goal-pausetool')) { notice('Goal paused · send a message to continue, or run /goal clear'); goal.paused = true; endTurn(); return; }
  if (has('goal-retry')) { if (await evaluate('error', token)) endTurn(); return; }
  if (has('goal-impossible')) { if (await evaluate('failed', token)) endTurn(); return; }
  if (!await evaluate('not-met', token)) return;
  if (has('goal-hold')) {
    preview = 'Still working on step two.'; draw();
    while (token === generation && goal?.condition === condition) await pause(100);
    if (token === generation && await speak('Still working on step two.', token)) endTurn();
    return;
  }
  if (!await speak('Step two done: both steps are now complete.', token)) return;
  if (has('goal-pause')) {
    if (!await evaluate('not-met', token)) return;
    notice('Goal paused · goal checks kept finding it unmet this turn · send a message to continue');
  } else if (!await evaluate('met', token)) return;
  endTurn();
}

async function answer(text) {
  busy = true;
  if (presence) setPresence('busy');
  const token = ++generation;
  history.push({ role: 'user', text });
  append(record('user', [{ type: 'text', text }]));
  // Like Claude Code, every @-mentioned file that exists becomes an attachment row after the prompt.
  for (const match of text.matchAll(/(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g)) {
    const filename = path.resolve(current, match[2] ?? match[3]);
    if (!statSync(filename, { throwIfNoEntry: false })?.isFile()) continue;
    append({ type: 'attachment', uuid: randomUUID(), sessionId: id, cwd: current, timestamp: new Date().toISOString(),
      attachment: { type: 'file', filename, displayPath: path.relative(current, filename) } });
  }
  const move = /(?:^|\s)mock-cd:(\S+)/.exec(text);
  if (move && statSync(path.resolve(current, move[1]), { throwIfNoEntry: false })?.isDirectory()) {
    // The call is written in the old directory, its result in the new one.
    const call = { type: 'tool_use', id: 'toolu_mock_' + randomUUID().slice(0, 8), name: 'Bash', input: { command: `cd ${move[1]}`, description: 'Change directory' } };
    append(record('assistant', [call], { id: randomUUID(), stop_reason: 'tool_use', model: fixtureModels[selectedModel] }));
    current = path.resolve(current, move[1]);
    append(record('user', [{ type: 'tool_result', tool_use_id: call.id, content: '' }]));
  }
  const response = /hello|你好/i.test(text)
    ? '你好！这是运行在真实 tmux 中的离线模拟会话。\n\n回复先从终端画面逐段出现，然后由 JSONL 正文在原气泡内完成对齐。中文与 emoji 🧭 都会完整保留。\n\n你可以关闭窗口再回来，继续这个会话。'
    : `已收到你的消息：${text}\n\n这段回复正通过 tmux 抓屏显示。模型请求、登录状态和会话文件都由目标机器上的 Claude Code 管理。\n\n**落盘后**，正文会在同一个气泡内补全，不会追加第二份回复。\n\n\`\`\`bash\ntmux capture-pane -p -J\n\`\`\``;
  const chars = [...response];
  preview = '';
  // 12 characters per 100 ms; a test that must see each paragraph start sets a slower pace.
  const pace = Number(process.env.LECTERN_MOCK_STREAM_MS) || 100;
  for (let i = 0; i < chars.length; i += 12) {
    if (token !== generation) return;
    preview = chars.slice(0, i + 12).join('');
    draw();
    await pause(pace);
  }
  busy = false;
  draw();
  // Intentionally leave visible completed text ahead of its authoritative transcript.
  await pause(1000);
  if (token !== generation) return;
  const json = JSON.stringify(record('assistant', [{ type: 'text', text: response }], { id: randomUUID(), stop_reason: 'end_turn',
    model: fixtureModels[selectedModel], usage: { input_tokens: 1200 + history.length * 120, cache_read_input_tokens: 2000, cache_creation_input_tokens: 160, output_tokens: chars.length } })) + '\n';
  const bytes = Buffer.from(json);
  const split = Math.floor(bytes.length * 0.61);
  appendFileSync(file, bytes.subarray(0, split));
  await pause(150);
  appendFileSync(file, bytes.subarray(split));
  history.push({ role: 'assistant', text: response });
  preview = '';
  draw();
  // A message continues a paused goal, and the goal is checked when Claude stops.
  if (goal) { goal.paused = false; await evaluate('not-met', token); }
  if (presence) setPresence('idle');
}
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdout.write('\x1b[?2004h');
process.stdin.on('data', chunk => {
  // tmux bracketed paste is delivered as a single write in this fixture.
  for (let i = 0; i < chunk.length;) {
    if (chunk.startsWith('\x1b[200~', i)) { pasted = true; i += 6; continue; }
    if (chunk.startsWith('\x1b[201~', i)) { pasted = false; i += 6; continue; }
    if (permission && !pasted) {
      const arrow = ['\x1b[A', '\x1b[B'].find(key => chunk.startsWith(key, i));
      if (arrow) { permission.focus = Math.max(0, Math.min(2, permission.focus + (arrow.endsWith('A') ? -1 : 1))); i += arrow.length; continue; }
      const key = chunk[i++];
      if (key === '\r' || key === '\n') decide(permission.focus + 1);
      else if (/^[1-3]$/.test(key)) decide(Number(key));
      else if (key === '\x1b') decide('cancel');
      else if (key === '\x03') process.exit(0);
      continue;
    }
    if (nativeMenu && !pasted) {
      const sequence = ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D'].find(key => chunk.startsWith(key, i));
      if (sequence) {
        const backwards = sequence.endsWith('A') || sequence.endsWith('D');
        focus = Math.max(0, Math.min((nativeMenu === 'model' ? fixtureModels : fixtureEfforts).length - 1, focus + (backwards ? -1 : 1)));
        i += sequence.length; continue;
      }
      const key = chunk[i++];
      if (key === '\x1b') nativeMenu = undefined;
      else if (key === 's') {
        if (nativeMenu === 'model') selectedModel = focus; else selectedEffort = focus;
        const receipt = nativeMenu === 'model' ? `Set model to ${fixtureModels[focus]} for this session only`
          : `Set effort level to ${fixtureEfforts[focus]} (this session only): Offline fixture effort`;
        history.push({ role: 'user', text: `/${nativeMenu}\n  ⎿ ${receipt}` });
        nativeMenu = undefined;
      }
      else if (key === '\x03') process.exit(0);
      continue;
    }
    const char = chunk[i++];
    if (char === '\x03') { process.exit(0); }
    if (char === '\x1b') { generation++; busy = false; preview = ''; if (presence) setPresence('idle'); draw(); continue; }
    if ((char === '\r' || char === '\n') && !pasted) {
      const text = input.trim(); input = '';
      const inline = aliasModels && /^\/(model|effort) (\S+)$/.exec(text);
      const goalArgs = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text);
      if (goalArgs) goalCommand((goalArgs[1] ?? '').trim());
      else if (!busy && (text === '/model' || text === '/effort')) {
        nativeMenu = text.slice(1); focus = nativeMenu === 'model' ? selectedModel : selectedEffort;
      } else if (!busy && inline) {
        const list = inline[1] === 'model' ? fixtureModels : fixtureEfforts;
        const index = list.findIndex(label => (inline[1] === 'model' ? inlineName(label) : label.toLowerCase()) === inline[2]);
        let receipt = inline[1] === 'model' ? `Model '${inline[2]}' not found` : `Unknown option: ${inline[2]}`;
        if (index >= 0 && inline[1] === 'model') { selectedModel = index; receipt = `Set model to ${list[index] === customModel.label ? customModel.id : list[index] + ' 5.5'} and saved as your default for new sessions`; }
        if (index >= 0 && inline[1] === 'effort') { selectedEffort = index; receipt = `Set effort level to ${list[index]} (saved as your default for new sessions): Offline fixture effort`; }
        history.push({ role: 'user', text: `${text}\n  ⎿ ${receipt}` });
      } else if (!busy && text.startsWith('/rename ')) {
        const requested = text.slice('/rename '.length);
        const reserved = path.join(config, 'fixture-occupied-name');
        const collision = existsSync(reserved) && readFileSync(reserved, 'utf8') === requested;
        renameSession(collision ? requested + '-2' : requested);
      } else if (text && !busy && /\bpermission-(?:late(?::\d+)?|first)\b/.test(text)) {
        const [, mode, ms] = /\bpermission-(late|first)(?::(\d+))?/.exec(text);
        askPermission(text, mode, Number(ms ?? 4000));
      } else if (text && !busy) void answer(text);
    } else if (!pasted && char === '\x15') input = ''; // Ctrl+U clears this fixture's single-line draft.
    else if (char === '\x7f') input = input.slice(0, -1);
    // Like Claude Code's paste handler, which saves a pasted tab as four spaces.
    else input += pasted && char === '\t' ? '    ' : char;
  }
  if (args.includes('--delayed-setting-redraw') && /^\/(?:model|effort)$/.test(input)) setTimeout(draw, 320);
  else draw();
});
// Test-only external state changes exercise native permission/error observations
// without using the read-only terminal as an input path.
// Read once before the first frame too, so a session started in a prompt never
// shows a ready input box first.
const readFixtureState = () => {
  let next = 'ready';
  try { next = readFileSync(stateFile, 'utf8').trim(); } catch {}
  const [state, agents = ''] = next.split(/\s+/);
  const listed = /^agents:([1-9]\d?)(?:@([1-9]\d{1,3}))?$/.exec(agents);
  tickMs = listed?.[2] ? Number(listed[2]) : 250;
  return [['ready', 'waiting', 'error', 'progress', 'compacting'].includes(state) ? state : 'ready', listed ? Number(listed[1]) : agents === 'agents'];
};
[fixtureState, fixtureAgents] = readFixtureState();
let drawnTick = 0;
setInterval(() => {
  const [next, agents] = readFixtureState();
  const tick = Math.floor((Date.now() - agentsSince) / tickMs);
  if (next !== fixtureState || agents !== fixtureAgents) { [fixtureState, fixtureAgents] = [next, agents]; draw(); }
  else if (typeof fixtureAgents === 'number' && tick !== drawnTick) { drawnTick = tick; draw(); }
}, 25);
draw();
}
