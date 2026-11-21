import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend, quoteShell, runCommand } from '../src/backend';
import { decodeStatusLineSample, statusLineLaunch, statusLineRegistration } from '../src/backend/native-status-line';
import type { Workspace } from '../src/shared/types';

const sessionId = randomUUID(), nonce = '12'.repeat(16);
const data = {
  session_id: sessionId, model: { id: 'claude-fixture', display_name: 'Fixture' }, effort: { level: 'medium' },
  context_window: { context_window_size: 10000, used_percentage: 0, current_usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } },
};
const frame = (payload: unknown) => nonce + ',' + Buffer.from(JSON.stringify(payload)).toString('base64');

test('status line accepts only matching launch and conversation and returns native fields', () => {
  assert.deepEqual(decodeStatusLineSample(frame(data), nonce, sessionId), {
    sessionId, modelId: 'claude-fixture', modelName: 'Fixture', effort: 'medium', contextWindowSize: 10000, usedPercentage: 0, inputTokens: 6,
  });
  for (const content of [{ ...data, session_id: randomUUID() }, { ...data, model: { id: 'bad\x1b[1m' } }, { ...data, excess: 'x'.repeat(24 * 1024) }]) {
    assert.equal(decodeStatusLineSample(frame(content), nonce, sessionId), undefined);
  }
  assert.equal(decodeStatusLineSample(frame(data), '0'.repeat(32), sessionId), undefined);
  const empty = { session_id: sessionId, model: { id: 'unknown' }, context_window: { current_usage: null, used_percentage: null, context_window_size: 123 } };
  assert.deepEqual(decodeStatusLineSample(frame(empty), nonce, sessionId), { sessionId, modelId: 'unknown', contextWindowSize: 123 });
  const pane = { active: true, managed: true, id: '%1', pid: 1, claudePid: 2, boundSessionId: sessionId, serverInstance: '11:99',
    native: { procStart: '101' }, statusMarker: `11:99,%1,1,2,${sessionId},101,${nonce}` };
  assert.equal(statusLineRegistration(pane), nonce);
  const fork = randomUUID(), switched = { ...pane, forkOrigin: sessionId, boundSessionId: fork, native: { procStart:'101', sessionId:fork } };
  assert.equal(statusLineRegistration(switched), nonce, 'same process retains its launch callback');
  assert.equal(statusLineRegistration({...switched, native:{procStart:'101',sessionId}}),undefined);
  assert.equal(decodeStatusLineSample(frame(data), nonce, fork), undefined, 'old session sample cannot supply fork settings');
  for (const changed of [{ managed: false }, { active: false }, { serverInstance: '11:100' }, { pid: 3 }, { claudePid: 4 }, { id: '%8' }, { native: { procStart: '102' } }, { boundSessionId: randomUUID() }]) {
    assert.equal(statusLineRegistration({ ...pane, ...changed }), undefined);
  }
});

test('decode native TTL and independent rate windows without synthesizing missing data', () => {
  const cache = { ttl: '5m', expires_at: 1795000000, warm: true, caching_observed: true, hit_ratio: 0.58 };
  const rate_limits = { five_hour: { used_percentage: 0, resets_at: 1795000300 }, seven_day: { used_percentage: 99.5 } };
  const native = (p: object, custom = false) => decodeStatusLineSample(frame({ ...data, ...p }).replace(nonce + ',', nonce + (custom ? ',custom:' : ',')), nonce, sessionId)!;
  const line = native({ prompt_cache: cache, rate_limits });
  assert.deepEqual(line.promptCache, { ttl: '5m', expiresAt: 1795000000, warm: true, cachingObserved: true });
  assert.deepEqual(line.fiveHour, { usedPercentage: 0, resetsAt: 1795000300 });
  assert.deepEqual(line.sevenDay, { usedPercentage: 99.5 });
  assert.deepEqual(native({ prompt_cache: { ...cache, expires_at: null, ttl: '1h' } }).promptCache, { ttl: '1h', warm: true, cachingObserved: true });
  assert.deepEqual(native({ prompt_cache: { expires_at: 1795000000000, hit_ratio: 0.9, ttl: 3600 } }).promptCache, {});
  assert.equal(native({ rate_limits: { five_hour: { used_percentage: 101 } } }).fiveHour, undefined);
  assert.equal(native({ rate_limits: { ...rate_limits, spend_limit: { used_percentage: 5 } } }).nonSubscriptionRoute, 'gateway');
  assert.equal(native({ rate_limits }, true).nonSubscriptionRoute, 'custom');
  assert.equal(native({ rate_limits }, true).fiveHour, undefined);
});

