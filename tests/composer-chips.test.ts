import test from 'node:test';
import assert from 'node:assert/strict';
import { chipInsertion, chipOrder, chipToken, chipTokens, completionEdit, displayFromDraft, draftFromDisplay, mentionCandidates, reconcileChips, removeChips, sentFromDisplay, snapSelection, type ChipSource } from '../src/renderer/composer-chips';

// A small chip table like the renderer's: one id per mention as written.
function table() {
  const mentions = new Map<number, { raw: string; path: string }>(), ids = new Map<string, number>();
  const source: ChipSource = {
    attached: path => path.startsWith('/up/'),
    idFor: (raw, path) => {
      let id = ids.get(raw);
      if (id === undefined) { id = ids.size + 1; ids.set(raw, id); mentions.set(id, { raw, path }); }
      return id;
    },
    widthFor: path => path.endsWith('.png') ? 6 : 9,
  };
  const known = (id: number) => mentions.has(id);
  const mentionOf = (id: number) => mentions.get(id)?.raw;
  const show = (text: string) => { let out = '', from = 0; for (const t of chipTokens(text, known)) { out += text.slice(from, t.start) + `[${mentions.get(t.id)!.path}]`; from = t.end; } return out + text.slice(from); };
  return { source, known, mentionOf, show, mentions };
}

test('a chip token is fixed-width figure spaces with its id hidden in tag characters', () => {
  const token = chipToken(12, 7);
  assert.equal(token.replace(/[^ ]/gu, ''), ' '.repeat(7));
  assert.deepEqual(chipTokens('ab' + token + 'cd'), [{ start: 2, end: 2 + token.length, id: 12 }]);
  // Back to back, each keeps its own spaces; a token missing a space or a tag is no token.
  const two = chipToken(1, 3) + chipToken(2, 4);
  assert.deepEqual(chipTokens(two).map(t => [t.id, two.slice(t.start, t.end) === chipToken(t.id, t.id === 1 ? 3 : 4)]), [[1, true], [2, true]]);
  assert.deepEqual(chipTokens(token.slice(0, -1)), []);
  assert.deepEqual(chipTokens(token.slice(1)), []);
  assert.deepEqual(chipTokens(token, id => id !== 12), []);
  assert.deepEqual(chipTokens('plain text'), []);
});

test('drafts become chips and come back unchanged, whatever surrounds the mentions', () => {
  const { source, mentionOf, show, known } = table();
  const drafts = [
    '', '只有文字', '看看 @/up/a.png 这张', '@/up/a.png', '@/up/a.png ', '先说明 @/up/a.png @"/up/b c.txt" ',
    '@/up/a.png\n第二行 @/up/a.png', '@"/up/a.png"引号后', '@/up/a.png"紧跟引号', '读 @src/app.ts 和 @/up/x.png，', 'mail dev@example.com @/up/a.png',
    '\t@/up/a.png\t', '@/up/a(1).png', '> 引用 @/up/a.png\n\n',
  ];
  for (const draft of drafts) {
    const display = displayFromDraft(draft, source);
    assert.equal(draftFromDisplay(display, mentionOf, known), draft, JSON.stringify(draft));
  }
  assert.equal(show(displayFromDraft('看看 @/up/a.png 这张 @src/app.ts', source)), '看看 [/up/a.png] 这张 @src/app.ts');
  // The same file written two ways keeps each way.
  assert.equal(draftFromDisplay(displayFromDraft('@"/up/a.png" @/up/a.png', source), mentionOf), '@"/up/a.png" @/up/a.png');
});

test('a chip moved against other text gets the spaces its mention needs; an uploading chip sends nothing', () => {
  const { source, mentionOf, known } = table();
  const a = chipToken(source.idFor('@/up/a.png', '/up/a.png'), 6), b = chipToken(source.idFor('@"/up/b c.txt"', '/up/b c.txt'), 9);
  assert.equal(draftFromDisplay('看' + a + '图', mentionOf, known), '看 @/up/a.png 图');
  assert.equal(draftFromDisplay(a + b, mentionOf, known), '@/up/a.png @"/up/b c.txt"');
  // After a quoted mention nothing is needed; before one a space still is.
  assert.equal(draftFromDisplay('x' + b + 'y', mentionOf, known), 'x @"/up/b c.txt"y');
  assert.equal(draftFromDisplay(a + '"quoted"', mentionOf, known), '@/up/a.png"quoted"');
  // Still uploading: left out, and the text around it is not touched.
  const pending = chipToken(99, 6);
  assert.equal(draftFromDisplay('看' + pending + '图', id => id === 99 ? undefined : mentionOf(id)), '看图');
});

