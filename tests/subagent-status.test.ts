import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Backend, projectSlug } from '../src/backend';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import { sessionPresenceScript, sessionProcess } from '../src/backend/native-presence';
import { applySubagentPoll, subagentMeta, subagentPollState } from '../src/backend/subagent-files';
import { backgroundCounts, backgroundSummary } from '../src/core/background-work';
import { SessionActivityStore } from '../src/core/session-activity';
import { listsSubagents, mergeSubagents, metaState, versionAtLeast, type SubagentContext } from '../src/core/subagent-status';
import { activityTally, runOrder, type SessionActivity } from '../src/shared/activity';
import { subagentEntries } from '../src/renderer/subagent-entries';
import { taskEntries } from '../src/renderer/task-entries';
import type { SubagentFile, Workspace } from '../src/shared/types';

// Synthetic meta files and transcripts with the shapes Claude Code 2.1.300–2.1.330 write
// to <session>/subagents/ (nothing here comes from a real session).
const sid = '00000000-0000-4011-8011-0000000000d1';
const at = (minute: number) => `2026-01-01T05:${String(minute).padStart(2, '0')}:00.000Z`;
const ms = (minute: number) => Date.parse(at(minute));
const file = (agentId: string, fields: Partial<SubagentFile> = {}): SubagentFile =>
  ({ agentId, agentType: 'general-purpose', description: 'Job ' + agentId, toolUseId: 'toolu_' + agentId, isBuiltIn: true, metaModifiedAt: at(1), ...fields });
const alive = (since?: number): SubagentContext => ({ live: 'alive', since });
const states = (list: SessionActivity[]) => Object.fromEntries(list.filter(item => item.kind === 'agent').map(item => [item.taskId, item.status]));

test('Claude Code 2.1.310 and later list subagents from their folder; 2.1.300, or no sign, keep the transcript', () => {
  assert.equal(versionAtLeast('2.1.310', [2, 1, 310]), true);
  assert.equal(versionAtLeast('2.1.330-beta.1', [2, 1, 310]), true);
  assert.equal(versionAtLeast('2.2.0', [2, 1, 310]), true);
  assert.equal(versionAtLeast('2.1.300', [2, 1, 310]), false);
  assert.equal(versionAtLeast('0.0.0-fixture', [2, 1, 310]), false);
  assert.equal(versionAtLeast(undefined, [2, 1, 310]), undefined);
  const old = { agentId: 'aold', agentType: 'Explore', description: 'Old', toolUseId: 'toolu_old' };
  assert.equal(listsSubagents('2.1.330', []), true);
  assert.equal(listsSubagents('2.1.310', [old]), true);
  assert.equal(listsSubagents('2.1.300', [file('anew')]), false, 'the version decides when known');
  assert.equal(listsSubagents(undefined, [old]), false, '2.1.300 meta files: the transcript');
  assert.equal(listsSubagents(undefined, []), false);
  assert.equal(listsSubagents(undefined, [old, file('anew')]), true, 'a field 2.1.310 introduced');
  assert.equal(listsSubagents(undefined, [{ ...old, finished: true }]), false, 'isBuiltIn, in every 2.1.310+ meta file, is the sign');
});

test('meta fields: finished, isBuiltIn, revivedAt, stoppedByUser, requestShape and model', () => {
  assert.deepEqual(subagentMeta(JSON.stringify({ agentType: 'general-purpose', isBuiltIn: true, description: ' Look ', toolUseId: 'toolu_x', requestShape: 'background',
    model: 'claude-fixture', finished: true, revivedAt: ms(3), stoppedByUser: true, spawnDepth: 1 })),
  { agentType: 'general-purpose', description: 'Look', toolUseId: 'toolu_x', finished: true, isBuiltIn: true, stoppedByUser: true, revivedAt: at(3), model: 'claude-fixture' });
  assert.deepEqual(subagentMeta('{"requestShape":"foreground","isBuiltIn":false}'), { isBuiltIn: false, foreground: true });
  assert.equal(subagentMeta('{"agentType":'), undefined, 'a meta file being written');
  assert.equal(subagentMeta('[1]'), undefined);
});

