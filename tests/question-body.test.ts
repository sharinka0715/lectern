import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseQuestionScreen as parse } from '../src/core/question-screen';

// The reported screen (a single AskUserQuestion that only the terminal could answer) and its kin,
// drawn by Claude Code 2.1.331, 2.1.330 and 2.1.300 in 120×40 panes and other widths with a
// loopback model; private names replaced. reported-120 is the user's screenshot row for row: the
// rows above the dialog rebuilt with placeholders, the dialog as 2.1.331 drew the same question.
const shot = (version: string, name: string) => readFileSync(new URL(`./fixtures/question-body-${version}/${name}.txt`, import.meta.url), 'utf8');
const asked = { pendingToolUse: true } as const;
const QUESTION = [
  '要提交这个 H200 job 来测 736 rel 20k 吗？我建议同一个 job 顺带测 736 abs 20k：736 rel 只有 20k，没有同步数的 abs 对照就分不清是动作表示还是训练步数的影响。',
  '',
  '384 abs 30k 已经在本机 2 张 L40 上开始跑（约 25 分钟），不占这个 job。',
  '',
  '- Job 名：demo-grad-eval-736rel-20k-736abs-20k（yaml：work/jobs/demo-grad-eval-736rel-20k-736abs-20k.yaml，复制自上次的 demo-grad-eval-736abs-60k-init）',
  '- 镜像：registry.example.com/demo-team/sample-va:1234567-abc-trainer（同样的 565→550 驱动修正）',
  '- 命令：依次对 736 rel global_step_20000、736 abs global_step_20000 跑 8 卡 torchrun grad_alignment.py（128 窗口、seed 0），写到各自 run 的 eval/grad_align/step20000，最后 sleep infinity',
  '- 队列 9001 demo-queue-gpu（788 卡里空 208），1 节点 × 8 张 gpu-a-141g | 20 CPU | 220 GiB，GUARANTEED_SHARED，priority 8，不可抢占，rdma false，workspace 10001（context abc），挂载和上次相同',
  '- 预计：每个 ckpt 约 18 分钟（含 3 到 4 分钟加载权重），两个一共约 40 分钟。确认 gram.pt 都写好后我把 job 停掉。',
].join('\n');
const CHOICES = [
  ['提交，含 736 abs 20k (Recommended)', '一个 H200 job 依次跑 736 rel 20k 和 736 abs 20k，约 40 分钟'],
  ['提交，只测 736 rel 20k', 'H200 只跑 736 rel 20k，约 20 分钟；和 736 abs 只能对比 30k/60k'],
  ['不提交，都在本机跑', '384 abs 30k 跑完后在本机 2 张 L40 上接着跑 736 rel 20k，再多约 45 分钟'],
];
const SECOND = '先跑哪一个？\n\n- 736 rel：已经训练到 20k\n- 736 abs：同步数的对照';
const styled = (frame: string) => frame.split('\n').map(line => '\x1b[0m' + line.replace('❯', '\x1b[36m❯\x1b[39m')
  .replace(/^( ?)│/u, '$1\x1b[2m│\x1b[22m') + '   ').join('\n') + '\n\n';

test('the reported dialog: a long question with blank lines, a list and wrapped rows is read whole', () => {
  const frames = [['2.1.331', 'reported-120'], ['2.1.331', 'user-120'], ['2.1.331', 'user-120-down'], ['2.1.331', 'user-80'],
    ['2.1.331', 'user-160'], ['2.1.331', 'user-120-unnamed'], ['2.1.330', 'user-120'], ['2.1.300', 'user-120']];
  for (const [version, name] of frames) {
    const s = parse(shot(version, name), asked), id = `${version}/${name}`;
    assert.equal(s?.kind, 'question', id);
    // Paragraphs and list items keep their own line breaks; wrapped rows rejoin to the asked text,
    // a run cut at a narrow row's end ("…/demo-grad-eval" + "-736rel-…" at 80 columns) included.
    assert.equal(s.question, QUESTION, id);
    assert.deepEqual(s.tabs, [{ label: 'H200 job', answered: false }], id);
    assert.equal(s.activeTab, 0); assert.equal(s.multiSelect, false);
    const down = name.endsWith('-down');
    assert.deepEqual(s.options.map(o => [o.number, o.kind, o.label, o.description, o.focused]), [
      ...CHOICES.map(([label, description], i) => [i + 1, 'choice', label, description, i === (down ? 1 : 0)]),
      [4, 'other', 'Type something.', undefined, false], [5, 'chat', 'Chat about this', undefined, false]], id);
    assert.deepEqual(s.input, { kind: 'other', number: 4, value: '', focused: false }, id);
    assert.equal(s.footer, 'Enter to select · ↑/↓ to navigate · Esc to cancel', id);
    assert.deepEqual(parse(styled(shot(version, name)), asked), s, `${id} under SGR and tmux padding`);
    // Reply text above it: only Claude Code's own evidence that it asks vouches for the dialog.
    assert.equal(parse(shot(version, name)), undefined, id);
  }
});

