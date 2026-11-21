// The app starts Claude Code in auto mode, which sends some tool calls (background
// tasks, subagents, pipelines, loops) to the model as a safety check before running
// them, usually as a non-streaming request. Loopback fake models in the e2e scripts
// answer it with this: every action is harmless. Without an answer Claude Code
// blocks the action ("auto mode cannot determine the safety of …").

/** True for auto mode's safety check (its system prompt). */
export function isAutoModeCheck(body) {
  const system = typeof body?.system === 'string' ? body.system : (body?.system ?? []).map(part => part?.text ?? '').join('\n');
  return /security monitor for autonomous AI coding agents/i.test(system);
}

/** Answer the check: the first stage wants only <severity>N</severity>, the second thinks first. */
export function answerAutoModeCheck(res, body) {
  const text = (body.max_tokens ?? 0) <= 256 ? '<severity>0</severity>' : '<thinking>A routine action for this test.</thinking>\n<severity>0</severity>';
  const message = { id: 'msg_auto_mode_check', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
  if (!body.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
  const send = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
  send('message_stop');
  res.end();
}
