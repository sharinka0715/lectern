import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MessageDisplay } from '../src/core/message-display';
import { nativePromptText, samePrompt } from '../src/shared/native-prompt';
import { outgoingDelivered, startOutgoing } from '../src/renderer/outgoing-message';
import { paintBullets } from './helpers/claude-screen';

// A user report (Claude Code 2.1.330 over SSH): the prompt sent from the chat had a
// tab, which Claude Code's paste handler saves as four spaces. The "sending" bubble
// never matched its own record, so it stayed below every later turn, took each live
// screen as its preview and, after a stop, kept the "interrupted" banner up for good.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/tab-prompt-2.1.330/${name}`, import.meta.url), 'utf8');
// Taken without colours; every bullet on them is a reply, painted as Claude Code paints one (reply-rows.ts).
const painted = (name: string) => paintBullets(fixture(name), () => true);
const sessionId = '5e55107a-0000-4000-8000-000000000330';
const sent = "Add a row range from x to y, first 5 rows by default, and show name\tsize + date by default; I'll pick the other columns myself";

test('Claude Code saves pasted tabs as four spaces and CR as LF; other whitespace still counts', () => {
  assert.equal(nativePromptText(' a\tb\r\nc\rd \n'), 'a    b\nc\nd');
  assert.ok(samePrompt(sent, JSON.parse(fixture('turn-start.jsonl').split('\n')[0]).message.content));
  assert.ok(!samePrompt('hello world', 'helloworld'));
  assert.ok(!samePrompt('a  b', 'a b'));
  assert.ok(!samePrompt('a\tb', 'a b'));
});

test('a prompt sent with a tab is the turn Claude Code saved, and the next send renders after it', () => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(fixture('history.jsonl'));
  display.optimisticUser(sent);
  const sentId = display.getMessages().filter(m => m.role === 'user').at(-1)!.id;
  display.ingestScreen(painted('working.txt'), fixture('working.txt'));
  assert.equal(display.getMessages().at(-1)!.source, 'preview');

  display.ingestJsonl(fixture('turn-start.jsonl'));
  const users = () => display.getMessages().filter(m => m.role === 'user');
  assert.equal(users().length, 2, 'no second bubble for the same prompt');
  assert.equal(users()[1].id, sentId);
  assert.equal(users()[1].source, 'jsonl');
  assert.equal(users()[1].text, sent.replace('\t', '    '));

  display.ingestJsonl(fixture('turn-end.jsonl'));
  display.ingestScreen(painted('idle.txt'), fixture('idle.txt'));
  assert.equal(display.status, 'idle');
  assert.ok(display.getMessages().every(m => m.source === 'jsonl'));
  // The user pressed stop while it looked busy: nothing is left to mark interrupted.
  display.markInterrupted();
  assert.equal(display.notice, undefined);

  display.optimisticUser('Open the preview');
  display.ingestScreen(painted('next-working.txt'), fixture('next-working.txt'));
  assert.equal(display.getMessages().at(-1)!.text, 'It is already open at http://127.0.0.1:8080/.');
  display.ingestJsonl(fixture('next.jsonl'));
  const messages = display.getMessages();
  assert.deepEqual(messages.map(m => [m.role, m.source]), [
    ['user', 'jsonl'], ['assistant', 'jsonl'], ['user', 'jsonl'], ['assistant', 'jsonl'], ['user', 'jsonl'], ['assistant', 'jsonl']]);
  assert.equal(messages.at(-2)!.text, 'Open the preview');
  assert.equal(display.notice, undefined);
});

test('a send saved under an unknown text is dropped once a later send is saved', () => {
  // Any other rewrite Claude Code may apply: the unmatched bubble must not stay below
  // every later turn, keep the live preview or keep the "interrupted" banner.
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(fixture('history.jsonl'));
  display.optimisticUser(sent.replace('\t', '   '));
  display.ingestScreen(painted('working.txt'), fixture('working.txt'));
  display.ingestJsonl(fixture('turn-start.jsonl') + fixture('turn-end.jsonl'));
  display.ingestScreen(painted('idle.txt'), fixture('idle.txt'));
  display.markInterrupted();
  assert.equal(display.getMessages().at(-2)!.source, 'pending', 'unmatched, as before');
  assert.match(display.notice!, /中断/);

  display.optimisticUser('Open the preview');
  display.ingestScreen(painted('next-working.txt'), fixture('next-working.txt'));
  display.ingestJsonl(fixture('next.jsonl'));
  const messages = display.getMessages();
  assert.deepEqual(messages.filter(m => m.role === 'user').map(m => m.source), ['jsonl', 'jsonl', 'jsonl']);
  assert.equal(messages.at(-2)!.text, 'Open the preview');
  assert.equal(messages.at(-1)!.text, 'It is already open at http://127.0.0.1:8080/.');
  assert.equal(messages.at(-1)!.source, 'jsonl');
  assert.equal(display.notice, undefined);
});

test('the composer bubble of a tabbed send is delivered by the saved prompt', () => {
  const outgoing = startOutgoing('w:S', 'a\tb', [], 'outgoing:1');
  assert.equal(outgoingDelivered([{ id: 'S:turn:0:user', role: 'user', text: 'a    b', tools: [], source: 'jsonl', status: 'complete' }], outgoing), true);
  assert.equal(outgoingDelivered([{ id: 'S:turn:0:user', role: 'user', text: 'a b', tools: [], source: 'jsonl', status: 'complete' }], outgoing), false);
});