test('other shapes of the same dialog: two options, code and a bar of its own, a long header, previews, narrow tabs', () => {
  const two = parse(shot('2.1.331', 'two-options'), asked)!;
  assert.equal(two.question, QUESTION);
  assert.deepEqual(two.options.map(o => [o.number, o.kind, o.description ?? null]), [
    [1, 'choice', CHOICES[0][1]], [2, 'choice', CHOICES[1][1]], [3, 'other', null], [4, 'chat', null]]);
  // The question is not markdown on screen: backticks, a numbered list, an indented quote, a fence
  // and a row that starts with a bar of its own come back as asked (2.1.331 and 2.1.300 alike).
  const CODE = '运行 `npm run build` 之后：\n\n1. 先检查 `dist/` 目录\n2. 再看日志：\n   > warning: unused variable `x`\n\n```\nconst x = 1;\n```\n\n│ 这一行本身以竖线开头。要继续吗？';
  for (const version of ['2.1.331', '2.1.300']) {
    const code = parse(shot(version, 'code'), asked)!;
    assert.equal(code.question, CODE, version);
    assert.deepEqual(code.tabs, [{ label: '构建', answered: false }]);
    assert.equal(code.options.length, 5);
  }
  assert.deepEqual(parse(shot('2.1.331', 'long-header'), asked)?.tabs, [{ label: 'H200 job submission check', answered: false }]);
  const preview = parse(shot('2.1.331', 'preview'), asked)!;
  assert.equal(preview.question, QUESTION.split('\n').slice(0, 5).join('\n'));
  assert.deepEqual(preview.options.map(o => [o.kind, o.label]), [['choice', '瀑布流'], ['choice', '分组网格'], ['chat', 'Chat about this']]);
  assert.equal(preview.preview, '┌──┐┌────┐\n│  ││    │\n└──┘└────┘');
  // Four questions at 60 columns: Claude Code cuts the headers short ("Check…").
  const tabs = parse(shot('2.1.331', 'tabs-60'), asked)!;
  assert.deepEqual(tabs.tabs.map(t => t.label), ['Submission', 'Check…', 'Queue…', 'Notif…']);
  assert.equal(tabs.question, '提交吗？');
  assert.equal(tabs.options[0].description, CHOICES[0][1]);
});