test('status line source transport uses the target tmux version', () => {
  for (const version of ['tmux 3.0a', 'tmux next', 'unknown']) {
    const cmd = JSON.parse(statusLineLaunch(sessionId, nonce, version).settings).statusLine.command;
    assert.doesNotMatch(cmd, /tmux source-file -/);
    assert.match(cmd, /umask 077/);
  }
  for (const version of ['tmux 3.1', 'tmux 3.1c', 'tmux 3.10', 'tmux 4.0']) {
    const cmd = JSON.parse(statusLineLaunch(sessionId, nonce, version).settings).statusLine.command;
    assert.match(cmd, /tmux source-file -/);
    assert.doesNotMatch(cmd, /mktemp/);
  }
});

test('per-launch callback captures native stdin in the target pane, survives restart, and clears with the pane', { skip: process.platform === 'win32', timeout: 40_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-status-line-')));
  const workspace: Workspace = { id: randomUUID(), name: 'fixture', kind: 'local', cwd: root, claudeDir: join(root, 'config') };
  const socket = 'statusline-' + randomUUID().slice(0, 8), exe = join(root, 'claude'), fixture = join(root, 'fixture.mjs');
  const tmux = (...args: string[]) => ['tmux', '-L', socket, ...args].map(quoteShell).join(' ');
  const options = { claudeCommand: exe, tmuxSocket: socket, claudeArgs: [fixture] };
  const backend = new Backend(options), reopened = new Backend(options);
  try {
    try { await runCommand(workspace, 'command -v tmux'); } catch { t.skip('tmux unavailable'); return; }
    await mkdir(workspace.claudeDir!);
    await symlink(process.execPath, exe);
    await writeFile(fixture, `
      import {spawnSync} from 'node:child_process';
      import fs from 'node:fs';
      const args=process.argv.slice(2), cmd=JSON.parse(args[args.indexOf('--settings')+1]).statusLine.command;
      const id=args.at(-1), payload=JSON.parse(${JSON.stringify(JSON.stringify(data))});
      payload.session_id=id;
      fs.writeFileSync('started', id);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let count=0;
      process.stdin.on('data',()=> {
        const input = count++ === 0 ? JSON.stringify(payload) : ' '.repeat(26*1024) + JSON.stringify(payload);
        const r=spawnSync('/bin/sh',['-c',cmd],{input,encoding:'utf8'});
        fs.writeFileSync('callback-'+count, JSON.stringify({code:r.status,stdout:r.stdout,stderr:r.stderr}));
      });`);
    const session = await backend.createSession(workspace);
    for (let i = 0; i < 100; i++) {
      if (await readFile(join(root, 'started'), 'utf8').catch(() => '') === session.id) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const pending = await backend.readSession(workspace, session.id);
    assert.equal(pending.statusLineManaged, true);
    assert.equal(pending.statusLine, undefined);
    const trigger = async (index: number) => {
      await runCommand(workspace, tmux('send-keys', '-t', session.paneId!, 'x'));
      for (let i = 0; i < 100; i++) {
        const report = await readFile(join(root, 'callback-' + index), 'utf8').catch(() => '');
        if (report) { assert.deepEqual(JSON.parse(report), { code: 0, stdout: '', stderr: '' }); return; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail('callback did not finish');
    };
    await trigger(1);
    const received = await backend.readSession(workspace, session.id);
    assert.equal(received.statusLine?.modelId, data.model.id);
    assert.equal(received.statusLine?.sessionId, session.id);
    assert.equal(received.statusLine?.inputTokens, 6);
    assert.deepEqual((await reopened.readSession(workspace, session.id)).statusLine, received.statusLine);
    await trigger(2);
    const invalidated = await reopened.readSession(workspace, session.id);
    assert.equal(invalidated.statusLineManaged, true);
    assert.equal(invalidated.statusLine, undefined);
  } finally {
    await runCommand(workspace, tmux('kill-server')).catch(() => {});
    await Promise.all([backend.dispose(), reopened.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});
