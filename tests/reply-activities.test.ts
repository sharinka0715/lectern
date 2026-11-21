import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, ToolBlock } from '../src/shared/types';
import { replyParts, summarizeActivities, toolActivity } from '../src/renderer/reply-activities';

const call = (id: string, name: string, textOffset: number | null | undefined, input = {}, extra: Partial<ToolBlock> = {}): ToolBlock =>
  ({ id, name, input: JSON.stringify(input), textOffset, ...extra });
const delivered = (id: string, textOffset: number, toolsBefore: number) => ({ id, source: 'agent' as const, text: '核对完毕', textOffset, toolsBefore });
const layout = (message: Pick<ChatMessage, 'text' | 'tools' | 'peerMessages' | 'attachments'>, compact = true) => replyParts(message, compact)
  .map(part => part.kind === 'text' ? part.text : part.kind === 'image' ? part.attachment.name : part.rows.map(row => row.kind === 'peer' ? row.peer.id : row.tool.id));

test('正文两侧分组，同一位置的混合调用与多封投递保持原生顺序', () => {
  const message = { text: '前文𠀀后续', tools: [call('cmd', 'Bash', 0), call('send', 'SendMessage', 4), call('edit', 'Edit', 4), call('read', 'Read', 6)],
    peerMessages: [delivered('p0', 4, 1), delivered('p1', 4, 2), delivered('p2', 4, 2)] };
  assert.deepEqual(layout(message), [['cmd'], '前文𠀀', ['p0', 'send', 'p1', 'p2', 'edit'], '后续', ['read']]);
  assert.deepEqual(layout(message, false), [['cmd'], '前文𠀀', ['p0'], ['send'], ['p1'], ['p2'], ['edit'], '后续', ['read']]);
  assert.deepEqual(layout({ text: '', tools: [], peerMessages: [delivered('only', 0, 0), delivered('next', 0, 0)] }), [['only', 'next']]);
});

test('图片按原生文本位置插入，同一位置上的图片分隔前后的工具和投递', () => {
  const message = { text: '首尾', tools: [call('a', 'Read', 1), call('b', 'Read', 1)],
    peerMessages: [delivered('p', 1, 1), delivered('q', 1, 1)],
    attachments: [{ id: 'i', name: 'reward', image: true as const, textOffset: 1, peersBefore: 1, toolsBefore: 1 }] };
  assert.deepEqual(layout(message), ['首', ['a', 'p'], 'reward', ['q', 'b'], '尾']);
  assert.deepEqual(layout({ text: '一二', tools: [], attachments: [{id:'old', name:'旧图片', image:true}] }), ['一二','旧图片']);
});

test('缺少调用或没有原生位置时不推断连续性', () => {
  const tools = [call('orphan1', '工具结果', null), call('orphan2', '工具结果', null), call('known', 'Agent', 0), call('legacy', 'Read', undefined)];
  assert.deepEqual(layout({ text: '答复', tools }), [['orphan1'], ['orphan2'], ['known'], '答复', ['legacy']]);
});

test('更新结果和末尾正文不会改变已存在的聚合标识', () => {
  const tools = [call('c', 'Bash', 1), call('e', 'Edit', 1)];
  const before = replyParts({ text: '前', tools }, true);
  const after = replyParts({ text: '前后', tools: [...tools.map(t => ({ ...t, result: 'done' })), call('a', 'Agent', 1)] }, true);
  assert.deepEqual(before.map(p => p.key), after.slice(0, 2).map(p => p.key));
});

