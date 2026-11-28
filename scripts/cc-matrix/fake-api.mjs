// A loopback stand-in for the Anthropic API, for running the real Claude Code CLI
// without any model. No dependencies. Responses are scripted and deterministic:
//
// - A main-agent request (one that offers the Bash tool) is answered by the script
//   named in the newest user message that carries a `ccm:<name>` marker. The step
//   is the number of assistant messages after that user message, so a multi-turn
//   tool loop (and any retry of the same request) gets the same answer at the same
//   point. A script returns one response: { blocks, delayMs, chunk, gate, ... }.
// - Side requests (session titles, topic checks, the compaction summary, quota
//   probes) get short canned answers; the compaction request is recognised by its
//   summary instructions, auto mode's safety check by its system prompt (it passes
//   everything but actions marked ccm-blocked; the '@classifier' script can answer or
//   fail it instead). A script may also fail its request: { status: 529 } (an error
//   envelope), { reset: true } (connection dropped), { hangMs } (no answer until the
//   client gives up) or { refuseMs } (the server stops listening for that long).
// - A background subagent's progress label (Claude Code asks about every 30 s while its transcript moves
//   on) is its own kind, 'progress', checked before 'main' and 'agent': the fork of the subagent's
//   conversation offers its tools, and a script answering it would end or hold the label request. The
//   '@progress' script answers with the subagent's script name; without one, a fixed label.
// - The /goal evaluator (a Stop prompt hook: no tools, the system prompt "You are evaluating a
//   stop-condition hook in Claude Code", a last user message with `Condition: <condition>`) is
//   its own kind, 'goal', recognised by all three together right after the safety check: it
//   would otherwise be a side request, and no side request has that system prompt (nor does a
//   compaction or a main-loop request), so the other kinds keep what they had. A `ccm-goal:<plan>`
//   marker in the condition answers it: one of no, yes, impossible, bad per evaluation of that
//   condition, the last repeating (`ccm-goal:no-yes`: not met, then met; `bad` is not JSON, a
//   failed check); without one, "insufficient evidence" as the real evaluator says. The '@goal'
//   script can answer instead. The turn the hook continues ("Stop hook feedback:\n[<condition>]:
//   <reason>") carries the condition and its `ccm:` marker: the main script runs again from step
//   0 and gets `feedback` (that reason) and `feedbacks` (the hook's feedback for it so far).
// - Server-side checks are never run: an endpoint other than *.anthropic.com is a
//   gateway to Claude Code, and this one does not pass auto mode's server check through.
//   `refuseBeta(pattern)` also makes it refuse requests that carry a matching beta
//   (HTTP 400, the API's wording for an unknown beta), like a gateway in front of a
//   deployment that does not know it: Claude Code 2.1.330 sends the request again
//   without auto mode's dangerous-tool-use beta.
// - count_tokens, model listing and anything else the CLI asks for at startup are
//   answered sanely and logged; unknown endpoints are recorded in `unknown`.
// - The server is also the CLI's HTTP(S) proxy (HTTPS_PROXY): any attempt to reach
//   a real host, api.anthropic.com included, is refused and recorded in `external`,
//   which the harness treats as a failure.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const MARKER = /\bccm:([a-z0-9][a-z0-9-]*)/g;
const MODELS = [
  ['claude-opus-4-1-20250805', 'Claude Opus 4.1'], ['claude-opus-4-20250514', 'Claude Opus 4'], ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
  ['claude-sonnet-4-20250514', 'Claude Sonnet 4'], ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'], ['claude-3-5-haiku-20241022', 'Claude Haiku 3.5'],
];

export const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => part?.type === 'text' ? part.text : part?.type === 'tool_result' ? textOf(part.content) : '').join('\n') : '';

/** Signatures Claude Code reads to decide how to show a thinking block: a base64
 * protobuf whose field 2 → 1 → 8 names the purpose ("narration" is shown as text). */
