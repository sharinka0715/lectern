import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Backend, projectSlug, type HistoryCursor, type LiveCursor, type SubagentRead } from '../src/backend';
import type { HistoryPage } from '../src/backend/transcript-pages';
import { decodeSubagentList, subagentListScript, subagentPaths } from '../src/backend/subagent-files';
import { MessageDisplay } from '../src/core/message-display';
import { adoptSidechain, coordinatorMessage } from '../src/core/subagent-records';
import { SubagentReader, type SubagentBackend } from '../src/main/subagent-reader';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import { toolDisplayState } from '../src/renderer/reply-activities';
import { defaultSubagent, shownSubagent, subagentEntries } from '../src/renderer/subagent-entries';
import type { SessionActivity } from '../src/shared/activity';
import type { Workspace } from '../src/shared/types';

// Synthetic records with the shapes Claude Code 2.1.300–2.1.330 write to
// <session>/subagents/agent-<id>.jsonl (never copied from a real transcript).
const sid = '00000000-0000-4011-8011-0000000000aa', agent = 'a5f00d1e2b3c4d5e6';
function chain(agentId = agent) {
  let parentUuid: string | null = null, n = 0;
  const base = () => ({ parentUuid, isSidechain: true, sessionId: sid, agentId, cwd: '/work', version: '2.1.330', timestamp: `2026-01-01T03:00:${String(n).padStart(2, '0')}.000Z` });
  const push = (record: Record<string, unknown>) => { const uuid = `${agentId}-${++n}`; const full = { ...base(), uuid, ...record }; parentUuid = uuid; return full; };
  return {
    prompt: (content: string) => push({ type: 'user', promptId: 'p', message: { role: 'user', content } }),
    resume: (message: string) => push({ type: 'user', isMeta: true, origin: { kind: 'coordinator' }, message: { role: 'user',
      content: `The coordinator sent a message while you were working:\n${message}\n\nAddress this before completing your current task.` } }),
    attachment: (type: string) => push({ type: 'attachment', attachment: { type } }),
    // Large request copies without a parent, as 2.1.300+ interleave them.
    request: () => ({ type: 'api-request-blob', agentId, sessionId: sid, content: [{ type: 'text', text: 'x'.repeat(2000) }] }),
    assistant: (id: string, content: unknown[], stop = 'tool_use') => push({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-fixture', content, stop_reason: stop } }),
    result: (toolUseId: string, text: string) => push({ type: 'user', toolUseResult: { stdout: text }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } }),
  };
}
// A thinking block Claude Code folds ("Thought for Ns"): its signature names no purpose.
const thinking = (text: string) => ({ type: 'thinking', thinking: text, signature: Buffer.from([0x12, 4, 0x0a, 2, 0x08, 1]).toString('base64') });
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

function finishedRun() {
  const c = chain();
  return [c.prompt('Inspect the fixture folder'), c.attachment('environment'), c.request(),
    c.assistant('m1', [thinking('Child thinks first.')]), c.assistant('m1', [{ type: 'text', text: 'Child looks around.' }]),
    c.assistant('m1', [{ type: 'tool_use', id: 'toolu_child_1', name: 'Bash', input: { command: 'ls', description: 'List files' } }]),
    c.result('toolu_child_1', 'a.txt\nb.txt'), c.request(),
    c.assistant('m2', [{ type: 'text', text: 'Report: two files.' }], 'end_turn'),
    c.resume('Also count the lines'), c.assistant('m3', [{ type: 'text', text: 'Both files have one line.' }], 'end_turn')];
}

test('a subagent transcript shows as its own conversation: prompt, replies, tools with results, folded thinking and resumes', () => {
  const display = new MessageDisplay(sid, agent);
  display.ingestJsonl(jsonl(finishedRun()));
  const messages = display.getMessages();
  assert.deepEqual(messages.map(m => [m.role, m.text]), [
    ['user', 'Inspect the fixture folder'], ['assistant', 'Child looks around.\n\nReport: two files.'],
    ['user', 'Also count the lines'], ['assistant', 'Both files have one line.']]);
  const tools = messages[1].tools;
  assert.deepEqual(tools.map(tool => [tool.name, tool.result, !!tool.thought]), [['Thinking', 'Child thinks first.', true], ['Bash', 'a.txt\nb.txt', false]]);
  assert.ok(messages.every(m => m.id.startsWith(`${sid}:agent:${agent}:`)), 'its own message IDs, apart from the main chat');
  assert.equal(messages.at(-1)!.status, 'complete');
  // The main conversation never shows sidechain records.
  const main = new MessageDisplay(sid);
  main.ingestJsonl(jsonl(finishedRun()));
  assert.deepEqual(main.getMessages(), []);
});

test('only the named subagent is adopted, and the native resume wrapper is removed', () => {
  assert.equal(adoptSidechain(chain('aother').prompt('Not mine'), agent), undefined);
  assert.equal(adoptSidechain({ type: 'user', sessionId: sid, message: { content: 'main' } }, agent), undefined);
  assert.equal(coordinatorMessage('The coordinator sent a message while you were working:\nGo on\n\nAddress this before completing your current task.'), 'Go on');
  assert.equal(coordinatorMessage('Plain text'), 'Plain text');
  const resumed = adoptSidechain(chain().resume('Go on'), agent)!;
  assert.equal(resumed.origin, undefined);
  assert.equal(resumed.isMeta, undefined);
  assert.equal(resumed.isSidechain, false);
  assert.deepEqual(resumed.message, { role: 'user', content: 'Go on' });
});

/** A backend double over an in-memory file: appends, a tail page and older pages. */
function memoryBackend(initial: string) {
  let data = Buffer.from(initial), inode = '7';
  const window = 4096, calls: string[] = [];
  const backend: SubagentBackend = {
    async readSubagent(_w, _s, agentId, cursor?: LiveCursor): Promise<SubagentRead> {
      calls.push('live:' + agentId);
      const reset = !cursor || cursor.inode !== inode || cursor.offset > data.length;
      if (!reset) return { jsonl: data.subarray(cursor!.offset), reset, missing: false, hasMore: false, cursor: { ...cursor!, offset: data.length } };
      let start = Math.max(0, data.length - window);
      if (start) start = data.indexOf(10, start) + 1;
      const olderCursor: HistoryCursor | undefined = start ? { before: start, inode, size: data.length } : undefined;
      return { jsonl: data.subarray(start), reset, missing: false, hasMore: false, olderCursor, cursor: { offset: data.length, inode } };
    },
    async readSubagentOlder(_w, _s, _a, cursor: HistoryCursor, sizeMiB?: number): Promise<HistoryPage> {
      calls.push('older:' + sizeMiB);
      // 1 MiB here is 16 KiB: small fixtures still take several pages.
      let start = Math.max(0, cursor.before - (sizeMiB ? Math.round(sizeMiB * 16384) : window));
      if (start) start = data.indexOf(10, start) + 1;
      return { jsonl: data.subarray(start, cursor.before), olderCursor: start ? { ...cursor, before: start } : undefined };
    },
  };
  return { backend, calls, append: (text: string) => { data = Buffer.concat([data, Buffer.from(text)]); }, replace: (text: string) => { data = Buffer.from(text); inode = String(Number(inode) + 1); } };
}
const workspace: Workspace = { id: 'w', name: 'w', kind: 'local', cwd: '/work' };

test('the column reader follows a running subagent, answers unchanged polls without messages and pages long runs', async () => {
  const c = chain();
  const head = [c.prompt('Long job'), ...Array.from({ length: 40 }, (_, i) => [
    c.assistant('r' + i, [{ type: 'tool_use', id: 'toolu_' + i, name: 'Read', input: { file_path: `/work/f${i}.txt` } }]), c.result('toolu_' + i, 'line ' + i)]).flat()];
  const memory = memoryBackend(jsonl(head));
  const reader = new SubagentReader(sid, agent);
  const current = () => true;
  let view = await reader.read(memory.backend, workspace, {}, 'running', current);
  // The first page is the newest one; the launch prompt is read from the pages before it.
  assert.ok(memory.calls.some(call => call.startsWith('older:')), 'pages read to reach the prompt');
  assert.equal(view.messages![0].text, 'Long job');
  assert.equal(view.messages!.at(-1)!.status, 'streaming', 'a running subagent is still replying');
  assert.equal(view.messages![1].tools.length, 40);
  const revision = view.revision;
  view = await reader.read(memory.backend, workspace, { revision }, 'running', current);
  assert.equal(view.messages, undefined, 'nothing new: no messages over IPC');
  assert.equal(view.revision, revision);
  memory.append(jsonl([c.assistant('done', [{ type: 'text', text: 'All forty read.' }], 'end_turn')]));
  view = await reader.read(memory.backend, workspace, { revision }, 'running', current);
  assert.match(view.messages!.at(-1)!.text, /All forty read/);
  // Its notification ended it: the last reply is no longer streaming.
  view = await reader.read(memory.backend, workspace, { revision: view.revision }, 'completed', current);
  assert.equal(view.messages!.at(-1)!.status, 'complete');
  // SendMessage resumed it: the message and the new reply follow.
  memory.append(jsonl([c.resume('One more file')]));
  view = await reader.read(memory.backend, workspace, { revision: view.revision }, 'running', current);
  assert.deepEqual(view.messages!.slice(-2).map(m => [m.role, m.text, m.status]), [['user', 'One more file', 'complete'], ['assistant', '', 'streaming']]);
  memory.append(jsonl([c.assistant('again', [{ type: 'text', text: 'Read it too.' }], 'end_turn')]));
  view = await reader.read(memory.backend, workspace, { revision: view.revision }, 'running', current);
  assert.equal(view.messages!.at(-1)!.text, 'Read it too.');
  // A switched-away reader rejects late results.
  await assert.rejects(reader.read(memory.backend, workspace, {}, 'running', () => false));
});

test('a call left without a result shows as interrupted or not finished once the subagent no longer runs', async () => {
  const c = chain();
  const memory = memoryBackend(jsonl([c.prompt('Look'), c.assistant('g1', [{ type: 'tool_use', id: 'toolu_done', name: 'Read', input: { file_path: '/work/a' } }]),
    c.result('toolu_done', 'a'), c.assistant('g2', [{ type: 'tool_use', id: 'toolu_left', name: 'Grep', input: { pattern: 'x' } }])]));
  const reader = new SubagentReader(sid, agent);
  const tools = async (status?: SessionActivity['status']) => {
    const view = await reader.read(memory.backend, workspace, {}, status, () => true);
    return view.messages!.flatMap(m => m.tools).map(tool => [tool.id, tool.unfinished ?? null, toolDisplayState(tool)]);
  };
  assert.deepEqual(await tools('running'), [['toolu_done', null, 'completed'], ['toolu_left', null, 'pending']], 'still running: in progress');
  assert.deepEqual(await tools(undefined), [['toolu_done', null, 'completed'], ['toolu_left', null, 'pending']], 'no known state: as it was');
  assert.deepEqual(await tools('interrupted'), [['toolu_done', null, 'completed'], ['toolu_left', 'interrupted', 'interrupted']]);
  assert.deepEqual(await tools('stopped'), [['toolu_done', null, 'completed'], ['toolu_left', 'interrupted', 'interrupted']]);
  for (const status of ['completed', 'failed', 'unobserved'] as const) assert.deepEqual((await tools(status))[1], ['toolu_left', 'incomplete', 'incomplete'], status);
  // Resumed: in progress again.
  assert.deepEqual((await tools('running'))[1], ['toolu_left', null, 'pending']);
});

test('older pages come on request; a replaced file starts again from its newest page', async () => {
  const c = chain();
  const rows = [c.prompt('Paged job'), ...Array.from({ length: 120 }, (_, i) => c.assistant('p' + i, [{ type: 'text', text: `Step ${i} ` + 'y'.repeat(800) }], 'tool_use'))];
  const memory = memoryBackend(jsonl(rows));
  const reader = new SubagentReader(sid, agent);
  let view = await reader.read(memory.backend, workspace, {}, 'completed', () => true);
  assert.equal(view.historyPage.hasOlder, true, 'too long for the first pages');
  assert.notEqual(view.messages![0].role, 'user', 'it starts within the run');
  const before = view.messages![0].text.length;
  view = await reader.read(memory.backend, workspace, { older: view.historyPage.cursor, sizeMiB: 3 }, 'completed', () => true);
  assert.ok(view.messages![0].text.length > before, 'earlier steps are shown at once');
  assert.ok(memory.calls.includes('older:3'));
  const expired = await reader.read(memory.backend, workspace, { older: 'expired' }, 'completed', () => true);
  assert.equal(expired.revision, view.revision, 'an expired ticket reads nothing');
  memory.replace(jsonl([chain().prompt('Rewritten')]));
  view = await reader.read(memory.backend, workspace, {}, 'completed', () => true);
  assert.deepEqual(view.messages!.map(m => m.text), ['Rewritten']);
  assert.equal(view.historyPage.hasOlder, false);
});

test('the column lists the activity card subagents first (running before ended), matched to their transcripts, then older transcripts', () => {
  const item = (id: string, status: SessionActivity['status'], taskId?: string): SessionActivity => ({ id, kind: 'agent', status, title: 'Task ' + id, taskId, events: [] });
  const files = [
    { agentId: 'afresh', size: 10, modifiedAt: '2026-01-01T00:00:05.000Z', toolUseId: 'toolu_sync', agentType: 'Explore' },
    { agentId: 'aknown', size: 10, modifiedAt: '2026-01-01T00:00:04.000Z' },
    { agentId: 'aolder', size: 10, modifiedAt: '2026-01-01T00:00:01.000Z', description: 'Earlier work', finished: true },
    { agentId: 'aunknown', size: 10, modifiedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const entries = subagentEntries([item('toolu_bg', 'completed', 'aknown'), { ...item('toolu_shell', 'running'), kind: 'shell' }, item('toolu_sync', 'running')], files);
  assert.deepEqual(entries.map(e => [e.key, e.agentId, e.status, e.title]), [
    // No agent ID reported yet: the meta file names the call that launched it.
    ['toolu_sync', 'afresh', 'running', 'Task toolu_sync'],
    ['toolu_bg', 'aknown', 'completed', 'Task toolu_bg'],
    ['agent:aolder', 'aolder', 'completed', 'Earlier work'],
    ['agent:aunknown', 'aunknown', 'unobserved', 'aunknown']]);
  assert.equal(entries[0].agentType, 'Explore');
  assert.equal(defaultSubagent(entries)?.key, 'toolu_sync', 'a running subagent first');
  assert.equal(defaultSubagent(subagentEntries([item('toolu_x', 'running')], []))?.key, 'toolu_x');
  // Loading older history reaches the launch of the earlier one the column shows:
  // its row becomes the activity card's (another key), and it stays shown.
  const older = subagentEntries([item('toolu_sync', 'running'), item('toolu_older', 'completed', 'aolder')], files);
  assert.equal(shownSubagent(older, 'agent:aolder', 'aolder')?.key, 'toolu_older');
  assert.equal(shownSubagent(older, 'toolu_older', 'aolder')?.key, 'toolu_older');
  assert.equal(shownSubagent(older, 'agent:gone', undefined)?.key, 'toolu_sync', 'without a match the default');
});

test('subagents: running first, then ended, then earlier ones whatever their meta says; each newest first by the latest start', () => {
  const at = (second: number) => `2026-01-01T00:01:${String(second).padStart(2, '0')}.000Z`;
  const item = (id: string, status: SessionActivity['status'], extra: Partial<SessionActivity> = {}): SessionActivity =>
    ({ id, kind: 'agent', status, title: 'Task ' + id, taskId: 'a' + id, events: [], ...extra });
  // Card order: newest launch first. Earlier transcripts as the backend lists them, last written first.
  const card = [item('t6', 'failed', { startedAt: at(6) }), item('t5', 'running', { startedAt: at(5) }), item('t4', 'completed'),
    item('t3', 'running', { startedAt: at(3) }), item('t2', 'stopped', { startedAt: at(2), resumedAt: at(8), endedAt: at(9) }),
    item('t1', 'running', { startedAt: at(1), resumedAt: at(7) }), item('t0', 'completed', { startedAt: at(0) })];
  const files = [{ agentId: 'aearly1', size: 10, modifiedAt: at(20), finished: true, description: 'Earlier, finished' },
    { agentId: 'aearly2', size: 10, modifiedAt: at(10), description: 'Earlier, no end recorded' }, { agentId: 'at5', size: 10, modifiedAt: at(30) }];
  const entries = subagentEntries(card, files);
  // Running: t1's resume (7) is later than t5's launch (5). Ended: t2's resume (8) first; t4 has no
  // time and keeps its place (second of the ended ones in card order). Then the earlier two.
  assert.deepEqual(entries.map(e => [e.key, e.status]), [['t1', 'running'], ['t5', 'running'], ['t3', 'running'],
    ['t2', 'stopped'], ['t4', 'completed'], ['t6', 'failed'], ['t0', 'completed'],
    ['agent:aearly1', 'completed'], ['agent:aearly2', 'unobserved']]);
  assert.equal(entries[1].file?.agentId, 'at5', 'matched to its transcript');
  assert.equal(defaultSubagent(entries)?.key, 't1', 'the default: the first running one');
  // Selection survives a reorder: t1 is shown, then ends; t0 is resumed and runs again.
  const later = subagentEntries(card.map(entry => entry.id === 't1' ? { ...entry, status: 'completed' as const, endedAt: at(11) }
    : entry.id === 't0' ? { ...entry, status: 'running' as const, resumedAt: at(12) } : entry), files);
  assert.deepEqual(later.map(e => e.key).slice(0, 4), ['t0', 't5', 't3', 't2']);
  assert.deepEqual(later.map(e => e.key).slice(3, 7), ['t2', 't4', 't1', 't6'], 't1 ended: after t2 (resumed at 8); t4 (no time) keeps its place');
  assert.equal(shownSubagent(later, 't1', 'at1')?.key, 't1');
  assert.equal(shownSubagent(later, 't3', 'at3')?.key, 't3');
  assert.equal(shownSubagent(later, undefined, undefined)?.key, 't0', 'only without a choice does the newest running one show');
  // An earlier one shown when older history reaches its launch: from the last group into the ended
  // ones under the card's key, found again by its agent ID.
  const loaded = subagentEntries([...card, item('told', 'completed', { taskId: 'aearly1', startedAt: at(4) })], files);
  assert.deepEqual(loaded.map(e => e.key).slice(3), ['t2', 't4', 't6', 'told', 't0', 'agent:aearly2']);
  assert.equal(shownSubagent(loaded, 'agent:aearly1', 'aearly1')?.key, 'told');
});

const posix = { skip: process.platform === 'win32' ? 'Local POSIX fixture; Windows runs no local commands' : false };
async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'lectern-subagents-')));
  const workspace: Workspace = { id: 'subagents', name: 'Subagents', kind: 'local', cwd, claudeDir: join(cwd, 'config') };
  const project = join(workspace.claudeDir!, 'projects', projectSlug(cwd));
  const subagents = join(project, sid, 'subagents');
  await mkdir(subagents, { recursive: true });
  await writeFile(join(project, sid + '.jsonl'), jsonl([{ type: 'user', uuid: 'u', sessionId: sid, cwd, message: { content: 'Start' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: sid, cwd, message: { id: 'm', content: [{ type: 'text', text: 'Started.' }], stop_reason: 'end_turn' } }]));
  const backend = new Backend({ tmuxSocket: 'subagents-' + randomUUID(), claudeCommand: 'false' });
  t.after(async () => { await backend.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { workspace, project, subagents, backend };
}

test('the backend lists subagent transcripts with their meta files and reads one like the main transcript', posix, async t => {
  const { workspace, subagents, backend } = await fixture(t);
  const c = chain();
  const rows = [c.prompt('Big job'), ...Array.from({ length: 400 }, (_, i) => [c.request(),
    c.assistant('b' + i, [{ type: 'text', text: `Part ${i}` }], i === 399 ? 'end_turn' : 'tool_use')]).flat()];
  const file = join(subagents, `agent-${agent}.jsonl`);
  await writeFile(file, jsonl(rows));
  await writeFile(join(subagents, `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Big job', toolUseId: 'toolu_big', finished: true }));
  await writeFile(join(subagents, 'agent-asecond.jsonl'), jsonl([chain('asecond').prompt('Small job')]));
  await writeFile(join(subagents, 'agent-bad name.jsonl'), '{}\n');
  const listed = await backend.listSubagents(workspace, sid);
  assert.deepEqual(listed.map(f => f.agentId).sort(), [agent, 'asecond']);
  const big = listed.find(f => f.agentId === agent)!;
  assert.deepEqual([big.agentType, big.description, big.toolUseId, big.finished], ['general-purpose', 'Big job', 'toolu_big', true]);
  assert.equal(listed.find(f => f.agentId === 'asecond')!.description, undefined);

  const first = await backend.readSubagent(workspace, sid, agent);
  assert.equal(first.reset, true);
  assert.ok(first.olderCursor, 'a long transcript opens on its newest page');
  assert.match(first.jsonl.toString(), /Part 399/);
  assert.doesNotMatch(first.jsonl.toString(), /Big job/);
  const older = await backend.readSubagentOlder(workspace, sid, agent, first.olderCursor!, 8);
  assert.match(older.jsonl.toString(), /Big job/);
  assert.equal(older.olderCursor, undefined);
  await appendFile(file, jsonl([c.resume('More')]));
  const next = await backend.readSubagent(workspace, sid, agent, first.cursor);
  assert.equal(next.reset, false);
  assert.match(next.jsonl.toString(), /The coordinator sent a message/);
  assert.equal((await backend.readSubagent(workspace, sid, agent, next.cursor)).jsonl.length, 0);
  const missing = await backend.readSubagent(workspace, sid, 'anone');
  assert.equal(missing.missing, true);
  await assert.rejects(backend.readSubagent(workspace, sid, '../escape'));
});

test('a symlinked subagent folder or transcript is never read', posix, async t => {
  const { workspace, project, subagents, backend } = await fixture(t);
  const elsewhere = join(workspace.cwd, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'agent-alink.jsonl'), jsonl([chain('alink').prompt('Private')]));
  await symlink(join(elsewhere, 'agent-alink.jsonl'), join(subagents, 'agent-alink.jsonl'));
  assert.deepEqual(await backend.listSubagents(workspace, sid), []);
  assert.equal((await backend.readSubagent(workspace, sid, 'alink')).missing, true);
  await rm(join(project, sid), { recursive: true });
  await mkdir(join(project, sid));
  await symlink(elsewhere, join(project, sid, 'subagents'));
  assert.deepEqual(await backend.listSubagents(workspace, sid), []);
  assert.equal((await backend.readSubagent(workspace, sid, 'alink')).missing, true);
});

test('the controller serves a pane its subagent with the activity card state and scoped attachments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lectern-subagent-controller-'));
  const store = new WorkspaceStore(directory);
  await store.save({ id: 'test', name: 'Test', kind: 'local', cwd: '/tmp' });
  const at = (s: number) => `2026-01-01T04:00:0${s}.000Z`;
  const main = [
    { type: 'user', uuid: 'u', sessionId: sid, timestamp: at(0), message: { role: 'user', content: 'Delegate' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: sid, timestamp: at(1), message: { id: 'm', role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Look', prompt: 'Look around', run_in_background: true } },
      { type: 'tool_use', id: 'toolu_sync', name: 'Agent', input: { description: 'Wait', prompt: 'Wait for it' } }] } },
    { type: 'user', uuid: 'r', parentUuid: 'a', sessionId: sid, timestamp: at(2), toolUseResult: { status: 'async_launched', isAsync: true, agentId: agent },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'launched' }] } }];
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } };
  const c = chain();
  const child = jsonl([c.prompt('Look around'), c.assistant('s1', [{ type: 'tool_use', id: 'toolu_shot', name: 'Read', input: { file_path: '/tmp/a.png' } }]),
    { ...c.result('toolu_shot', ''), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [image] }] } }]);
  const backend = {
    readSession: async (_w: unknown, id: string) => ({ session: { id, title: id, mapping: 'exact', paneId: '%1' }, screen: '──────────\n❯ \n──────────',
      jsonl: Buffer.from(jsonl(main)), active: true, reset: true, hasMore: false }),
    // The same synthetic run under whichever agent ID is asked for.
    readSubagent: async (_w: unknown, _s: string, agentId: string): Promise<SubagentRead> => {
      const data = Buffer.from(child.replaceAll(agent, agentId));
      return { jsonl: data, reset: true, missing: false, hasMore: false, cursor: { offset: data.length, inode: '1' } };
    },
    readSubagentOlder: async () => ({ jsonl: Buffer.alloc(0) }),
    completions: { isInstalled: async () => false },
    probeModelCatalog: async () => ({ observedAt: '', defaults: {}, models: [] }),
    verifyTerminalPane: async () => {}, resetRead() {}, dispose() {},
  } as unknown as Backend;
  const controller = new Controller(store, backend);
  try {
    const snapshot = await controller.watchSession('test', sid);
    assert.deepEqual(snapshot.activity?.map(item => [item.id, item.taskId, item.status]), [['toolu_sync', undefined, 'running'], ['toolu_bg', agent, 'running']]);
    const view = await controller.readSubagent('test', sid, agent, {}, 'secondary');
    assert.equal(view.messages!.at(-1)!.status, 'streaming', 'running, as the activity card says');
    const ref = view.messages!.flatMap(m => m.attachments ?? [])[0];
    assert.ok(ref?.id.startsWith('subagent:'), 'its image is scoped to the column');
    assert.ok(controller.messageAttachment('test', sid, ref.id));
    // A launch whose agent ID is not reported yet is found by its Agent call.
    const pending = await controller.readSubagent('test', sid, 'asyncfile', { toolUseId: 'toolu_sync' }, 'secondary');
    assert.equal(pending.messages!.at(-1)!.status, 'streaming');
    const unknown = await controller.readSubagent('test', sid, 'asyncfile2', {}, 'secondary');
    assert.equal(unknown.messages!.at(-1)!.status, 'complete', 'no state without a matching launch');
    controller.releaseSubagents('secondary');
    assert.throws(() => controller.messageAttachment('test', sid, ref.id));
    assert.throws(() => controller.readSubagent('test', sid, '../x', {}, 'secondary'));
    assert.throws(() => controller.readSubagent('test', 'other', agent, {}, 'secondary'));
  } finally { await controller.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('the subagent list decoder keeps only checked IDs and stamps, and tolerates a meta file being written', () => {
  const meta = Buffer.from(JSON.stringify({ agentType: 'Explore', description: '  Look  ', toolUseId: 'toolu_1', finished: false })).toString('base64');
  const frame = Buffer.from(['aone', '120:1767225600', meta, 'bad/id', '1:2', '', 'atwo', 'x:y', '', 'athree', '5:1767225700', '{not base64 json', 'aone', '9:9', ''].join('\0') + '\0');
  assert.deepEqual(decodeSubagentList(frame), [
    { agentId: 'athree', size: 5, modifiedAt: '2026-01-01T00:01:40.000Z' },
    { agentId: 'aone', size: 120, modifiedAt: '2026-01-01T00:00:00.000Z', agentType: 'Explore', description: 'Look', toolUseId: 'toolu_1', finished: false }]);
  assert.throws(() => subagentListScript(['/p'], 'not-a-uuid'));
  assert.throws(() => subagentPaths(['/p'], sid, 'a b'));
  assert.deepEqual(subagentPaths(['/p', '/p'], sid, agent), [`/p/${sid}/subagents/agent-${agent}.jsonl`]);
});