test('the state of a subagent from its meta file and the process that runs the session', () => {
  const since = ms(10);
  // finished: ended, refined by the transcript where loaded.
  assert.equal(metaState(file('a', { finished: true }), undefined, alive(since)), 'completed');
  assert.equal(metaState(file('a', { finished: true }), undefined, { live: 'gone' }), 'completed');
  assert.equal(metaState(file('a', { finished: true }), undefined, { live: 'unknown' }), 'completed');
  const item = (status: SessionActivity['status']): SessionActivity => ({ id: 'toolu_a', kind: 'agent', status, title: 'A', events: [] });
  assert.equal(metaState(file('a', { finished: true }), item('failed'), alive()), 'failed');
  assert.equal(metaState(file('a', { finished: true }), item('stopped'), alive()), 'stopped');
  assert.equal(metaState(file('a', { finished: true }), item('running'), alive()), 'completed', 'its notification is not written yet');
  assert.equal(metaState(file('a', { finished: true }), item('unobserved'), { live: 'gone' }), 'completed');
  assert.equal(metaState(file('a', { finished: true, stoppedByUser: true }), undefined, alive()), 'stopped');
  assert.equal(metaState(file('a', { finished: true, stoppedByUser: true, revivedAt: at(5) }), undefined, alive()), 'completed', 'stopped once, a later run ended');
  // Not finished: running while the process that launched or resumed it runs.
  assert.equal(metaState(file('a', { metaModifiedAt: at(11) }), undefined, alive(since)), 'running');
  assert.equal(metaState(file('a'), undefined, alive()), 'running', 'the process start unknown');
  assert.equal(metaState(file('a', { metaModifiedAt: at(11) }), item('completed'), alive(since)), 'running', 'resumed: finished cleared');
  // The process is gone (exited, crashed) or is another one: interrupted, never running.
  assert.equal(metaState(file('a', { metaModifiedAt: at(11) }), undefined, { live: 'gone' }), 'interrupted');
  assert.equal(metaState(file('a', { metaModifiedAt: at(11) }), item('unobserved'), { live: 'gone', since }), 'interrupted');
  assert.equal(metaState(file('a', { metaModifiedAt: at(5) }), undefined, alive(since)), 'interrupted', 'launched by the process before this one');
  assert.equal(metaState(file('a', { metaModifiedAt: at(5), revivedAt: at(11) }), undefined, alive(since)), 'running', 'resumed by this one');
  assert.equal(metaState(file('a', { metaModifiedAt: at(11) }), undefined, { live: 'unknown' }), 'unobserved', 'the machine could not be read');
});

