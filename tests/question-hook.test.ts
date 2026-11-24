import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { askedQuestions, readHookQuestion, type AskedQuestion } from '../src/core/question-hook';
import { parseQuestionScreen } from '../src/core/question-screen';
import { performQuestionAction, type QuestionDriver } from '../src/backend/native-question-actions';

// The dialogs of question-body-2.1.331 (Claude Code 2.1.331, 120×40), read with the call's input as
// the PreToolUse hook hands it over: the text is the input's, the screen gives page, focus and edits.
const shot = (name: string) => readFileSync(new URL(`./fixtures/question-body-2.1.331/${name}.txt`, import.meta.url), 'utf8');
const QUESTION = '要提交这个 H200 job 来测 736 rel 20k 吗？（hook 里的原文）';
const H200: AskedQuestion = { question: QUESTION, header: 'H200 job', multiSelect: false, options: [
  { label: '提交，含 736 abs 20k (Recommended)', description: '说明一（取自 hook）' },
  { label: '提交，只测 736 rel 20k', description: '说明二（取自 hook）' },
  { label: '不提交，都在本机跑', description: '说明三（取自 hook）' }] };
const ORDER: AskedQuestion = { question: '先跑哪一个？\n\n- 736 rel：已经训练到 20k\n- 736 abs：同步数的对照', header: '顺序', multiSelect: false,
  options: [{ label: 'rel 先', description: '先看 rel。' }, { label: 'abs 先', description: '先看 abs。' }] };
const styled = (frame: string) => frame.split('\n').map(line => '\x1b[0m' + line.replace('❯', '\x1b[36m❯\x1b[39m') + '   ').join('\n') + '\n\n';

test('a dialog taller than the pane, its top cut off, is a card with the hook\'s text and the screen\'s focus', () => {
  const frame = shot('cut-off-40-rows');
  assert.equal(parseQuestionScreen(frame, { pendingToolUse: true }), undefined, 'the screen alone cannot read it');
  const s = readHookQuestion(frame, [H200])!;
  assert.equal(s.kind, 'question');
  assert.equal(s.question, QUESTION);
  assert.deepEqual(s.tabs, [{ label: 'H200 job', answered: false }]);
  assert.equal(s.activeTab, 0); assert.equal(s.multiSelect, false);
  assert.deepEqual(s.options.map(o => [o.number, o.kind, o.label, o.description, o.focused]), [
    ...H200.options.map((o, i) => [i + 1, 'choice', o.label, o.description, i === 0]),
    [4, 'other', 'Type something.', undefined, false], [5, 'chat', 'Chat about this', undefined, false]]);
  assert.deepEqual(s.input, { kind: 'other', number: 4, value: '', focused: false });
  assert.equal(s.footer, 'Enter to select · ↑/↓ to navigate · Esc to cancel');
  assert.deepEqual(readHookQuestion(styled(frame), [H200]), s, 'under SGR and tmux padding');
  const down = frame.replace('❯ 1. 提交，含', '  1. 提交，含').replace('  2. 提交，只测', '❯ 2. 提交，只测');
  assert.deepEqual(readHookQuestion(down, [H200])!.options.map(o => o.focused), [false, true, false, false, false]);
});

test('a dialog the screen reads whole takes the hook\'s text; any other call\'s input reads nothing', () => {
  const s = readHookQuestion(shot('user-120'), [H200])!;
  const whole = parseQuestionScreen(shot('user-120'), { pendingToolUse: true })!;
  assert.equal(s.question, QUESTION);
  assert.deepEqual(s.options.map(o => o.description), [...H200.options.map(o => o.description), undefined, undefined]);
  assert.deepEqual(s.options.map(o => [o.number, o.kind, o.focused]), whole.options.map(o => [o.number, o.kind, o.focused]));
  assert.equal(s.footer, whole.footer);
  const others: AskedQuestion[] = [
    { ...H200, options: H200.options.slice(0, 2) },
    { ...H200, options: [{ label: '提交' }, ...H200.options.slice(1)] },
    { ...H200, multiSelect: true },
  ];
  for (const other of [{ ...H200, header: '别的标题' }, ...others]) assert.equal(readHookQuestion(shot('user-120'), [other]), undefined, JSON.stringify(other).slice(0, 80));
  for (const other of others) assert.equal(readHookQuestion(shot('cut-off-40-rows'), [other]), undefined, JSON.stringify(other).slice(0, 80));
  // Two questions asked, one shown: not this dialog.
  assert.equal(readHookQuestion(shot('user-120'), [H200, ORDER]), undefined);
});

