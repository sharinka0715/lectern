import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSessionLimits, HostSessions, type SessionPlace } from '../src/backend/session-slots';
import { closeDiagnostics, configureDiagnostics, flushDiagnostics } from '../src/diagnostics';

/** Channels for the line to use: `idle` ones can be taken or closed (closing frees nothing until `exit`). */
function pool() {
  const channels: { name: string; idle: boolean; place: SessionPlace; closed?: boolean }[] = [];
  const closed: string[] = [];
  const hooks = {
    takeIdleChannel: () => {
      const channel = channels.find(c => c.idle && !c.closed);
      if (channel) channel.idle = false;
      return channel?.name;
    },
    closeIdleChannel: () => {
      const channel = channels.find(c => c.idle && !c.closed);
      if (!channel) return undefined;
      channel.closed = true;
      closed.push(channel.name);
      return channel.place;
    },
  };
  return { channels, closed, hooks };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('the limits: 4 sessions with 2 channels when shared, 8 with 3 when exclusive', () => {
  assert.deepEqual(defaultSessionLimits, { shared: { sessions: 4, channels: 2 }, exclusive: { sessions: 8, channels: 3 } });
  const sessions = new HostSessions<string>({ host: 'h' }, pool().hooks);
  assert.deepEqual([sessions.mode, sessions.limit, sessions.channelLimit], ['shared', 4, 2], 'shared until the connection is known');
  sessions.setMode('exclusive');
  assert.deepEqual([sessions.limit, sessions.channelLimit], [8, 3]);
});

test('channels, terminals and commands share the places; the rest wait in order', async () => {
  const { hooks } = pool();
  const sessions = new HostSessions<string>({ host: 'h' }, hooks);
  const channel = sessions.tryReserve('channel')!;
  const terminal = (await sessions.acquire('terminal')).place!;
  const commands = [(await sessions.acquire('command')).place!, (await sessions.acquire('command')).place!];
  assert.deepEqual({ ...sessions.active, used: sessions.used }, { channel: 1, terminal: 1, command: 2, used: 4 });
  const order: string[] = [];
  const later = ['a', 'b', 'c'].map(name => sessions.acquire(name === 'b' ? 'terminal' : 'command').then(grant => { order.push(name); return grant.place!; }));
  await settled();
  assert.deepEqual([order, sessions.queued], [[], 3]);
  assert.equal(sessions.tryReserve('channel'), undefined, 'a channel never jumps the line');
  commands[0].release(); commands[0].release();
  await settled();
  assert.deepEqual(order, ['a'], 'a release frees exactly one place, once');
  terminal.release(); channel.release();
  await settled();
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(sessions.active, { channel: 0, terminal: 1, command: 3 });
  for (const place of [commands[1], ...await Promise.all(later)]) place.release();
  assert.equal(sessions.used, 0);
});

test('a channel opens only when nobody waits and a place stays free', () => {
  const sessions = new HostSessions<string>({ host: 'h' }, pool().hooks);
  for (let i = 0; i < 3; i++) assert.ok(sessions.tryReserve('channel', 1));
  assert.equal(sessions.tryReserve('channel', 1), undefined, 'the last place stays for a terminal or a one-off session');
  assert.ok(sessions.tryReserve('command'));
  const waiting = sessions.acquire('command');
  assert.equal(sessions.tryReserve('command'), undefined, 'nothing passes a waiter');
  void waiting;
});

test('a waiting command that can use a channel takes the first one that becomes idle', async () => {
  const { channels, hooks } = pool();
  const sessions = new HostSessions<string>({ host: 'h' }, hooks, { shared: { sessions: 2, channels: 1 }, exclusive: { sessions: 2, channels: 1 } });
  const channelPlace = sessions.tryReserve('channel')!;
  channels.push({ name: 'ch1', idle: false, place: channelPlace });
  const held = (await sessions.acquire('terminal')).place!;
  const grants: unknown[] = [];
  const plain = sessions.acquire('command').then(grant => grants.push(['plain', grant.channel ?? 'place']));
  const flexible = sessions.acquire('command', { channelOk: true }).then(grant => grants.push(['flexible', grant.channel ?? 'place']));
  await settled();
  assert.deepEqual(grants, []);
  // The channel finishes its request.
  channels[0].idle = true;
  sessions.pump();
  await flexible;
  assert.deepEqual(grants, [['flexible', 'ch1']], 'it went to the waiter that can use it, ahead of the line');
  held.release();
  await plain;
  assert.deepEqual(grants.at(-1), ['plain', 'place']);
});

test('when every place is taken, an idle channel gives its place to a waiting session', async () => {
  const { channels, closed, hooks } = pool();
  const sessions = new HostSessions<string>({ host: 'h' }, hooks, { shared: { sessions: 3, channels: 2 }, exclusive: { sessions: 3, channels: 2 } });
  for (const name of ['ch1', 'ch2']) channels.push({ name, idle: true, place: sessions.tryReserve('channel')! });
  sessions.tryReserve('command');
  // A terminal takeover cannot run on a channel: one channel closes for it, not both.
  const terminal = sessions.acquire('terminal');
  await settled();
  assert.deepEqual(closed, ['ch1']);
  assert.equal(sessions.used, 3, 'the closing channel still counts until its client has exited');
  const scan = sessions.acquire('command', { signal: new AbortController().signal });
  await settled();
  assert.deepEqual(closed, ['ch1', 'ch2'], 'a second waiter, a second channel');
  channels[0].place.release();
  assert.equal((await terminal).place?.use, 'terminal');
  channels[1].place.release();
  assert.equal((await scan).place?.use, 'command');
  assert.deepEqual(sessions.active, { channel: 0, terminal: 1, command: 2 });
});

test('a waiter can give up; a raised limit lets the line through', async () => {
  const sessions = new HostSessions<string>({ host: 'h' }, pool().hooks);
  for (let i = 0; i < 4; i++) await sessions.acquire('command');
  const abort = new AbortController();
  const gaveUp = sessions.acquire('command', { signal: abort.signal });
  const next = sessions.acquire('terminal');
  abort.abort(new Error('scan cancelled'));
  await assert.rejects(gaveUp, /scan cancelled/);
  assert.equal(sessions.queued, 1);
  sessions.setMode('exclusive');
  assert.equal((await next).place?.use, 'terminal');
  assert.equal(sessions.used, 5);
});

test('a wait longer than a second is recorded with the host, mode, limit and what held the places', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lectern-session-log-'));
  try {
    configureDiagnostics({ directory, captureContent: false });
    const sessions = new HostSessions<string>({ host: 'gpu-box', port: 2222 }, pool().hooks);
    const held = [sessions.tryReserve('channel')!, (await sessions.acquire('terminal')).place!, (await sessions.acquire('command')).place!, (await sessions.acquire('command')).place!];
    const quick = sessions.acquire('command');
    held[3].release();
    await quick;
    const slow = sessions.acquire('terminal');
    await new Promise(resolve => setTimeout(resolve, 1100));
    held[2].release();
    await slow;
    await flushDiagnostics();
    const files = (await readdir(directory)).filter(name => /^events\.\d+\.jsonl$/.test(name));
    const text = (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8')))).join('');
    const queued = text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(record => record.event === 'transport.session.queued');
    assert.equal(queued.length, 1, 'only the wait over a second');
    assert.deepEqual({ ...queued[0].data, waitedMs: undefined }, { host: 'gpu-box', port: 2222, mode: 'shared', limit: 4, use: 'terminal', outcome: 'place',
      waitedMs: undefined, channels: 1, terminals: 2, commands: 1, waiting: 0 });
    assert.ok(queued[0].data.waitedMs >= 1000);
  } finally { await closeDiagnostics(); configureDiagnostics(); await rm(directory, { recursive: true, force: true }); }
});