test('every subagent of the folder is listed with its state, whatever part of the transcript is loaded', () => {
  // The transcript's newest page has the launch of B only; A, C and D were launched earlier.
  const loaded: SessionActivity[] = [{ id: 'toolu_aB', kind: 'agent', status: 'running', title: 'Loaded B', taskId: 'aB', background: true, startedAt: at(20), resumes: 1, resumedAt: at(25), priorRunMs: 60_000, events: [] },
    { id: 'toolu_shell', kind: 'shell', status: 'running', title: 'Build', background: true, startedAt: at(21), events: [] }];
  const files = [file('aA', { finished: true, startedAt: at(2), metaModifiedAt: at(9) }), file('aB', { metaModifiedAt: at(25), startedAt: at(20) }),
    file('aC', { startedAt: at(12), metaModifiedAt: at(12) }), file('aD', { finished: true, stoppedByUser: true, startedAt: at(15), metaModifiedAt: at(16), model: 'claude-fixture' }),
    file('aE', { metaModifiedAt: at(4), startedAt: at(3) })];
  const merged = mergeSubagents(loaded, files, alive(ms(10)));
  assert.deepEqual(states(merged), { aB: 'running', aA: 'completed', aC: 'running', aD: 'stopped', aE: 'interrupted' });
  const byId = new Map(merged.map(item => [item.id, item]));
  // The loaded one keeps what the transcript says; the others are keyed by their launching call.
  assert.deepEqual([byId.get('toolu_aB')!.title, byId.get('toolu_aB')!.resumes, byId.get('toolu_aB')!.priorRunMs], ['Loaded B', 1, 60_000]);
  assert.deepEqual(byId.get('toolu_aA'), { id: 'toolu_aA', kind: 'agent', title: 'Job aA', agentType: 'general-purpose', events: [], status: 'completed', taskId: 'aA',
    background: true, startedAt: at(2), endedAt: at(9) });
  assert.equal(byId.get('toolu_aD')!.model, 'claude-fixture');
  assert.equal(byId.get('toolu_aE')!.endedAt, undefined, 'an interrupted run has no known end');
  assert.equal(byId.get('toolu_shell'), loaded[1], 'other items are unchanged');
  // The task column and the card list the same, running first, then ended, newest first; nothing is "earlier".
  const column = taskEntries(merged, []).agent;
  assert.deepEqual(column.map(entry => [entry.agent?.agentId, entry.status]), [['aB', 'running'], ['aC', 'running'], ['aD', 'stopped'], ['aE', 'interrupted'], ['aA', 'completed']]);
  assert.deepEqual(runOrder(merged.filter(item => item.kind === 'agent')).map(item => item.taskId), column.map(entry => entry.agent?.agentId));
  assert.ok(column.every(entry => entry.item), 'every row is a card item');
  assert.deepEqual(subagentEntries(merged, files).map(entry => entry.key), column.map(entry => entry.key), 'files add no rows');
  assert.equal(activityTally(merged.filter(item => item.kind === 'agent')), '2 运行中 · 3 结束（1 中断）');
  // The counts beside them (sidebar, title bar, close confirmation) are the same two.
  assert.equal(backgroundCounts(merged, { agents: 5, workflows: 0 }, 'idle', ms(10), true).agents, 2);
  assert.equal(backgroundSummary(merged, undefined, 'busy', ms(10), true), '1 个终端、2 个子代理仍在运行');
});

test('a resume clears finished: the subagent runs again, from its resume', () => {
  const since = ms(10);
  const before = mergeSubagents([], [file('aR', { finished: true, startedAt: at(11), metaModifiedAt: at(12) })], alive(since));
  assert.deepEqual([before[0].status, before[0].endedAt, before[0].resumedAt], ['completed', at(12), undefined]);
  const after = mergeSubagents([], [file('aR', { revivedAt: at(30), startedAt: at(11), metaModifiedAt: at(30) })], alive(since));
  assert.deepEqual([after[0].status, after[0].endedAt, after[0].resumedAt], ['running', undefined, at(30)]);
  // The transcript still says it ended (its resume not read yet): the meta file wins.
  const loaded: SessionActivity = { id: 'toolu_aR', kind: 'agent', status: 'completed', title: 'R', taskId: 'aR', startedAt: at(11), endedAt: at(12), events: [] };
  const merged = mergeSubagents([loaded], [file('aR', { revivedAt: at(30), metaModifiedAt: at(30) })], alive(since));
  assert.deepEqual([merged[0].status, merged[0].endedAt, merged[0].resumedAt], ['running', undefined, at(30)]);
  // Its next end: finished again.
  const ended = mergeSubagents([], [file('aR', { finished: true, revivedAt: at(30), startedAt: at(11), metaModifiedAt: at(40) })], alive(since));
  assert.deepEqual([ended[0].status, ended[0].endedAt, ended[0].resumedAt], ['completed', at(40), at(30)]);
});