test('several questions, multi-select and their review pages keep each question as asked', () => {
  const first = parse(shot('2.1.331', 'multi-first'), asked)!, second = parse(shot('2.1.331', 'multi-second'), asked)!;
  assert.equal(first.question, QUESTION);
  assert.equal(second.question, SECOND);
  assert.deepEqual(second.tabs, [{ label: 'H200 job', answered: true }, { label: '顺序', answered: false }]);
  assert.equal(first.footer, 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel');
  // The review bars every question; a blank line of its own is a bar alone (" │").
  for (const version of ['2.1.331', '2.1.330', '2.1.300']) {
    const review = parse(shot(version, 'multi-review'), asked)!;
    assert.equal(review.kind, 'review', version);
    assert.deepEqual(review.review, [{ question: QUESTION, answer: CHOICES[0][0] }, { question: SECOND, answer: 'rel 先' }], version);
    assert.deepEqual(parse(styled(shot(version, 'multi-review')), asked), review, `${version} under SGR and tmux padding`);
  }
  const submit = parse(shot('2.1.331', 'multiselect-submit'), asked)!;
  assert.equal(submit.question, QUESTION);
  assert.deepEqual(submit.options.map(o => [o.number, o.kind, o.checked ?? null, o.focused, o.description ?? null]), [
    [1, 'choice', true, false, CHOICES[0][1]], [2, 'choice', false, false, CHOICES[1][1]], [3, 'choice', false, false, CHOICES[2][1]],
    [4, 'other', false, false, null], [6, 'submit', null, true, null], [5, 'chat', null, false, null]]);
  assert.equal(submit.footer, 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel');
  assert.deepEqual(parse(shot('2.1.331', 'multiselect-review'), asked)?.review, [{ question: QUESTION, answer: CHOICES[0][0] }]);
});

test('whatever the question holds between the anchors, the dialog is read; a long answer of one\'s own too', () => {
  const frame = shot('2.1.331', 'user-120'), body = frame.split('\n').filter(line => line.startsWith('│')).join('\n');
  // Rows that look like options, rules, footers, replies or quotes are the question's own.
  const rows = ['看起来像选项的行：', '', '❯ 1. 不是选项', '  2. 也不是', '────────────────', 'Enter to select · ↑/↓ to navigate · Esc to cancel',
    '● 像回复的圆点', '> 引用', '```', '', '最后一行。'];
  const odd = parse(frame.replace(body, rows.map(row => row ? `│ ${row}` : '│').join('\n')), asked);
  assert.equal(odd?.question, rows.join('\n'));
  assert.equal(odd.options.find(o => o.focused)?.label, CHOICES[0][0]);
  // One unbarred row of any shape (the options are found upwards from the divider).
  for (const row of ['> 引用开头的问题？', '● 圆点开头？', '  1. 编号开头？', '❯ 箭头开头？'])
    assert.equal(parse(frame.replace(body, row), asked)?.question, row.trim(), row);
  // A row that lost its bar is kept as it is, not a reason to drop the card.
  assert.ok(parse(frame.replace('│ 对照就分不清', '对照就分不清'), asked)?.question?.includes('对照就分不清'));
  // A long answer typed into "Type something." wraps under it (2.1.330, 2.1.300 alike: 80 columns).
  const other = parse(shot('2.1.330', 'other-80'), asked)!;
  assert.deepEqual(other.input, { kind: 'other', number: 3, focused: true,
    value: '先跑 736 rel 20k，跑完看一下 gram.pt 的大小和 eval/grad_align/step20000/summary.json 再决定要不要接着跑 736 abs 20k' });
  assert.deepEqual(other.options.map(o => [o.kind, o.label, o.focused]), [['choice', CHOICES[0][0], false], ['choice', CHOICES[1][0], false],
    ['other', 'Type something.', true], ['chat', 'Chat about this', false]]);
  assert.equal(other.footer, 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel');
});

test('the frame itself must be whole: anchors, one pointer, consecutive numbers, the Chat row', () => {
  const frame = shot('2.1.331', 'user-120');
  for (const broken of [
    frame.replace('Enter to select · ↑/↓ to navigate · Esc to cancel', ''), // no footer
    frame.replace(' ☐ H200 job\n', ''), // no tab strip under the top rule
    frame.replace('  2. 提交，只测', '❯ 2. 提交，只测'), // two pointers
    frame.replace('  3. 不提交', '  7. 不提交'), // numbering gap
    frame.replace('  5. Chat about this\n', ''),
    frame.replace(/\n─+ align between image and audio ─\n?$/u, '\n❯ Returned composer\n'), // an input box below
    frame.replace('停掉。\n\n❯ 1.', '停掉。\n❯ 1.'), // no blank row above the options
  ]) assert.equal(parse(broken, asked), undefined, broken.slice(-400));
  // A dialog taller than the pane: Claude Code redraws it whole and clears the scrollback, so its
  // top (the rule, the header, the start of the question) is nowhere to read; no card (40 rows).
  assert.equal(parse(shot('2.1.331', 'cut-off-40-rows'), asked), undefined);
});