test('two questions: the page is the one whose options show, answered marks from the tabs, the review with the asked text', () => {
  const first = readHookQuestion(shot('multi-first'), [H200, ORDER])!;
  assert.equal(first.activeTab, 0);
  assert.equal(first.question, QUESTION);
  assert.deepEqual(first.tabs, [{ label: 'H200 job', answered: false }, { label: '顺序', answered: false }]);
  const second = readHookQuestion(shot('multi-second'), [H200, ORDER])!;
  assert.equal(second.activeTab, 1);
  assert.equal(second.question, ORDER.question);
  assert.deepEqual(second.tabs, [{ label: 'H200 job', answered: true }, { label: '顺序', answered: false }]);
  const review = readHookQuestion(shot('multi-review'), [H200, ORDER])!;
  assert.equal(review.kind, 'review');
  assert.deepEqual(review.review, [{ question: QUESTION, answer: '提交，含 736 abs 20k (Recommended)' }, { question: ORDER.question, answer: 'rel 先' }]);
});

test('the preview chooser shows the hook\'s preview of the option its notes belong to', () => {
  const asked: AskedQuestion = { question: 'Q', header: '版式', multiSelect: false, options: [
    { label: '瀑布流', preview: '```\nmasonry\n```' }, { label: '分组网格', preview: 'grid' }] };
  const s = readHookQuestion(shot('preview'), [asked])!;
  assert.equal(s.preview, '```\nmasonry\n```');
  assert.equal(s.input?.kind, 'notes');
  assert.equal(readHookQuestion(shot('preview'), [{ ...asked, options: asked.options.map(({ label }) => ({ label })) }])!.preview, undefined);
});

test('only an AskUserQuestion input of the expected shape is a question set', () => {
  assert.deepEqual(askedQuestions({ questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A', description: 'a' }, { label: 'B' }], multiSelect: true }] }),
    [{ question: 'Q?', header: 'H', multiSelect: true, options: [{ label: 'A', description: 'a' }, { label: 'B' }] }]);
  for (const input of [undefined, {}, { questions: [] }, { questions: [{ question: '', header: 'H', options: [{ label: 'A' }] }] },
    { questions: [{ question: 'Q', header: 'H', options: [] }] }, { questions: [{ question: 'Q', header: 'H', options: [{ label: 1 }] }] },
    { questions: [{ question: 'Q', header: 'H', options: [{ label: 'A' }], multiSelect: 'yes' }] }]) {
    assert.equal(askedQuestions(input), undefined, JSON.stringify(input));
  }
});

test('the driver reads every frame with the hook: a focus move on a cut-off dialog is proven on the next frame', async () => {
  const frame = shot('cut-off-40-rows'), down = frame.replace('❯ 1. 提交，含', '  1. 提交，含').replace('  2. 提交，只测', '❯ 2. 提交，只测');
  let current = frame;
  const keys: string[] = [];
  const driver: QuestionDriver = {
    frame: async () => ({ paneId: '%1', panePid: 10, viewport: current, nativeStatus: 'waiting', nativeWaitingFor: 'input needed' }),
    questionKey: async key => { keys.push(key); if (key === 'Down') current = down; },
    pasteQuestion: async () => { throw new Error('not expected'); },
  };
  const expected = readHookQuestion(frame, [H200])!;
  await performQuestionAction(driver, '%1', 10, expected, { kind: 'focus', number: 2 }, () => {}, [H200]);
  assert.deepEqual(keys, ['Down']);
  // Without the hook the same frame is not a question the driver may answer.
  current = frame;
  await assert.rejects(performQuestionAction(driver, '%1', 10, expected, { kind: 'focus', number: 2 }, () => {}));
});
