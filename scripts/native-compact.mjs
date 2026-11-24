// Opt-in native test. Usage: node --import tsx scripts/native-compact.mjs MODEL
// Uses a new session in an empty test directory and a dedicated tmux server.
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Backend } from '../src/backend/index.ts';
import { Controller } from '../src/main/controller.ts';
import { WorkspaceStore } from '../src/main/store.ts';

const model = process.argv[2];
assert.ok(model, 'Pass a model already available in the native CLI');
const exec = promisify(execFile);
const out = path.resolve('test-results', 'native-compact-' + Date.now());
const cwd = path.join(out, 'workspace');
await mkdir(cwd, { recursive: true });
const socket = 'lectern-compact-' + randomUUID();
const privateServer = createPrivateTmux(await mkdtemp('/tmp/lt-compact-'), { name: socket });
Object.assign(process.env, privateServer.env);
delete process.env.TMUX; delete process.env.TMUX_PANE;
const store = new WorkspaceStore(out);
const workspace = { id: 'compact-test', kind: 'local', name: '原生压缩验证', cwd: await realpath(cwd) };
const backend = new Backend({ tmuxSocket: socket, claudeArgs: ['--model', model, '--tools', ''] });
const controller = new Controller(store, backend);
const report = { version: (await exec('claude', ['--version'])).stdout.trim(), model, success: false };
async function until(label, condition, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await condition(controller.currentSnapshot);
    if (result) return result;
    await delay(300);
  }
  throw new Error('Timed out waiting for ' + label);
}
const messages = snapshot => snapshot.messages.map(({ id, role, text }) => ({ id, role, text }));
const isReady = snapshot => snapshot?.status === 'idle' && snapshot.nativeInputReady;
const completed = (snapshot, count) => isReady(snapshot) && snapshot.messages.filter(message =>
  message.role === 'assistant' && message.source === 'jsonl' && message.status === 'complete' && message.text.trim()).length === count;
try {
  await store.save(workspace);
  const { id } = await controller.createSession(workspace.id);
  const send = text => controller.sendMessage(workspace.id, id, text);
  await controller.watchSession(workspace.id, id);
  await until('native composer', async snapshot => {
    const trust = snapshot?.directoryTrust;
    if (trust) {
      assert.equal(await realpath(trust.cwd), workspace.cwd);
      await controller.respondDirectoryTrust(workspace.id, id, trust.token, 'trust');
    }
    return isReady(snapshot);
  });
  await send('请帮我记住周末野餐的集合地点是蓝桥。仅回复一句确认，无需工具。');
  await until('first native reply', snapshot => completed(snapshot, 1));
  const before = messages(controller.currentSnapshot);
  const history = (await controller.discover(workspace.id)).sessions.find(session => session.id === id);
  assert.ok(history?.path, 'Expected native JSONL for this test session');
  const compact = '/compact 保留周末野餐的集合地点';
  await send(compact);
  assert.ok(!controller.currentSnapshot.messages.some(message => message.source === 'pending' && message.text === compact));
  const boundary = await until('native compact boundary', async () => {
    const raw = await readFile(history.path, 'utf8');
    const records = raw.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    return records.find(row => row.type === 'system' && row.subtype === 'compact_boundary' && row.sessionId === id);
  });
  report.trigger = boundary.compactMetadata?.trigger;
  assert.equal(report.trigger, 'manual');
  await until('ready after compaction', isReady);
  assert.deepEqual(messages(controller.currentSnapshot), before);
  await send('刚才约定的集合地点叫什么？请只说地点。');
  await until('post-compact reply', snapshot => completed(snapshot, 2));
  assert.match(controller.currentSnapshot.messages.at(-1).text, /蓝桥/);
  assert.deepEqual(messages(controller.currentSnapshot).slice(0, 2), before);
  report.before = before.length;
  report.after = controller.currentSnapshot.messages.length;
  const last = controller.currentSnapshot;
  await controller.closeSession(workspace.id, id, last.paneId, last.panePid);
  let reopened = await controller.watchSession(workspace.id, id);
  report.reopenedFirstPage = reopened.messages.length;
  report.olderPages = 0;
  while (reopened.historyPage?.hasOlder) {
    reopened = await controller.loadEarlierMessages(workspace.id, id, reopened.historyPage.cursor);
    report.olderPages++;
  }
  assert.deepEqual(messages(reopened).map(({ role, text }) => ({ role, text })),
    messages(last).map(({ role, text }) => ({ role, text })));
  report.reopened = reopened.messages.length;
  report.success = true;
} catch (error) {
  report.error = error.message;
  report.lastStatus = controller.currentSnapshot?.status;
  process.exitCode = 1;
} finally {
  await controller.dispose();
  privateServer.cleanup();
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out, ...report }));
}