test('edits keep chips whole: deleting into one removes all of it, undo and paste bring whole ones back', () => {
  const { source, known, show } = table();
  const display = displayFromDraft('看 @/up/a.png 和 @/up/b.png 吧', source);
  const [a, b] = chipTokens(display, known);
  // Typing next to a chip, or in plain text, changes nothing else.
  for (const next of [display.slice(0, a.end) + 'x' + display.slice(a.end), display.slice(0, a.start) + 'x' + display.slice(a.start), display + '！']) {
    assert.equal(reconcileChips(display, next, known).text, next);
  }
  // Backspace on a chip's last space, a word deletion into its middle, a selection ending inside it.
  const lastSpace = display.slice(0, a.end - 1) + display.slice(a.end);
  assert.equal(show(reconcileChips(display, lastSpace, known).text), '看  和 [/up/b.png] 吧');
  const intoMiddle = display.slice(0, a.start + 3) + display.slice(a.end);
  assert.equal(show(reconcileChips(display, intoMiddle, known).text), '看  和 [/up/b.png] 吧');
  const fromText = display.slice(0, 1) + 'X' + display.slice(b.start + 3);
  assert.equal(show(reconcileChips(display, fromText, known).text), '看X 吧');
  // Half a surrogate pair left by a cut is dropped too.
  assert.equal(show(reconcileChips(display, display.slice(0, 1) + 'X' + display.slice(b.start + 2), known).text), '看X 吧');
  // A character typed inside a chip (the caret never rests there) survives; the chip does not.
  const typedInside = display.slice(0, a.start + 5) + 'Q' + display.slice(a.start + 5);
  assert.equal(show(reconcileChips(display, typedInside, known).text), '看 Q 和 [/up/b.png] 吧');
  // Offsets after a removed piece move back with it.
  const result = reconcileChips(display, lastSpace, known);
  assert.equal(result.position(a.end - 1), a.start);
  assert.equal(result.position(lastSpace.length), result.text.length);
  // Undo, redo and pastes put whole tokens back: they are chips again, even next to an equal one.
  const removed = display.slice(0, a.start) + display.slice(a.end);
  assert.equal(reconcileChips(removed, display, known).text, display);
  const doubled = display.slice(0, b.end) + display.slice(b.start, b.end) + display.slice(b.end);
  assert.equal(show(reconcileChips(display, doubled, known).text), '看 [/up/a.png] 和 [/up/b.png][/up/b.png] 吧');
  const before = display.slice(0, b.start) + display.slice(a.start, a.end) + display.slice(b.start);
  assert.equal(show(reconcileChips(display, before, known).text), '看 [/up/a.png] 和 [/up/a.png][/up/b.png] 吧');
});

test('the caret steps over a chip and selections take it whole', () => {
  const token = { start: 4, end: 12, id: 1 };
  const tokens = [token];
  // Arrow right from its start lands inside: on to the end. Left from the end: back to the start.
  assert.deepEqual(snapSelection(tokens, 5, 5, [4, 4]), [12, 12]);
  assert.deepEqual(snapSelection(tokens, 11, 11, [12, 12]), [4, 4]);
  // Up/down from another line, or a click, goes to the nearer edge or the direction of travel.
  assert.deepEqual(snapSelection(tokens, 6, 6, undefined, true), [4, 4]);
  assert.deepEqual(snapSelection(tokens, 9, 9, undefined, true), [12, 12]);
  assert.deepEqual(snapSelection(tokens, 6, 6, [30, 30]), [4, 4]);
  // Ranges grow to whole chips; shrinking past one gives it up.
  assert.deepEqual(snapSelection(tokens, 0, 6, [0, 4]), [0, 12]);
  assert.deepEqual(snapSelection(tokens, 10, 20, [12, 20]), [4, 20]);
  assert.deepEqual(snapSelection(tokens, 0, 11, [0, 12]), [0, 4]);
  assert.deepEqual(snapSelection(tokens, 5, 20, [4, 20]), [12, 20]);
  assert.deepEqual(snapSelection(tokens, 6, 8, undefined, true), [4, 12]);
  assert.deepEqual(snapSelection(tokens, 2, 3), [2, 3]);
});

test('removing a file takes its chips and one space each; inserted chips are spaced like mentions', () => {
  const { source, known, show } = table();
  const display = displayFromDraft('看 @/up/a.png 和 @/up/a.png\n@/up/b.png 吧 @/up/a.png', source);
  const tokens = chipTokens(display, known);
  const aId = tokens[0].id;
  assert.equal(show(removeChips(display, tokens, t => t.id === aId)), '看 和\n[/up/b.png] 吧');
  assert.equal(show(removeChips(display, tokens, t => t.id !== aId)), '看 [/up/a.png] 和 [/up/a.png]\n吧 [/up/a.png]');
  assert.equal(chipInsertion('看图', 2, ['T']), ' T ');
  assert.equal(chipInsertion('看 图', 2, ['T', 'U']), 'T U ');
  assert.equal(chipInsertion('', 0, ['T']), 'T ');
  assert.equal(chipInsertion('a b', 1, ['T']), ' T');
});