export function thinkingSignature(purpose) {
  const bytes = (number, payload) => Buffer.concat([Buffer.from([(number << 3) | 2, payload.length]), payload]);
  const inner = purpose ? bytes(8, Buffer.from(purpose)) : Buffer.from([0x08, 0x01]);
  return bytes(2, bytes(1, inner)).toString('base64');
}

const systemOf = body => typeof body.system === 'string' ? body.system : (body.system ?? []).map(part => part.text ?? '').join('\n');

function kindOf(body) {
  const tools = (body.tools ?? []).map(tool => tool.name);
  const last = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
  const lastText = textOf(last?.content);
  // Auto mode's safety check ("You are a security monitor for autonomous AI coding agents").
  if (/security monitor for autonomous AI coding agents/i.test(systemOf(body))) return 'classifier';
  // The /goal evaluator: a prompt Stop hook asked whether the user's condition holds (all three signs).
  if (!tools.length && /You are evaluating a stop-condition hook in Claude Code/.test(systemOf(body)) && /^Condition: /m.test(lastText)) return 'goal';
  // The compaction prompt (not a task notification, whose XML also has a <summary> tag).
  if (!/<task-notification>/.test(lastText) && /create a detailed summary of the conversation|summary of the conversation so far|an <analysis> block followed by a <summary> block/i.test(lastText)) return 'compact';
  // A background subagent's 3-5 word progress label (every 30 s): a fork of its conversation
  // (its tools, then this prompt) or a request of its own with the label writer's system prompt.
  if (/progress label for a background agent/.test(systemOf(body)) || /Describe (?:your|the agent's) most recent action in 3-5 words/.test(lastText)) return 'progress';
  // This fork inherits the main loop's tools and appends its own user prompt.
  if (lastText.startsWith('[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]')) return 'suggestion';
  // Subagents cannot start subagents: only the main loop is offered Agent (Task before).
  if (tools.includes('Agent') || tools.includes('Task')) return 'main';
  if (tools.length) return 'agent';
  if (body.max_tokens === 1) return 'quota';
  return 'side';
}

/** The newest user message with a marker; its script and the step within it. */
function locate(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const markers = [...textOf(messages[i].content).matchAll(MARKER)].map(match => match[1]);
    if (!markers.length) continue;
    return { name: markers.at(-1), index: i, step: messages.slice(i + 1).filter(message => message.role === 'assistant').length };
  }
}

const textBlocks = content => typeof content === 'string' ? [content]
  : Array.isArray(content) ? content.flatMap(part => part?.type === 'text' ? [part.text] : part?.type === 'tool_result' ? [textOf(part.content)] : []) : [];
const FEEDBACK = /Stop hook feedback:\n\[([^\n]*?)\]: ([^\n<]*)/g;

/** The /goal Stop hook's feedback to script `name` (its condition carries the marker): how many
 * times so far, and its reason when the newest text with the marker is one (the hook continued the
 * turn). The API merges consecutive user messages, so the newest message may also hold older text. */
function stopFeedback(messages, found) {
  const mine = text => [...text.matchAll(FEEDBACK)].filter(match => match[1].includes(`ccm:${found.name}`));
  const feedbacks = messages.filter(message => message.role === 'user').flatMap(message => textBlocks(message.content)).reduce((sum, text) => sum + mine(text).length, 0);
  const newest = textBlocks(messages[found.index].content).filter(text => text.includes(`ccm:${found.name}`)).at(-1) ?? '';
  return { feedbacks, feedback: mine(newest).at(-1)?.[2].trim() };
}

const GOAL_PLAN = /\bccm-goal:([a-z]+(?:-[a-z]+)*)/;
const GOAL_ANSWERS = {
  no: { ok: false, reason: 'the transcript does not show the last step yet' },
  yes: { ok: true, reason: 'the transcript shows every step done' },
  impossible: { ok: false, impossible: true, reason: 'the condition contradicts itself' },
};
/** The evaluator's answer to the `count`th check of `condition`: from its `ccm-goal:` plan, or
 * what the real evaluator says when the transcript proves nothing. `bad` is not JSON. */
export function goalAnswer(condition, count) {
  const plan = GOAL_PLAN.exec(condition)?.[1].split('-');
  const word = plan ? plan[Math.min(count, plan.length) - 1] : undefined;
  if (word === 'bad') return 'The matrix answers this goal check without JSON.';
  return JSON.stringify(GOAL_ANSWERS[word] ?? { ok: false, reason: 'insufficient evidence in transcript' });
}

export async function startFakeApi({ logFile, defaultText = 'OK.' } = {}) {
  // goalChecks: how many times the /goal evaluator was asked about each condition.
  const scripts = new Map(), gates = new Map(), goalChecks = new Map();
  const requests = [], unknown = [], external = [];
  const sockets = new Set();
  let sequence = 0, refusedBeta;
  const log = entry => { if (logFile) try { appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch {} };
  const gate = name => {
    if (!gates.has(name)) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(name, { promise, release, waiting: 0 }); }
    return gates.get(name);
  };

  // Close the listener and every open connection, then listen on the same port again:
  // meanwhile a new connection is refused (ECONNREFUSED), as with a server that is down.
  let refusing, closed = false;
  const refuseConnections = ms => refusing ??= (async () => {
    const { port } = server.address();
    await new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); });
    await new Promise(resolve => setTimeout(resolve, ms));
    if (!closed) await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
    refusing = undefined;
  })();

  async function respond(req, res, body) {
    const kind = kindOf(body);
    const messages = body.messages ?? [];
    const found = kind === 'main' || kind === 'agent' ? locate(messages) : undefined;
    const script = found && scripts.get(found.name);
    const entry = { id: ++sequence, kind, model: body.model, stream: !!body.stream, script: found?.name, step: found?.step, tools: (body.tools ?? []).map(tool => tool.name), maxTokens: body.max_tokens, thinking: body.thinking?.type, effort: body.output_config?.effort, beta: req.headers['anthropic-beta'],
      images: imagesSinceReply(messages), cacheTtl: cacheTtls(body), at: Date.now() };
    requests.push(entry);
    // CC_MATRIX_DUMP=<dir> keeps every request body, for writing new scenarios.
    if (process.env.CC_MATRIX_DUMP) try { appendFileSync(`${process.env.CC_MATRIX_DUMP}/request-${String(entry.id).padStart(4, '0')}-${kind}.json`, JSON.stringify(body, null, 1)); } catch {}
    log({ request: entry, system: systemOf(body).slice(0, 600), toolNames: (body.tools ?? []).map(tool => tool.name), lastUser: textOf([...messages].reverse().find(message => message.role === 'user')?.content).slice(-600) });
    const refused = refusedBeta && String(entry.beta ?? '').split(',').map(beta => beta.trim()).find(beta => refusedBeta.test(beta));
    if (refused) {
      entry.failed = 400;
      entry.refusedBeta = refused;
      return json(res, { type: 'error', error: { type: 'invalid_request_error', message: `Unexpected value(s) \`${refused}\` for the \`anthropic-beta\` header. Please consult our documentation at docs.anthropic.com or try again without the header.` } }, 400);
    }
    let plan;
    if (script) plan = await script({ step: found.step, body, messages, kind, last: messages.at(-1), toolResults: toolResults(messages), ...stopFeedback(messages, found) });
    // The /goal evaluator: the condition's `ccm-goal:` plan, or the '@goal' script (see goalAnswer).
    else if (kind === 'goal') {
      const condition = /^Condition: ([\s\S]*?)(?:\n\nARGUMENTS:|$)/m.exec(textOf(messages.at(-1)?.content))?.[1].trim() ?? '';
      const count = goalChecks.set(condition, (goalChecks.get(condition) ?? 0) + 1).get(condition);
      Object.assign(entry, { condition, check: count });
      const answer = () => goalAnswer(condition, count);
      plan = scripts.has('@goal') ? await scripts.get('@goal')({ condition, count, answer, body, messages, kind }) : { text: answer() };
    }
    // A test can hold or replace the compaction answer with the '@compact' script.
    else if (kind === 'compact' && scripts.has('@compact')) plan = await scripts.get('@compact')({ body, messages, kind });
    else if (kind === 'compact') plan = { blocks: [{ type: 'text', text: '<summary>\n1. Primary Request and Intent: the compatibility matrix exercised compaction.\n2. Pending Tasks: none.\n</summary>' }] };
    // A test can fail the safety check with the '@classifier' script (see failure plans below).
    else if (kind === 'classifier' && scripts.has('@classifier')) plan = await scripts.get('@classifier')({ body, messages, kind, action: gradedAction(messages), answer: () => classifierAnswer(body, messages) });
    else if (kind === 'classifier') plan = { blocks: [{ type: 'text', text: classifierAnswer(body, messages) }] };
    // '@progress' gets the subagent's script name (the marker in its prompt or notes); else a fixed label.
    else if (kind === 'progress') plan = scripts.has('@progress') ? await scripts.get('@progress')({ body, messages, name: locate(messages)?.name }) : { text: 'Checking the work' };
    else if (kind === 'suggestion') plan = scripts.has('@suggestion') ? await scripts.get('@suggestion')({ body, messages }) : { blocks: [{ type: 'text', text: '' }] };
    else if (kind === 'side') plan = { blocks: [{ type: 'text', text: sideAnswer(body) }] };
    else plan = { blocks: [{ type: 'text', text: defaultText }] };
    if (!plan.blocks) plan = { blocks: plan.text ? [{ type: 'text', text: plan.text }] : [{ type: 'text', text: defaultText }], ...plan };
    entry.blocks = plan.blocks.map(block => block.type === 'tool_use' ? `tool_use:${block.name}` : block.type);
    if (plan.gate) {
      const held = gate(plan.gate);
      held.waiting++;
      entry.gated = plan.gate;
      await Promise.race([held.promise, new Promise(resolve => setTimeout(resolve, plan.gateTimeoutMs ?? 120_000))]);
    }
    // Failure plans: drop the connection, never answer (until the client gives up),
    // or stop listening for a while so that new connections are refused.
    if (plan.reset) { entry.failed = 'reset'; req.socket.destroy(); return; }
    if (plan.hangMs) {
      entry.failed = 'hang';
      await new Promise(resolve => { const timer = setTimeout(resolve, plan.hangMs); res.on('close', () => { clearTimeout(timer); resolve(); }); });
      entry.aborted = res.destroyed || res.writableEnded ? true : undefined;
      if (!res.destroyed) req.socket.destroy();
      return;
    }
    if (plan.refuseMs) { entry.failed = 'refused'; req.socket.destroy(); await refuseConnections(plan.refuseMs); return; }
    if (plan.status && plan.status >= 400) {
      entry.failed = plan.status;
      res.writeHead(plan.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: plan.errorType ?? 'api_error', message: plan.errorMessage ?? 'Scripted failure' } }));
    }
    const headers = { 'request-id': `req_ccm_${entry.id}`, 'anthropic-organization-id': '00000000-0000-4000-8000-000000000000', ...rateLimitHeaders(plan.rateLimits) };
    const id = `msg_ccm_${entry.id}`;
    const stopReason = plan.stopReason ?? (plan.blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn');
    // Like the real API, a follow-up request reads the earlier prefix from the prompt cache
    // (Claude Code shows cache state and asks before a model switch drops a warm cache).
    const cached = messages.length > 1 ? 2400 : 0;
    const usage = { input_tokens: plan.inputTokens ?? 1200, output_tokens: 0, cache_creation_input_tokens: plan.cacheWrite ?? 600, cache_read_input_tokens: plan.cacheRead ?? cached };
    const blocks = plan.blocks.map((block, index) => block.type === 'tool_use' ? { id: `toolu_ccm_${entry.id}_${index}`, ...block } : block);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage: { ...usage, output_tokens: 12 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
    let closed = false;
    res.on('close', () => { closed = true; });
    const send = (type, fields = {}) => { if (!closed) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`); };
    const pause = ms => ms > 0 && !closed ? new Promise(resolve => setTimeout(resolve, ms)) : undefined;
    send('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    for (const [index, block] of blocks.entries()) {
      if (closed) break;
      if (block.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (const piece of pieces(block.text, plan.chunk)) { await pause(plan.delayMs); send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } }); }
      } else if (block.type === 'thinking') {
        send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        for (const piece of pieces(block.thinking, plan.chunk)) { await pause(plan.delayMs); send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: piece } }); }
        send('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature ?? thinkingSignature() } });
      } else if (block.type === 'tool_use') {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        await pause(plan.delayMs);
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
      }
      send('content_block_stop', { index });
    }
    await pause(plan.tailMs);
    if (plan.streamError) {
      entry.failed = 'stream';
      if (plan.streamError === 'reset') return req.socket.destroy();
      send('error', { error: { type: 'api_error', message: plan.streamError } });
      if (!closed) res.end();
      return;
    }
    send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: plan.outputTokens ?? 24 } });
    send('message_stop');
    if (!closed) res.end();
    entry.done = Date.now();
    if (closed) entry.aborted = true;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // A request line with an absolute URL is a proxied plain-HTTP request to another host.
    if (/^https?:\/\//.test(req.url) && url.host !== `127.0.0.1:${server.address().port}`) {
      external.push({ method: req.method, host: url.host, path: url.pathname, at: Date.now() });
      log({ external: `${req.method} ${req.url}` });
      return res.writeHead(403).end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { if (raw) body = JSON.parse(raw); } catch {}
    const path = url.pathname;
    try {
      if (req.method === 'POST' && path === '/v1/messages') return await respond(req, res, body);
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        const size = JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length + JSON.stringify(body.system ?? '').length;
        requests.push({ id: ++sequence, kind: 'count_tokens', at: Date.now() });
        return json(res, { input_tokens: Math.max(1, Math.ceil(size / 4)) });
      }
      if (req.method === 'GET' && path === '/v1/models') {
        requests.push({ id: ++sequence, kind: 'models', at: Date.now() });
        return json(res, { data: MODELS.map(([id, display_name]) => ({ type: 'model', id, display_name, created_at: '2025-01-01T00:00:00Z' })), has_more: false, first_id: MODELS[0][0], last_id: MODELS.at(-1)[0] });
      }
      if (req.method === 'GET' && path.startsWith('/v1/models/')) {
        const id = decodeURIComponent(path.slice('/v1/models/'.length));
        return json(res, { type: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z' });
      }
    } catch (error) {
      log({ error: String(error?.stack ?? error) });
      if (!res.headersSent) return json(res, { type: 'error', error: { type: 'api_error', message: 'fake api failure' } }, 500);
      return res.end();
    }
    unknown.push({ method: req.method, path, at: Date.now() });
    log({ unknown: `${req.method} ${path}`, body: raw.slice(0, 500) });
    // Answer politely: an empty object for reads, a 404 error envelope otherwise.
    if (req.method === 'GET') return json(res, {});
    return json(res, { type: 'error', error: { type: 'not_found_error', message: `cc-matrix fake API: ${path} is not scripted` } }, 404);
  });
  // HTTPS through the proxy arrives as CONNECT: refuse every real host.
  server.on('connect', (req, socket) => {
    socket.on('error', () => {});
    external.push({ method: 'CONNECT', host: req.url, at: Date.now() });
    log({ external: `CONNECT ${req.url}` });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  // A client that resets its connection (an aborted stream, a refused proxy tunnel) is not a server failure.
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (error, socket) => socket.destroy());
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, requests, unknown, external,
    /** Register a script: (ctx) => response | Promise<response>. */
    script(name, fn) { scripts.set(name, fn); return name; },
    /** Refuse /v1/messages requests carrying a beta that matches (undefined: none). */
    refuseBeta(pattern) { refusedBeta = pattern; },
    release(name) { gate(name).release(); },
    waiting(name) { return gates.get(name)?.waiting ?? 0; },
    reset() { requests.length = 0; },
    async close() {
      closed = true;
      for (const held of gates.values()) held.release();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/** The prompt-cache lifetimes a request asks for: the distinct `ttl` of its `cache_control`
 * markers (system, tools, messages), sorted; a marker without one is the API's default '5m'. */
export function cacheTtls(body) {
  const found = new Set();
  const visit = value => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== 'object') return;
    if (value.cache_control && typeof value.cache_control === 'object') found.add(value.cache_control.ttl ?? '5m');
    for (const [key, item] of Object.entries(value)) if (key !== 'cache_control' && item && typeof item === 'object') visit(item);
  };
  visit([body.system, body.tools, body.messages]);
  return [...found].sort();
}

/** Images sent since the last assistant message (attached files arrive in their own user message). */
function imagesSinceReply(messages) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'assistant'; i--) count += countImages(messages[i].content);
  return count;
}

function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => sum + (part?.type === 'image' ? 1 : part?.type === 'tool_result' ? countImages(part.content) : 0), 0);
}

/** tool_result blocks since the last assistant message (a release may follow them with a reminder message). */
function toolResults(messages) {
  const out = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'assistant'; i--) {
    if (messages[i].role !== 'user' || !Array.isArray(messages[i].content)) continue;
    out.unshift(...messages[i].content.filter(part => part.type === 'tool_result').map(part => ({ id: part.tool_use_id, isError: !!part.is_error, text: textOf(part.content) })));
  }
  return out;
}

function pieces(text, size) {
  if (!size || size <= 0 || text.length <= size) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Auto mode's safety check grades the harm of the agent's latest action: stage one
 * answers <severity>N</severity> only, stage two thinks first. Everything is harmless
 * here, except actions carrying "ccm-blocked", which get an answer the check cannot use:
 * Claude Code then blocks the action, and after three in a row asks the user. */
function classifierAnswer(body, messages) {
  if (/ccm-blocked/.test(gradedAction(messages))) return 'Unable to grade this action.';
  return (body.max_tokens ?? 0) <= 256 ? '<severity>0</severity>' : '<thinking>A routine command inside the working directory.</thinking>\n<severity>0</severity>';
}

/** The action the safety check grades: the last entry of the transcript it was sent. */
function gradedAction(messages) {
  const request = textOf([...messages].reverse().find(message => message.role === 'user')?.content);
  const transcript = /<transcript>([\s\S]*)<\/transcript>/.exec(request)?.[1] ?? request;
  return transcript.trim().split('\n').filter(Boolean).at(-1) ?? '';
}

function sideAnswer(body) {
  const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map(part => part.text ?? '').join('\n');
  const all = system + '\n' + textOf(body.messages?.at(-1)?.content);
  // Title and topic helpers expect JSON in some releases.
  if (/isNewTopic/.test(all)) return '{"isNewTopic": false, "title": null}';
  if (/"title"/.test(all) && /json/i.test(all)) return '{"title": "Compatibility check"}';
  return 'Compatibility check';
}

function rateLimitHeaders(limits) {
  if (!limits) return {};
  const now = Math.floor(Date.now() / 1000);
  return {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': String(limits.five ?? 0.25),
    'anthropic-ratelimit-unified-5h-reset': String(now + (limits.fiveResetIn ?? 2 * 3600)),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': String(limits.week ?? 0.5),
    'anthropic-ratelimit-unified-7d-reset': String(now + (limits.weekResetIn ?? 3 * 86400)),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  };
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