test('a crash before finished was written: interrupted, not running, once the process is gone or replaced', () => {
  const running = file('aX', { startedAt: at(11), metaModifiedAt: at(11) });
  const loaded: SessionActivity = { id: 'toolu_aX', kind: 'agent', status: 'running', title: 'X', taskId: 'aX', background: true, startedAt: at(11), events: [] };
  assert.equal(mergeSubagents([loaded], [running], alive(ms(10)))[0].status, 'running');
  // The pane is gone: the store already calls the transcript's run unobserved; the meta file says interrupted.
  const gone = mergeSubagents([{ ...loaded, status: 'unobserved' }], [running], { live: 'gone' });
  assert.equal(gone[0].status, 'interrupted');
  assert.equal(backgroundCounts(gone, { agents: 1, workflows: 0 }, undefined, undefined, true).agents, 0);
  // Resumed in a new process: the old run is not this process's.
  const replaced = mergeSubagents([loaded], [running], alive(ms(20)));
  assert.equal(replaced[0].status, 'interrupted');
  assert.equal(backgroundSummary(replaced, undefined, 'busy', ms(20), true), undefined);
});

test('older or foreground subagents in a 2.1.310+ session keep their transcript state', () => {
  const since = ms(10);
  const old = { agentId: 'aOld', description: 'Old', toolUseId: 'toolu_aOld' };
  const loaded: SessionActivity = { id: 'toolu_aOld', kind: 'agent', status: 'completed', title: 'Old', startedAt: at(1), endedAt: at(2), events: [] };
  assert.deepEqual(states(mergeSubagents([loaded], [old], alive(since))), { aOld: 'completed' });
  assert.deepEqual(states(mergeSubagents([], [old], alive(since))), { aOld: 'unobserved' }, 'no transcript, no tracked meta: the end is unknown');
  assert.deepEqual(states(mergeSubagents([], [{ ...old, finished: true }], alive(since))), { aOld: 'completed' });
  // A run of the earlier process the transcript leaves running is not running now.
  assert.deepEqual(states(mergeSubagents([{ ...loaded, status: 'running', endedAt: undefined }], [old], alive(since))), { aOld: 'unobserved' });
  const foreground = file('aFg', { foreground: true, metaModifiedAt: at(11) });
  const call: SessionActivity = { id: 'toolu_aFg', kind: 'agent', status: 'completed', title: 'Fg', startedAt: at(11), endedAt: at(12), events: [] };
  assert.deepEqual(states(mergeSubagents([call], [foreground], alive(since))), { aFg: 'completed' }, 'a call that waited for it: its result is the end');
  // One just launched whose meta file is not listed yet keeps its transcript state.
  const fresh: SessionActivity = { id: 'toolu_new', kind: 'agent', status: 'running', title: 'New', background: true, startedAt: at(12), events: [] };
  assert.deepEqual(mergeSubagents([fresh], [], alive(since)), [fresh]);
});

