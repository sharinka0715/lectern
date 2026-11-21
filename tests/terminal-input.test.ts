import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTyping, paintFrame, typedInput, TerminalInputQueue, type LeasedInput } from '../src/renderer/terminal-input';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('xterm keyboard and IME data use named native keys or bounded printable UTF-8', () => {
  const keys = { '\r': 'Enter', '\x1b': 'Escape', ' ': 'Space', '\t': 'Tab', '\x1b[Z': 'BTab', '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left', '\x7f': 'Backspace', '\x1b[3~': 'Delete', '\x1b[H': 'Home', '\x1b[F': 'End', '\x1b[5~': 'PageUp', '\x1b[6~': 'PageDown' };
  for (const [sequence, key] of Object.entries(keys)) assert.deepEqual(typedInput(sequence), {type:'key', key});
  for (const key of 'abcdefgklnpruwy') assert.deepEqual(typedInput(String.fromCharCode(key.charCodeAt(0)-96)), {type:'key', key:`C-${key}`});
  for (const text of ['s1;','👨‍👩‍👧‍👦','汉语🧭','á']) assert.deepEqual(typedInput(text), {type:'literal',text});
  for (const data of ['', '\x1b[200~', '\x9b', '\x00', '\ud800', 'x'.repeat(1025)]) assert.equal(typedInput(data), undefined);
});

test('terminal repaint permits only text, SGR and the sampled cursor', () => {
  const ansi = '\x1b[38;2;1;2;3m界\x1b[0m\n\x1b]52;c;SECRETDATA\x07\x1b[6n\x1b[?1000h\x1bPignored\x1b\\end';
  assert.equal(paintFrame({ paneId: '%9', ansi, rows: 2, cols: 40, cursorX: 2, cursorY: 1, cursorVisible: true }), '\x1b[?7l\x1b[0m\x1b[2J\x1b[H\x1b[38;2;1;2;3m界\x1b[0m\r\nend\x1b[0m\x1b[2;3H\x1b[?25h');
});

test('coalescing slow SSH typing cannot cross a key, paste or ownership boundary', async () => {
  const gate = deferred(), sent: LeasedInput[] = [];
  const queue = new TerminalInputQueue<LeasedInput>(async item => { sent.push(item); await gate.promise; }, () => {}, e => { throw e; }, 64, mergeTyping);
  for (const text of ['x', '你', '好', '\r', 'A']) void queue.enqueue({token:'one', input:typedInput(text)!});
  void queue.enqueue({token:'two',input:typedInput('B')!});
  void queue.enqueue({token:'two',input:{type:'text',text:'paste'}});
  void queue.enqueue({token:'two',input:typedInput('C')!});
  gate.resolve(); await queue.whenIdle();
  assert.deepEqual(sent.map(({input}) => input.type === 'key' ? input.key : input.text), ['x','你好','Enter','A','B','paste','C']);
});

test('rapid terminal events run once in order with the token captured by each event', async () => {
  const first = deferred(); const sent: Array<{ token: string; value: string }> = []; const counts: number[] = [];
  const queue = new TerminalInputQueue<{ token: string; value: string }>(async item => { sent.push(item); if (sent.length === 1) await first.promise; }, count => counts.push(count), error => { throw error; });
  const a = queue.enqueue({ token: 'lease-a', value: '中文\ntext' });
  const b = queue.enqueue({ token: 'lease-a', value: 'Enter' });
  const c = queue.enqueue({ token: 'lease-b', value: 'Space' });
  assert.equal(sent.length, 1); assert.equal(counts.at(-1), 3);
  first.resolve(); assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  assert.deepEqual(sent.map(item => `${item.token}:${item.value}`), ['lease-a:中文\ntext', 'lease-a:Enter', 'lease-b:Space']);
  await queue.whenIdle(); assert.equal(counts.at(-1), 0);
});

test('a failed input cancels queued operations without automatically retrying', async () => {
  const gate = deferred(); const sent: string[] = []; const failures: Array<{ error: unknown; discarded: number }> = [];
  const queue = new TerminalInputQueue<string>(async value => { sent.push(value); if (value === 'fails') { await gate.promise; throw new Error('ambiguous result'); } }, () => {}, (error, discarded) => failures.push({ error, discarded }));
  const a = queue.enqueue('fails'), b = queue.enqueue('must-not-send'), c = queue.enqueue('also-canceled');
  gate.resolve(); assert.deepEqual(await Promise.all([a, b, c]), [false, false, false]);
  assert.deepEqual(sent, ['fails']); assert.equal(failures.length, 1); assert.equal(failures[0].discarded, 2);
  assert.equal(await queue.enqueue('explicit-new-input'), true); assert.deepEqual(sent, ['fails', 'explicit-new-input']);
});

test('releasing cancels unsent inputs and waits for the active request; disposal sends nothing further', async () => {
  const gate = deferred(); const sent: number[] = [];
  const queue = new TerminalInputQueue<number>(async value => { sent.push(value); await gate.promise; }, () => {}, () => {});
  const first = queue.enqueue(1), next = queue.enqueue(2); let idle = false;
  assert.equal(queue.cancelPending(), 1); void queue.whenIdle().then(() => { idle = true; });
  await tick(); assert.equal(idle, false); assert.equal(await next, false);
  gate.resolve(); assert.equal(await first, true); await queue.whenIdle(); assert.equal(idle, true);
  queue.dispose(); assert.equal(await queue.enqueue(3), false); assert.deepEqual(sent, [1]);
});

test('terminal queue bounds bursts instead of silently sending unbounded input', async () => {
  const gate = deferred(); let errors = 0;
  const queue = new TerminalInputQueue<number>(async () => { await gate.promise; }, () => {}, () => { errors++; }, 2);
  const a = queue.enqueue(1), b = queue.enqueue(2);
  assert.equal(await queue.enqueue(3), false); assert.equal(errors, 1);
  gate.resolve(); assert.deepEqual(await Promise.all([a, b]), [true, false]);
});
