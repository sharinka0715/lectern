import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuestionScreen } from '../src/core/question-screen';
import { LATE_QUESTION_MS, answeredQuestionId, earlyQuestion, observeQuestion, ownQuestion, pendingQuestionId, questionSet } from '../src/main/session-question';
import type { SessionSettingsHandle } from '../src/main/session-settings-cache';
import type { ChatMessage } from '../src/shared/types';

// Real frames (cc-matrix sandbox, a reply text then the call, the stream ending 3 s later): the
// transcript has no call for these questions while they are on screen (2.1.300 and 2.1.330 alike).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/question-early/${name}.txt`, import.meta.url), 'utf8');
const single = fixture('2.1.330-single'), multi = fixture('2.1.300-multi');
const evidence = { pendingToolUse: true } as const;

test('a question under reply text is read only with evidence that Claude Code asks it', () => {
  for (const frame of [single, multi, fixture('2.1.300-single'), fixture('2.1.330-multi')]) {
    assert.equal(parseQuestionScreen(frame), undefined, 'reply text above: the text alone proves nothing');
    assert.equal(parseQuestionScreen(frame, evidence)?.question, 'Which drink should we serve?');
  }
  assert.deepEqual(parseQuestionScreen(multi, evidence)!.tabs.map(tab => tab.label), ['Drink', 'Snacks']);
  // A menu in the reply with the input box below it, or in a code block, is never Claude Code's dialog.
  const rule = '─'.repeat(120);
  assert.equal(parseQuestionScreen(`${single.trimEnd()}\n\n${rule}\n❯ \n${rule}\n  ? for shortcuts`, evidence), undefined);
  const at = single.indexOf('────');
  assert.equal(parseQuestionScreen(single.slice(0, at) + '● The menu looks like this:\n```\n' + single.slice(at), evidence), undefined);
});

test('before the transcript has the call: a card only while Claude Code waits for an answer', () => {
  const screen = parseQuestionScreen(single, evidence)!;
  assert.equal(earlyQuestion(screen, 'waiting', 'input needed', undefined, 0), true);
  for (const [status, waitingFor] of [['waiting', 'permission prompt'], ['waiting', 'dialog open'], ['waiting', undefined],
    ['busy', undefined], ['idle', undefined], [undefined, undefined], ['busy', 'input needed']] as const)
    assert.equal(earlyQuestion(screen, status, waitingFor, undefined, 0), false, `${status}/${waitingFor}`);
});

test('a question seen with its call, or answered from a card, is a late frame while it stays up, for a while', () => {
  const first = parseQuestionScreen(multi, evidence)!, other = parseQuestionScreen(single, evidence)!;
  // Seen with its call, then on screen without it (its result arrived): not a new question.
  let owned = ownQuestion(undefined, first, 'toolu_q', undefined, 1000);
  assert.deepEqual(owned, { set: questionSet(first), at: 1000 });
  owned = ownQuestion(owned, first, undefined, undefined, 1200);
  assert.equal(earlyQuestion(first, 'waiting', 'input needed', owned, 1200), false);
  // The same questions asked again long after are asked again (the model may repeat itself).
  assert.equal(earlyQuestion(first, 'waiting', 'input needed', owned, 1000 + LATE_QUESTION_MS), true);
  // Another question, or none on screen, ends it.
  assert.equal(ownQuestion(owned, other, undefined, undefined, 1300), undefined);
  assert.equal(ownQuestion(owned, undefined, undefined, undefined, 1300), undefined);
  // Read off the screen alone and answered: the call comes together with its result.
  owned = ownQuestion(undefined, first, undefined, first, 5000);
  assert.equal(earlyQuestion(first, 'waiting', 'input needed', owned, 5100), false);
  assert.equal(ownQuestion(undefined, other, undefined, first, 5000), undefined, 'the next question is not the answered one');
});

test('a card read off the screen alone keeps its token and identity when its call shows up', () => {
  const handle = {} as SessionSettingsHandle, other = {} as SessionSettingsHandle;
  const screen = parseQuestionScreen(multi, evidence)!;
  const first = observeQuestion(undefined, screen, handle, undefined, { inode: '1', offset: 10 });
  assert.equal(first.snapshot.toolUseId, undefined);
  assert.equal(observeQuestion(first, screen, handle, undefined, { inode: '1', offset: 10 }), first);
  const owned = observeQuestion(first, screen, handle, 'toolu_q', { inode: '1', offset: 90 });
  assert.equal(owned, first);
  assert.deepEqual([owned.snapshot.token, owned.snapshot.interactionId, owned.snapshot.toolUseId, owned.position],
    [first.snapshot.token, first.snapshot.interactionId, 'toolu_q', { inode: '1', offset: 90 }]);
  // Another frame of the same questions is a new token on the same card; once owned, it keeps its call.
  const page = parseQuestionScreen(multi.replace('❯ 1. Tea', '  1. Tea').replace('  2. Juice', '❯ 2. Juice'), evidence)!;
  const moved = observeQuestion(owned, page, handle, 'toolu_q');
  assert.notEqual(moved.snapshot.token, owned.snapshot.token);
  assert.equal(moved.snapshot.interactionId, owned.snapshot.interactionId);
  // Without its call: other questions, or another pane, are another card.
  const early = observeQuestion(undefined, screen, handle, undefined);
  assert.notEqual(observeQuestion(early, parseQuestionScreen(single, evidence)!, handle, undefined).snapshot.interactionId, early.snapshot.interactionId);
  assert.notEqual(observeQuestion(early, screen, other, undefined).snapshot.interactionId, early.snapshot.interactionId);
  // A card owned by its call is never handed to a screen without one.
  assert.notEqual(observeQuestion(moved, page, handle, undefined).snapshot.interactionId, moved.snapshot.interactionId);
});

test('the current turn\'s pending and newest answered questions', () => {
  const tool = (id: string, answered: boolean) => ({ id, name: 'AskUserQuestion', input: '{}', ...(answered ? { result: '{}' } : {}) });
  const message = (role: ChatMessage['role'], tools: unknown[], source: ChatMessage['source'] = 'jsonl') =>
    ({ id: Math.random().toString(), role, text: '', tools, source, status: 'complete' }) as ChatMessage;
  const older = [message('user', []), message('assistant', [tool('old', true)])];
  assert.equal(answeredQuestionId(older), 'old');
  const turn = [...older, message('user', []), message('assistant', [tool('q1', true), tool('q2', true)])];
  assert.equal(answeredQuestionId(turn), 'q2');
  assert.equal(pendingQuestionId(turn), undefined);
  assert.equal(answeredQuestionId([...older, message('user', []), message('assistant', [])]), undefined, 'an earlier turn does not count');
  assert.equal(answeredQuestionId([...turn, message('user', [], 'pending')]), 'q2', 'a send not yet in the transcript is no new turn');
  assert.equal(pendingQuestionId([...older, message('user', []), message('assistant', [tool('q3', false)])]), 'q3');
});
