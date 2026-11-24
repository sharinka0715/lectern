import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { askedQuestions, readHookQuestion } from '../src/core/question-hook';
import { parseQuestionScreen } from '../src/core/question-screen';
import { stripTerminalEscapes } from '../src/core/screen';
import type { NativeQuestionOption } from '../src/shared/native-question';

const versions = ['2.1.300', '2.1.310', '2.1.321', '2.1.326', '2.1.329', '2.1.331'];
const fixture = (version: string, name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/question-preview-multi-${version}/${name}.json`, import.meta.url), 'utf8'));
type Frame = { screen: string; tabs?: string };
const styled = ({ screen, tabs }: Frame) => tabs ? screen.replace(stripTerminalEscapes(tabs), tabs) : screen;
const compact = (value = '') => value.replace(/\s+/gu, '');
const evidence = { pendingToolUse: true } as const;
const focused = (options: NativeQuestionOption[]) => options.find(option => option.focused)?.number;

for (const version of versions) test(`mixed preview forms captured from Claude Code ${version}`, () => {
  const asked = askedQuestions(fixture(version, 'tool-input'))!;
  for (const width of [80, 120, 160, 200]) for (const named of [true, false]) {
    const name = `${named ? 'named' : 'unnamed'}-${width}`;
    const frames = fixture(version, name) as Record<string, Frame>;
    for (const [id, frame] of Object.entries(frames)) {
      if (id === 'submitted') continue;
      const viewport = styled(frame);
      const screen = parseQuestionScreen(viewport, evidence);
      const hook = readHookQuestion(viewport, asked);
      const context = `${name}/${id}`;
      assert.ok(screen, context);
      assert.ok(hook, context);
      assert.ok(parseQuestionScreen(frame.screen, evidence), `${context} without colors`);
      assert.deepEqual(screen.tabs.map(tab => tab.label), asked.map(q => q.header), context);
      assert.deepEqual(hook.tabs, screen.tabs, context);
      assert.equal(hook.activeTab, screen.activeTab, context);
      assert.equal(focused(hook.options), focused(screen.options), context);
      assert.deepEqual(hook.input, screen.input, context);
      if (screen.kind === 'question') {
        const question = asked[screen.activeTab!];
        assert.ok(question, context);
        assert.equal(compact(screen.question), compact(question.question), context);
        assert.equal(hook.question, question.question, context);
        assert.deepEqual(screen.options.filter(o => o.kind === 'choice').map(o => o.label), question.options.map(o => o.label), context);
        if (screen.input?.kind === 'notes') {
          assert.equal(hook.preview, question.options[screen.input.number - 1].preview, context);
          assert.equal(screen.preview?.split('\n').length, 11, context);
          assert.equal(compact(screen.preview), compact(hook.preview), context);
          assert.equal(hook.options[0].description, question.options[0].description, context);
        } else {
          assert.deepEqual(screen.options.filter(o => o.kind === 'choice').map(o => compact(o.description)),
            question.options.map(o => compact(o.description)), context);
        }
      }
    }
    const screen = (frame: string) => parseQuestionScreen(styled(frames[frame]), evidence)!;
    assert.deepEqual(['first', 'second', 'third'].map(id => screen(id).activeTab), [0, 1, 2], name);
    assert.deepEqual(['second', 'second-option-2', 'second-option-3'].map(id => focused(screen(id).options)), [1, 2, 3], name);
    assert.deepEqual(screen('notes').input, { kind: 'notes', number: 3, value: '', focused: true }, name);
    assert.deepEqual(screen('notes-typed').input, { kind: 'notes', number: 3, value: 'Sample note', focused: true }, name);
    assert.equal(screen('notes-escape').input?.focused, false, name);
    assert.deepEqual(screen('custom-typed').input, { kind: 'other', number: 4, value: 'Sample custom answer', focused: true }, name);
    assert.deepEqual(screen('second-after-first-answer').tabs.map(tab => tab.answered), [true, false, false], name);
    assert.equal(screen('first-answered').options[0].checked, true, name);
    assert.equal(screen('second-answered').options[1].checked, true, name);
    assert.equal(screen('review').activeTab, 3, name);
    assert.deepEqual(screen('review').review?.map(row => compact(row.question)), asked.map(q => compact(q.question)), name);
    assert.deepEqual(screen('review').review?.map(row => row.answer), asked.map((q, i) => q.options[i ? 1 : 0].label), name);
  }
});

test('the hook can read a clipped preview or review while its identifying rows remain', () => {
  const version = '2.1.331', asked = askedQuestions(fixture(version, 'tool-input'))!;
  const frames = fixture(version, 'named-80') as Record<string, Frame>;
  const clipped = fixture(version, 'clipped-80') as Record<string, { second: Frame; review: Frame }>;
  for (const { second, review } of Object.values(clipped)) {
    const preview = styled(second);
    assert.match(parseQuestionScreen(preview, evidence)?.preview ?? '', /\d+ lines hidden/);
    assert.equal(readHookQuestion(preview, asked)?.preview, asked[1].options[0].preview);
    assert.equal(parseQuestionScreen(styled(review), evidence), undefined);
    assert.deepEqual(readHookQuestion(styled(review), asked)?.review?.map(row => row.question), asked.map(q => q.question));
  }
  const preview = frames['second-answered'].screen;
  const cut = preview.slice(preview.indexOf('❯   放到')).split('\n');
  // A cut above the options keeps the preview box and all three labels.
  const box = preview.slice(preview.lastIndexOf('\n  1. 放在', preview.indexOf('❯   放到')) + 1);
  assert.equal(parseQuestionScreen(box, evidence), undefined);
  const hooked = readHookQuestion(box.replace('\nEnter to select', '\n ↑ 10 more lines\nEnter to select'), asked);
  assert.equal(hooked?.activeTab, 1);
  assert.equal(hooked?.options[1].checked, true);
  assert.equal(hooked?.preview, asked[1].options[1].preview);
  assert.equal(readHookQuestion(cut.join('\n'), asked), undefined);

  const review = frames.review.screen.slice(frames.review.screen.indexOf('Review your answers'));
  assert.equal(parseQuestionScreen(review, evidence), undefined);
  assert.deepEqual(readHookQuestion(review, asked)?.review?.map(row => row.question), asked.map(q => q.question));
  assert.equal(readHookQuestion(review.replace('多个示例列表应该用哪种方式合并？', '这是另一次问答吗？'), asked), undefined);
});

test('response examples and broken preview frames do not become question cards', () => {
  const version = '2.1.331', asked = askedQuestions(fixture(version, 'tool-input'))!;
  const { screen } = fixture(version, 'named-120').second as Frame;
  const slice = screen.slice(screen.indexOf('─'.repeat(120)));
  assert.equal(parseQuestionScreen('● Example of the chooser\n' + slice), undefined);
  const fenced = '● Example of the chooser\n```text\n' + slice;
  assert.equal(parseQuestionScreen(fenced, evidence), undefined);
  assert.equal(readHookQuestion(fenced, asked), undefined);
  assert.equal(readHookQuestion('● Example\n```text\n' + slice.slice(slice.indexOf('❯ 1.')), asked), undefined);
  assert.equal(parseQuestionScreen(slice + '\n❯ New message', evidence), undefined);
  assert.equal(parseQuestionScreen(slice.replace('│ +--------------------------+', ' │ +--------------------------+'), evidence), undefined);
});