const posix = { skip: process.platform === 'win32' ? 'Local POSIX fixture; Windows runs no local commands' : false };
async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'lectern-subagent-status-')));
  const workspace: Workspace = { id: 'subagent-status', name: 'Subagent status', kind: 'local', cwd, claudeDir: join(cwd, 'config') };
  const project = join(workspace.claudeDir!, 'projects', projectSlug(cwd)), folder = join(project, sid, 'subagents');
  await mkdir(folder, { recursive: true });
  await writeFile(join(project, sid + '.jsonl'), [{ type: 'user', uuid: 'u', sessionId: sid, cwd, version: '2.1.330', message: { content: 'Start' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: sid, cwd, version: '2.1.330', message: { id: 'm', content: [{ type: 'text', text: 'Started.' }], stop_reason: 'end_turn' } }]
    .map(row => JSON.stringify(row)).join('\n') + '\n');
  const backend = new Backend({ tmuxSocket: 'subagent-status-' + randomUUID(), claudeCommand: 'false' });
  t.after(async () => { await backend.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { workspace, folder, backend };
}
const first = (agentId: string, minute: number) => JSON.stringify({ parentUuid: null, isSidechain: true, sessionId: sid, agentId, type: 'user', uuid: agentId + '-1',
  message: { role: 'user', content: 'Quote: {"timestamp":"2020-01-01T00:00:00.000Z"}' }, timestamp: at(minute) }) + '\n';
const meta = (agentId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ agentType: 'general-purpose', isBuiltIn: true, description: 'Job ' + agentId,
  toolUseId: 'toolu_' + agentId, spawnDepth: 1, requestShape: 'background', ...extra });

test('the session poll lists the subagent folder in the same command, and nothing when it has not changed', posix, async t => {
  const { workspace, folder, backend } = await fixture(t);
  const ids = Array.from({ length: 30 }, (_, i) => 'a' + String(i).padStart(16, '0'));
  for (const [i, id] of ids.entries()) {
    await writeFile(join(folder, `agent-${id}.jsonl`), first(id, i));
    await writeFile(join(folder, `agent-${id}.meta.json`), meta(id, i % 3 ? { finished: true } : {}));
  }
  // Never read: a symlinked transcript or meta file, a bad name, another folder.
  await writeFile(join(folder, '..', 'private.jsonl'), first('aprivate', 0));
  await symlink(join(folder, '..', 'private.jsonl'), join(folder, 'agent-alink.jsonl'));
  await writeFile(join(folder, 'agent-ameta.jsonl'), first('ameta', 0));
  await symlink(join(folder, '..', 'private.jsonl'), join(folder, 'agent-ameta.meta.json'));
  await writeFile(join(folder, 'agent-bad name.jsonl'), first('bad', 0));
  await mkdir(join(folder, 'workflows'));
  const poll = () => backend.readSession(workspace, sid, false, [], true, false, true, true);
  const opened = (await poll()).subagents!;
  assert.deepEqual(opened.files.map(f => f.agentId).sort(), [...ids, 'ameta'].sort());
  const second = opened.files.find(f => f.agentId === ids[1])!;
  assert.deepEqual([second.description, second.toolUseId, second.finished, second.isBuiltIn, second.startedAt], ['Job ' + ids[1], 'toolu_' + ids[1], true, true, at(1)],
    'the start is the first record\'s own time, not one quoted in its text');
  assert.ok(second.metaModifiedAt && Number.isFinite(Date.parse(second.metaModifiedAt)));
  assert.equal(opened.files.find(f => f.agentId === 'ameta')!.description, undefined, 'its meta file is a symlink');
  // Unchanged: the same revision. A running transcript growing (or a record appended
  // to an ended one later) is not a change of the listing.
  await appendFile(join(folder, `agent-${ids[0]}.jsonl`), JSON.stringify({ type: 'data-flow-records', agentId: ids[0] }) + '\n');
  assert.equal((await poll()).subagents!.revision, opened.revision);
  // A meta file written (finished, resumed) and a new subagent are.
  await writeFile(join(folder, `agent-${ids[0]}.meta.json`), meta(ids[0], { finished: true }));
  const finished = (await poll()).subagents!;
  assert.ok(finished.revision > opened.revision);
  assert.equal(finished.files.find(f => f.agentId === ids[0])!.finished, true);
  await writeFile(join(folder, `agent-${ids[0]}.meta.json`), meta(ids[0], { revivedAt: ms(50) }));
  const old = new Date(Date.now() - 60_000);
  await utimes(join(folder, `agent-${ids[0]}.meta.json`), old, old);
  const resumed = (await poll()).subagents!.files.find(f => f.agentId === ids[0])!;
  assert.deepEqual([resumed.finished, resumed.revivedAt], [undefined, at(50)]);
  await writeFile(join(folder, 'agent-anew.meta.json'), meta('anew'));
  await writeFile(join(folder, 'agent-anew.jsonl'), first('anew', 59));
  const added = (await poll()).subagents!;
  assert.equal(added.files.find(f => f.agentId === 'anew')?.startedAt, at(59));
  // Gone: gone from the list.
  await rm(join(folder, 'agent-anew.jsonl'));
  assert.equal((await poll()).subagents!.files.some(f => f.agentId === 'anew'), false);
  // Not asked for: not listed.
  assert.equal((await backend.readSession(workspace, sid, false, [], true)).subagents, undefined);
});

test('a listing is applied only from a complete answer, and a meta file read while being written is read again', () => {
  const state = subagentPollState();
  const stat = (lines: string[]) => lines.join('\n');
  const frame = (fields: string[]) => Buffer.from(fields.join('\0') + '\0');
  const metaText = (lines: string[]) => Buffer.from(lines.join('\n') + '\n').toString('base64');
  // GNU stat: %f is the mode in hex (81a4 a regular file, a1ff a symlink).
  assert.equal(applySubagentPoll(frame(['+1 10', '@0', stat(['agent-aone.meta.json 40 1767243600 81a4']), stat(['agent-aone.jsonl 81a4', 'agent-alink.jsonl a1ff']),
    metaText(['agent-aone.meta.json:{"agentType":"Explore","isBuiltIn":true,"finished"']), '==> agent-aone.jsonl <==\n"timestamp":"2026-01-01T05:00:00.000Z"']), state, false), true);
  assert.deepEqual(state.files, [{ agentId: 'aone', metaModifiedAt: '2026-01-01T05:00:00.000Z', startedAt: at(0) }]);
  assert.equal(state.fingerprint, undefined, 'the torn meta file is read again next time');
  assert.equal(applySubagentPoll(frame(['+1 11', '@0', stat(['agent-aone.meta.json 52 1767243600 81a4']), stat(['agent-aone.jsonl 81a4']),
    metaText(['agent-aone.meta.json:{"agentType":"Explore",', 'agent-aone.meta.json:"isBuiltIn":true,"finished":true}']), '']), state, false), true);
  assert.deepEqual(state.files, [{ agentId: 'aone', agentType: 'Explore', finished: true, isBuiltIn: true, metaModifiedAt: '2026-01-01T05:00:00.000Z', startedAt: at(0) }]);
  assert.equal(state.fingerprint, '1 11');
  assert.equal(applySubagentPoll(frame(['=1 11']), state, false), false);
  assert.equal(applySubagentPoll(Buffer.from(''), state, false), false);
  assert.equal(state.fingerprint, undefined, 'an answer without a listing lists again next time');
  // BSD stat: %p is the mode in octal.
  const bsd = subagentPollState();
  applySubagentPoll(frame(['+2 3', '@0', stat(['agent-atwo.meta.json 30 1767243600 100644']), stat(['agent-atwo.jsonl 100644', 'agent-alink.jsonl 120755']),
    metaText(['agent-atwo.meta.json:{"description":"Two","isBuiltIn":true}']), '']), bsd, true);
  assert.deepEqual(bsd.files.map(f => [f.agentId, f.description]), [['atwo', 'Two']]);
});

/** The start time Claude Code records for a process (`procStart`), read as presenceReadScript reads it. */
function procStart(pid: number): string {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19];
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim();
}