test('摘要按类别首次出现排序，文件按输入路径去重，代理查询次数不冒充返回数量', () => {
  const items = [call('r1', 'Read', 0, { file_path: 'src/a.ts' }, { result: 'r' }), call('c', 'Bash', 0, { command: 'cat z' }),
    call('r2', 'Read', 0, { file_path: 'src/a.ts' }, { result: 'r' }), call('r3', 'Read', 0, { file_path: 'tests/a.ts' }, { result: 'r' }),
    call('w', 'Write', 0, { file_path: 'a.ts' }, { result: 'ok' }), call('a', 'Agent', 0), call('l', 'ListAgents', 0),
    call('s', 'SendMessage', 0, { recipient: 'writer' }, { result: 'ok' }), call('x', 'mcp__unknown__Read', 0, {}, { isError: true, result: 'error' })];
  const [part] = replyParts({ text: '', tools: items, peerMessages: [delivered('p', 0, items.length)] }, true);
  assert.ok(part.kind === 'activities');
  const summary = summarizeActivities(part.rows);
  assert.deepEqual(summary.labels, ['读取 2 个文件', '执行 1 条命令', '修改 1 个文件', '调用代理 1 次', '查询代理 1 次', '发送消息 1 次', '1 项其他操作', '收到 1 条消息']);
  assert.equal(summary.pending, 3); assert.equal(summary.failed, 1); assert.equal(summary.changes, undefined);
});

test('只累计成功结果中的原生补丁或单元格前后内容，部分有据时标记已知', () => {
  const edit = (id: string, extra: Partial<ToolBlock>) => toolActivity(call(id, 'Edit', 0, { file_path: 'a', old_string: '', new_string: 'x\ny\nz' }, extra));
  const patch = [{ oldStart: 0, oldLines: 2, newStart: 0, newLines: 3, lines: [' same', '-old', '+new', '+second', '\\ No newline at end of file'] }];
  const known = edit('native', { result: 'done', editPatch: patch });
  const cell = toolActivity(call('notebook', 'NotebookEdit', 0, { notebook_path: 'n.ipynb' }, { result: 'done', cellEdit: { before: 'kept\nold\n', after: 'kept\n' } }));
  const failed = edit('failed', { result: 'denied', isError: true, editPatch: patch });
  const pending = edit('pending', { editPatch: patch });
  const unknown = edit('no-patch', { result: '+14 −6' });
  const summary = summarizeActivities([known, cell, failed, pending, unknown]);
  assert.deepEqual(known.changes, { added: 2, removed: 1 }); assert.deepEqual(cell.changes, { added: 0, removed: 1 });
  for (const row of [failed, pending, unknown]) assert.equal(row.changes, undefined);
  assert.deepEqual(summary.changes, { added: 2, removed: 2 }); assert.equal(summary.partialChanges, true);
  assert.deepEqual(summary.labels, ['修改文件 5 次']); assert.equal(summary.failed, 1); assert.equal(summary.pending, 1);
});

test('输入无法识别仍作为原工具展示，不从文本猜测接收者和文件', () => {
  for (const input of ['{partial', 'true', 'null', '"file.txt"']) {
    const row = toolActivity(call('id', 'Edit', 0, {}, { input, result: 'done' }));
    assert.equal(row.file, undefined); assert.equal(row.tool.input, input);
    assert.deepEqual(summarizeActivities([row]).labels, ['修改文件 1 次']);
  }
  assert.equal(toolActivity(call('x', 'constructor', 0)).category, 'other');
});

test('折叠的思考与相邻操作合成一行，像 Claude Code 的「Thought for Ns」', () => {
  const thought = (id: string, textOffset: number, durationMs?: number) => call(id, 'Thinking', textOffset, {}, { result: '权衡两种改法', thought: durationMs === undefined ? {} : { durationMs } });
  const tools = [thought('t1', 2, 4_200), call('r', 'Read', 2, { file_path: '/w/a.ts' }, { result: 'x' }), thought('t2', 2, 61_000), thought('t3', 4)];
  assert.deepEqual(layout({ text: '前文后文', tools }), ['前文', ['t1', 'r', 't2'], '后文', ['t3']]);
  const [group] = replyParts({ text: '前文后文', tools }, true).filter(part => part.kind === 'activities');
  assert.equal(group.kind === 'activities' && summarizeActivities(group.rows).labels.join('，'), '思考 1 分 5 秒，读取 1 个文件');
  assert.equal(summarizeActivities([toolActivity(tools[3])]).labels[0], '思考', 'no duration recorded');
  assert.equal(toolActivity(tools[0]).subject, '4 秒');
  assert.equal(toolActivity(thought('short', 0, 300)).subject, '1 秒', 'at least one second, as the TUI shows');
  assert.equal(summarizeActivities([toolActivity(tools[0])]).pending, 0, 'a thought is never an operation in progress');
});
