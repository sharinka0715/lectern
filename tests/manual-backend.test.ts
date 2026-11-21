import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Backend } from '../src/backend';
import type { TerminalInput, Workspace } from '../src/shared/types';

const workspace: Workspace = { id: 'manual', name: 'Manual fixture', kind: 'ssh', host: 'fixture', cwd: '/tmp/fixture' };
function fixture() {
  const backend = new Backend(), id = randomUUID();
  const calls: Array<{ command: string; input?: string }> = [];
  (backend as any).livePane = async () => '%7';
  (backend as any).transport.run = async (_workspace: Workspace, command: string, options?: { input?: string }) => {
    calls.push({ command, input: options?.input }); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return { backend, id, calls };
}
test('manual backend validates input before touching a target and binds every action to the acquired pane', async () => {
  const { backend, id, calls } = fixture();
  for (const input of [null, { type: 'raw', text: 'bad' }, { type: 'text', text: '\x1b[31m' },
    { type: 'text', text: '中'.repeat(22000) }, { type: 'key', key: 'send-prefix' },
    { type: 'literal', text: 'x'.repeat(1025) }, { type: 'literal', text: '\x85' }, { type: 'text', text: '\x9b31m' }]) {
    await assert.rejects(backend.sendTerminalInput(workspace, id, input as TerminalInput, '%7'));
  }
  await assert.rejects(backend.sendTerminalInput(workspace, id, { type: 'key', key: 'Enter' }, '%8'), /pane changed/);
  await assert.rejects(backend.verifyTerminalPane(workspace, id, '%8'), /pane changed/);
  assert.equal(calls.length, 0);
});
test('terminal edit keys use tmux key names rather than typing Backspace or Delete literally', async () => {
  const { backend, id, calls } = fixture();
  await backend.sendTerminalInput(workspace, id, { type: 'key', key: 'Backspace' }, '%7');
  await backend.sendTerminalInput(workspace, id, { type: 'key', key: 'Delete' }, '%7');
  assert.match(calls[0].command, /'BSpace'$/);
  assert.match(calls[1].command, /'DC'$/);
});
test('manual paste rechecks a loaded buffer, cleans up after changed foreground and never automatically presses Enter', async () => {
  const { backend, id, calls } = fixture();
  let probes = 0;
  (backend as any).livePane = async () => ++probes === 1 ? '%7' : '%8';
  await assert.rejects(backend.sendTerminalInput(workspace, id, { type: 'text', text: '字面文本\n$(literal)' }, '%7'), /binding changed/);
  assert.equal(calls.filter(c => c.command.includes('load-buffer')).length, 1);
  assert.equal(calls.filter(c => c.command.includes('paste-buffer')).length, 0);
  assert.equal(calls.filter(c => c.command.includes('delete-buffer')).length, 1);
  assert.ok(calls.every(c => !c.command.includes('send-keys')));
});
test('closing during a foreground probe or buffer load prevents the pending terminal write', async () => {
  const { backend, id, calls } = fixture();
  const stale = () => { throw new Error('lost lease'); };
  await assert.rejects(backend.sendTerminalInput(workspace, id, { type: 'key', key: 'Enter' }, '%7', undefined, stale), /lost lease/);
  let checks = 0;
  await assert.rejects(backend.sendTerminalInput(workspace, id, { type: 'text', text: 'no stale paste' }, '%7', undefined, () => { if (++checks === 2) stale(); }), /lost lease/);
  assert.equal(calls.filter(c => c.command.includes('load-buffer')).length, 1);
  assert.equal(calls.filter(c => c.command.includes('delete-buffer')).length, 1);
  assert.ok(calls.every(c => !c.command.includes('send-keys') && !c.command.includes('paste-buffer')));
});
test('uncertain manual input receipt is not retried and uses the shared per-session input lock', async () => {
  const { backend, id } = fixture();
  let rejectWrite: (error: Error) => void = () => {}, attempted = 0;
  (backend as any).transport.run = async (_workspace: Workspace, command: string) => {
    if (command.includes('paste-buffer')) { attempted++; await new Promise<void>((_, reject) => { rejectWrite = reject; }); }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const sending = backend.sendTerminalInput(workspace, id, { type: 'text', text: 'keep this literal' }, '%7');
  while (!attempted) await new Promise(resolve => setTimeout(resolve, 1));
  for (const action of [
    () => backend.sendMessage(workspace, id, 'blocked'),
    () => backend.sendKey(workspace, id, 'Enter'),
    () => backend.verifyTerminalPane(workspace, id, '%7'),
    () => backend.sendTerminalInput(workspace, id, { type: 'key', key: 'Space' }, '%7'),
  ]) await assert.rejects(action(), { name: 'SessionInputBusyError' });
  rejectWrite(new Error('SSH disconnected after write'));
  await assert.rejects(sending, /disconnected/);
  assert.equal(attempted, 1);
  await backend.verifyTerminalPane(workspace, id, '%7');
});