test('a process of the session outside Lectern panes is found by its native record, never by a reused PID', posix, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-session-process-')));
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(async () => { sleeper.kill(); await rm(root, { recursive: true, force: true }); });
  const pid = sleeper.pid!, sessions = join(root, 'claude', 'sessions'), other = '00000000-0000-4011-8011-0000000000e9';
  await mkdir(sessions, { recursive: true });
  const record = (fields: Record<string, unknown>) => JSON.stringify({ pid, sessionId: sid, procStart: procStart(pid), startedAt: ms(3), kind: 'interactive', cwd: '/work', ...fields });
  const find = () => sessionProcess(execFileSync('/bin/sh', ['-c', sessionPresenceScript(join(root, 'claude'), sid)]).toString('ascii').split('\0'), sid);
  assert.deepEqual(find(), { alive: false }, 'no registry entries');
  // Its own record, in a terminal of its own (no tmux field).
  await writeFile(join(sessions, `${pid}.json`), record({}));
  assert.deepEqual(find(), { alive: true, startedAt: ms(3) });
  // The PID now runs another process: its start differs from the record's.
  await writeFile(join(sessions, `${pid}.json`), record({ procStart: '1' }));
  assert.deepEqual(find(), { alive: false });
  // A record naming another PID, or another session, does not count.
  await writeFile(join(sessions, `${pid}.json`), record({ pid: pid + 1 }));
  assert.deepEqual(find(), { alive: false });
  await writeFile(join(sessions, `${pid}.json`), record({ sessionId: other }));
  assert.deepEqual(find(), { alive: false });
  // Rewritten just then (2.1.329 writes in place): not a verdict either way.
  await writeFile(join(sessions, `${pid}.json`), record({}) + '47,"waitingFor":"x"}');
  assert.deepEqual(find(), { alive: false, uncertain: true });
  // A dead process's record (a crash left it) and a symlinked record are passed over.
  await rm(join(sessions, `${pid}.json`));
  await writeFile(join(sessions, '999999999.json'), record({ pid: 999999999 }));
  await writeFile(join(root, 'elsewhere.json'), record({}));
  await symlink(join(root, 'elsewhere.json'), join(sessions, `${pid}.json`));
  assert.deepEqual(find(), { alive: false });
  assert.throws(() => sessionPresenceScript('/x', 'not-a-uuid'));
});

