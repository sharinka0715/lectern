import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FADE_ENTER_MS, FADE_LEAVE_MS, MAX_LEAVING, planFades, type FadeRecord, type FadeRules } from '../src/renderer/content-fade';

// A stand-in for DOM nodes: a name, a kind, and where the node is after the batch.
interface Item { name: string; kind: 'list' | 'message' | 'block' | 'inline' | 'placeholder'; role?: string; parent: Item | null }
const item = (name: string, kind: Item['kind'], parent: Item | null = null, role?: string): Item => ({ name, kind, parent, role });
const rules: FadeRules<Item> = {
  enters: node => node.kind !== 'inline',
  leaves: (node, parent) => node.kind === 'message' && parent.kind === 'list' ? 'collapse' : undefined,
  pairKey: (node, parent) => parent.kind === 'list' ? (node.kind === 'message' ? `message:${node.role}` : undefined) : 'block',
  placeholder: node => node.kind === 'placeholder',
  parentOf: node => node.parent,
};
const names = (nodes: Item[]) => nodes.map(node => node.name);
const removal = (node: Item, previous: Item | null = null, next: Item | null = null) => ({ node, previous, next });

test('appended messages and blocks fade in when the batch is live, not when it is quiet', () => {
  const list = item('list', 'list'), reply = item('reply', 'block');
  const message = item('m2', 'message', list, 'assistant'), paragraph = item('p3', 'block', reply), bold = item('strong', 'inline', paragraph);
  const records: FadeRecord<Item>[] = [{ target: list, added: [message], removed: [] }, { target: reply, added: [paragraph], removed: [] },
    { target: paragraph, added: [bold], removed: [] }];
  assert.deepEqual(names(planFades(records, rules, true).enter), ['m2', 'p3'], 'an inline element inside a paragraph is not a block');
  assert.deepEqual(planFades(records, rules, false), { enter: [], leave: [] });
});

test('an addition taking a removed element\'s place changes in place; what comes after it is new', () => {
  const list = item('list', 'list'), reply = item('reply', 'block');
  // The paragraph that became a list, and a paragraph streamed after it.
  const paragraph = item('p3', 'block'), ordered = item('ol', 'block', reply), next = item('p4', 'block', reply);
  const blocks = planFades([{ target: reply, added: [], removed: [removal(paragraph)] }, { target: reply, added: [ordered, next], removed: [] }], rules, true);
  assert.deepEqual(names(blocks.enter), ['p4']);
  // The "sending" bubble and the saved one are one user message; the reply that came with it is new.
  const sending = item('outgoing', 'message', null, 'user'), saved = item('turn:1:user', 'message', list, 'user');
  const reply1 = item('turn:1:assistant', 'message', list, 'assistant');
  const messages = planFades([{ target: list, added: [], removed: [removal(sending, item('turn:0', 'message', list, 'assistant'))] },
    { target: list, added: [saved, reply1], removed: [] }], rules, true);
  assert.deepEqual(names(messages.enter), ['turn:1:assistant']);
  assert.deepEqual(messages.leave, [], 'the sending bubble does not fade out under the saved one');
});

test('what replaces a placeholder is new, and the placeholder leaves at once', () => {
  const content = item('content', 'block'), waiting = item('waiting', 'placeholder'), first = item('p0', 'block', content);
  const plan = planFades([{ target: content, added: [], removed: [removal(waiting)] }, { target: content, added: [first], removed: [] }], rules, true);
  assert.deepEqual(names(plan.enter), ['p0']);
  assert.deepEqual(plan.leave, []);
});

test('a moved element and one that came and went in the same batch do not fade', () => {
  const list = item('list', 'list'), moved = item('m1', 'message', list, 'user'), passing = item('m9', 'message', null, 'user');
  const plan = planFades([
    { target: list, added: [], removed: [removal(moved)] }, { target: list, added: [moved], removed: [] },
    { target: list, added: [passing], removed: [] }, { target: list, added: [], removed: [removal(passing)] },
  ], rules, true);
  assert.deepEqual(plan, { enter: [], leave: [] });
});

test('removed messages fade out where they were, in their order; many at once go at once', () => {
  const list = item('list', 'list'), kept = item('turn:0:assistant', 'message', list, 'assistant'), end = item('end', 'block', list);
  const user = item('turn:1:user', 'message', null, 'user'), reply = item('turn:1:assistant', 'message', null, 'assistant');
  const plan = planFades([{ target: list, added: [], removed: [removal(user, kept, reply)] }, { target: list, added: [], removed: [removal(reply, kept, end)] }], rules, true);
  assert.deepEqual(plan.leave.map(leave => [leave.node.name, leave.previous?.name, leave.next?.name, leave.mode, leave.parent.name]),
    [['turn:1:user', 'turn:0:assistant', 'turn:1:assistant', 'collapse', 'list'], ['turn:1:assistant', 'turn:0:assistant', 'end', 'collapse', 'list']]);
  assert.deepEqual(planFades([{ target: list, added: [], removed: [removal(user, kept, reply)] }], rules, false).leave, [], 'quiet: removed at once');
  const many = Array.from({ length: MAX_LEAVING + 1 }, (_, i) => removal(item(`turn:${i}`, 'message', null, 'user'), kept, end));
  assert.deepEqual(planFades([{ target: list, added: [], removed: many }], rules, true).leave, []);
  const some = many.slice(0, MAX_LEAVING);
  assert.equal(planFades([{ target: list, added: [], removed: some }], rules, true).leave.length, MAX_LEAVING);
});

test('a removal pairs only with an addition under the same parent and with the same key', () => {
  const list = item('list', 'list'), user = item('old-user', 'message', null, 'user'), reply = item('new-reply', 'message', list, 'assistant');
  const plan = planFades([{ target: list, added: [reply], removed: [removal(user)] }], rules, true);
  assert.deepEqual(names(plan.enter), ['new-reply']);
  assert.deepEqual(plan.leave.map(leave => leave.node.name), ['old-user']);
  // Blocks of another reply do not stand in for each other.
  const a = item('a', 'block'), b = item('b', 'block'), gone = item('gone', 'block'), came = item('came', 'block', b);
  assert.deepEqual(names(planFades([{ target: a, added: [], removed: [removal(gone)] }, { target: b, added: [came], removed: [] }], rules, true).enter), ['came']);
});

test('the stylesheet fades for as long as the code waits', () => {
  const css = readFileSync(new URL('../src/renderer/content-fade.css', import.meta.url), 'utf8');
  assert.match(css, new RegExp(`\\[data-fade="in"\\] \\{ animation: lectern-fade-in ${FADE_ENTER_MS}ms `));
  assert.match(css, new RegExp(`\\[data-leaving\\] \\{ pointer-events: none; animation: lectern-fade-out ${FADE_LEAVE_MS}ms `));
  // Reduced motion: no rule of its own; nothing gets the attributes (styles.css also stops all animation).
  assert.doesNotMatch(css, /prefers-reduced-motion/);
});
