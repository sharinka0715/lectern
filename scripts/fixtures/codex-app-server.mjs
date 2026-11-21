// Offline stdio fixture for the real Codex bridge. The file stands in for the
// CLI's persisted rollout and lets a new Electron process resume a conversation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [store, ...args] = process.argv.slice(2);
assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
const saved = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
const threads = new Map(saved.map(thread => [thread.id, thread]));
const active = new Map();
const approvals = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => send({ method, params });
const scope = state => ({ threadId: state.thread.id, turnId: state.id });

function stream(state, delta) {
  state.reply.text += delta;
  event('item/agentMessage/delta', { ...scope(state), itemId: state.reply.id, delta });
}

function finish(state, status) {
  const { thread, id, items, reply } = state;
  if (reply.text) items.push(reply);
  const turn = { id, status, items };
  thread.turns.push(turn);
  writeFileSync(store, JSON.stringify([...threads.values()]));
  active.delete(thread.id);
  event('turn/completed', { threadId: thread.id, turn });
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result: answer } = JSON.parse(line);
  const reply = result => send({ id, result });
  switch (method) {
    case 'initialize': reply({}); break;
    case 'initialized': break;
    case 'thread/start': {
      const thread = { id: randomUUID(), cwd: params.cwd, turns: [] };
      threads.set(thread.id, thread);
      reply({ thread, cwd: thread.cwd });
      break;
    }
    case 'thread/resume': {
      const thread = threads.get(params.threadId);
      reply({ thread, cwd: thread.cwd });
      break;
    }
    case 'thread/turns/list':
      reply({ data: [...threads.get(params.threadId).turns].reverse(), nextCursor: null });
      break;
    case 'turn/start': {
      const thread = threads.get(params.threadId), turnId = randomUUID();
      const state = {
        thread, id: turnId,
        items: [{ id: 'user-' + turnId, type: 'userMessage', content: params.input }],
        reply: { id: 'reply-' + turnId, type: 'agentMessage', text: '' },
      };
      active.set(thread.id, state);
      const turn = { id: turnId, status: 'inProgress' };
      reply({ turn });
      event('turn/started', { threadId: thread.id, turn });
      switch (params.input[0].text) {
        case 'Codex approval':
          stream(state, '**Partial ');
          stream(state, 'Codex reply**');
          approvals.set(turnId, state);
          send({ id: turnId, method: 'item/commandExecution/requestApproval',
            params: { ...scope(state), itemId: 'command', cwd: thread.cwd, command: 'printf offline-demo' } });
          break;
        case 'Keep Codex running':
          stream(state, 'Codex is still working');
          break;
        case 'Newer Codex chat':
          stream(state, '**Newer Codex reply**');
          finish(state, 'completed');
          break;
        default:
          assert.fail('Unexpected Codex fixture prompt');
      }
      break;
    }
    case 'turn/interrupt': {
      const state = active.get(params.threadId);
      assert.equal(params.turnId, state.id);
      reply({});
      finish(state, 'interrupted');
      break;
    }
    default: {
      const state = approvals.get(id);
      if (!method && state) {
        approvals.delete(id);
        event('serverRequest/resolved', { threadId: state.thread.id, requestId: id });
        stream(state, '\n\nApproval received: ' + answer.decision);
        finish(state, 'completed');
      } else if (id !== undefined) {
        send({ id, error: { code: -32601, message: 'Unexpected Codex fixture request' } });
      }
    }
  }
}