test('the controller: with no Lectern pane, a live process of the session elsewhere keeps its subagents running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lectern-subagent-elsewhere-'));
  const store = new WorkspaceStore(directory);
  await store.save({ id: 'test', name: 'Test', kind: 'local', cwd: '/tmp' });
  const main = [{ type: 'user', uuid: 'u', sessionId: sid, version: '2.1.330', timestamp: at(0), message: { role: 'user', content: 'Delegate' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: sid, version: '2.1.330', timestamp: at(1), message: { id: 'm', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Started.' }] } }];
  const files = [file('aRun', { metaModifiedAt: at(5), startedAt: at(5) }), file('aDone', { finished: true, startedAt: at(2), metaModifiedAt: at(4) })];
  let found = { alive: true, startedAt: ms(3) }, pane = false, reads = 0;
  const asked: { listing: boolean; elsewhere: boolean }[] = [];
  const backend = {
    readSession: async (...args: unknown[]) => {
      const [listing, elsewhere] = [!!args[7], !!args[8]], first = !reads++;
      asked.push({ listing, elsewhere });
      return { session: { id: sid, title: sid, mapping: pane ? 'exact' : 'unbound', ...(pane && { paneId: '%1' }) }, screen: pane ? '──────────\n❯ \n──────────' : '',
        jsonl: first ? Buffer.from(main.map(row => JSON.stringify(row)).join('\n') + '\n') : Buffer.alloc(0), active: pane, reset: first, hasMore: false,
        ...(pane && { nativeStartedAt: ms(10) }), ...(listing && { subagents: { revision: 1, files } }), ...(elsewhere && { sessionProcess: found }) };
    },
    completions: { isInstalled: async () => false },
    probeModelCatalog: async () => ({ observedAt: '', defaults: {}, models: [] }),
    verifyTerminalPane: async () => {}, resetRead() {}, dispose() {},
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  const agentStates = (snapshot?: { activity?: SessionActivity[] }) => states(snapshot?.activity ?? []);
  const later = async () => { await new Promise(resolve => setTimeout(resolve, 950)); return controller.refresh('test', sid); };
  try {
    // Opened as history: the same read lists the folder and looks for the process elsewhere.
    assert.deepEqual(agentStates(await controller.watchSession('test', sid)), { aRun: 'running', aDone: 'completed' });
    assert.deepEqual(asked[0], { listing: true, elsewhere: true });
    // That process ends: interrupted at the next look.
    found = { alive: false } as typeof found;
    assert.deepEqual(agentStates(await later()), { aRun: 'interrupted', aDone: 'completed' });
    // Resumed in a Lectern pane (a new process): the pane decides, and the registry is not searched while it runs.
    pane = true;
    await later();
    assert.deepEqual(agentStates(await later()), { aRun: 'interrupted', aDone: 'completed' }, 'launched before this process started');
    assert.deepEqual(asked.at(-1), { listing: true, elsewhere: false });
  } finally { await controller.dispose(); await rm(directory, { recursive: true, force: true }); }
});