test('files are listed once each in the order the text first names them, with all their chips', () => {
  const tokens = [5, 2, 5, 7, 3, 2].map((id, i) => ({ start: i * 10, end: i * 10 + 5, id }));
  const info: Record<number, { key: string }> = { 5: { key: '/up/b.png' }, 2: { key: 'src/notes.md' }, 7: { key: '/up/a.png' }, 3: { key: '/up/b.png' } };
  const order = chipOrder(tokens, id => info[id]);
  assert.deepEqual(order.map(item => [item.key, item.ids]), [['/up/b.png', [5, 3]], ['src/notes.md', [2]], ['/up/a.png', [7]]]);
  // Moving a.png before b.png moves its card first.
  assert.deepEqual(chipOrder([tokens[3], ...tokens], id => info[id]).map(item => item.key), ['/up/a.png', '/up/b.png', 'src/notes.md']);
});

test('a file picked from the @ list replaces the mention typed so far with its chip and one space', () => {
  const chip = chipToken(4, 5);
  // At the end: the chip and a space, the caret after them.
  let edit = completionEdit('读 @sr', 2, 5, chip);
  assert.deepEqual([edit.insertion, edit.caret], [chip + ' ', 2 + chip.length + 1]);
  // Mid-text with a space already there: no second space, the caret past it.
  edit = completionEdit('读 @fo 然后', 2, 5, chip);
  assert.deepEqual([edit.insertion, edit.caret], [chip, 2 + chip.length + 1]);
  // Against the next word: a space keeps them apart.
  edit = completionEdit('@a.t然后', 0, 4, chip);
  assert.equal(edit.insertion, chip + ' ');
  // Applied: the same text as completing the mention as words, with the chip in its place.
  const text = '读 @fo 然后', at = completionEdit(text, 2, 5, chip);
  assert.equal(text.slice(0, at.start) + at.insertion + text.slice(at.end), '读 ' + chip + ' 然后');
});

test('a draft put back turns known files into chips; other mentions are checked once, typed ones never', () => {
  const { source, mentionOf, known, show } = table();
  const draft = '看 @/up/a.png 和 @src/app.ts ，以及 @"docs/my notes.md" 还有 @src/ @src/app.ts @agent-reviewer dev@example.com';
  // Attachments are chips at once; the rest (each once, no folders) go to the reference check.
  assert.equal(show(displayFromDraft(draft, source)), '看 [/up/a.png] 和 @src/app.ts ，以及 @"docs/my notes.md" 还有 @src/ @src/app.ts @agent-reviewer dev@example.com');
  assert.deepEqual(mentionCandidates(draft, source.attached), ['src/app.ts', 'docs/my notes.md', 'agent-reviewer']);
  // What the check found becomes chips too, and the draft still comes back unchanged.
  const found = new Set(['src/app.ts', 'docs/my notes.md']);
  const checked: ChipSource = { ...source, attached: path => source.attached(path) || found.has(path) };
  const display = displayFromDraft(draft, checked);
  assert.equal(show(display), '看 [/up/a.png] 和 [src/app.ts] ，以及 [docs/my notes.md] 还有 @src/ [src/app.ts] @agent-reviewer dev@example.com');
  assert.equal(draftFromDisplay(display, mentionOf, known), draft);
  assert.deepEqual(mentionCandidates(draft, checked.attached), ['agent-reviewer']);
});

test('after a cd, chips of folder files are sent as absolute paths; typed mentions and attachments as written', () => {
  const { source, mentionOf, known, mentions } = table();
  const chip = (path: string) => source.attached(path) || ['src/app.ts', 'my notes.md'].includes(path);
  const draft = '看 @src/app.ts 和 @"my notes.md"，附件 @/up/a.png，手打的 @typed.ts';
  const display = displayFromDraft(draft, { ...source, attached: chip });
  const pathOf = (id: number) => mentions.get(id)?.path;
  assert.equal(sentFromDisplay(display, mentionOf, pathOf, '/home/dev/project', known),
    '看 @/home/dev/project/src/app.ts 和 @"/home/dev/project/my notes.md"，附件 @/up/a.png，手打的 @typed.ts');
  // The box still shows the same chips and keeps the draft as written.
  assert.equal(draftFromDisplay(display, mentionOf, known), draft);
});
