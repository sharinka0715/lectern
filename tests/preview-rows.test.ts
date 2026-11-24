import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPreview, stripTerminalEscapes } from '../src/core/screen';
import { MessageDisplay } from '../src/core/message-display';
import { styledRows } from '../src/core/screen-styles';
import { CALL, CALL_BLINK, DONE, REPLY, said } from './helpers/claude-screen';

// Real screens of Claude Code around a reply while background work runs, taken as Lectern takes
// them (capture-pane -p -J -e -S -2000) by scripts/cc-matrix/probe-preview-rows.mjs, the command in
// `source`: subagents and a background shell launched, a notice, folded and running commands (in
// both frames of the blinking bullet), file tools with a diff, "Waiting for N background agents to
// finish", a subagent's "Message from @general-purpose", notifications, and a reply with Markdown of
// every kind whose prose quotes those rows; at 16 colours (tmux's default "screen") and 256
// (tmux-256color), dark and light. `reply` is what the preview reads off each, checked by hand;
// `transcript` the reply's text as saved. The 2.1.331 sample keeps the transcript's records
// (request shapes and listings left out; `samples[].records` were written at the capture) and the
// capture without -e (`plain`), taken in the same tmux command list.
interface Sample { name: string; rows: string; frame: number; records: number; screen: string; plain?: string; reply: string }
interface Fixture { source: string; version: string; colors: string; theme: string; prompt: string; samples: Sample[]; transcript: string; records: Record<string, any>[] }
const labels = ['2.1.300', '2.1.330', '2.1.331', '2.1.300-256', '2.1.331-256', '2.1.331-256-light', '2.1.331-light'];
const fixtures = labels.map(label => JSON.parse(readFileSync(new URL(`./fixtures/preview-${label}/samples.json`, import.meta.url), 'utf8')) as Fixture);
// The screen shows Markdown rendered: compare without its marks, box drawing and spaces.
const bare = (text: string) => text.normalize('NFC').replace(/[\s*_`#>[\]()|│┌┬┐├┼┤└┴┘─▎-]/gu, '');
// The rows around the reply on these screens (the reply's own prose quotes some, differently).
const around = /^(?:✻ Waiting for [13] background agents? to finish|› Message from @general-purpose.*|Ran [12] shell commands?|Running [123] (?:shell commands?|agents)…|Agent "(?:Quick|Messenger|Long) helper" finished.*|Background command .*|Monitor event: .*|Monitor "Tick watcher" stream ended|[13] background agents launched.*|Thought for \d+s|Auto mode lets Claude.*|Short wait.*|(?:Write|Update|Read)\(notes\.txt\)|.*Tip: .*)\s*$/mu;

test("real screens (2.1.300, 2.1.330, 2.1.331; 16 and 256 colours; dark and light): only the reply's prose is read", () => {
  for (const fixture of fixtures) {
    const known = bare(fixture.transcript);
    for (const sample of fixture.samples) {
      const label = `${fixture.version} ${fixture.colors} ${fixture.theme} ${sample.name}`;
      // Most frames no longer show the prompt (Claude Code redraws the screen): a prompt row on top reads it all.
      const read = (screen: string) => extractPreview(`❯ ${fixture.prompt}\n${screen}`, fixture.prompt).text;
      const text = read(sample.screen);
      assert.equal(text, sample.reply, label);
      if (!sample.name.includes('rich')) assert.doesNotMatch(text, around, label);
      for (const line of text.split('\n')) assert.ok(known.includes(bare(line)), `${label}: ${JSON.stringify(line)} is not in the transcript`);
      // The same capture without colours confirms nothing: no text rather than a guess. It is the
      // plain capture to the character (Lectern reads -e and strips it for everything else).
      if (sample.plain !== undefined) assert.equal(stripTerminalEscapes(sample.screen), sample.plain, label);
      assert.equal(read(stripTerminalEscapes(sample.screen)), '', `${label} without colours`);
    }
  }
});

test('those screens do hold the rows around the reply, which the plain text cannot tell from it', () => {
  for (const fixture of fixtures) for (const sample of fixture.samples.filter(sample => !/rich|done/.test(sample.name))) {
    const rows = stripTerminalEscapes(sample.screen).split('\n').map(row => row.replace(/^[●⏺✻›]?\s*/u, '')).join('\n');
    assert.match(rows, around, `${fixture.version} ${fixture.colors} ${sample.name}`);
  }
  // The light theme at 16 colours writes its green black like the reply's bullet: nothing is confirmed.
  for (const sample of fixtures.find(fixture => fixture.theme === 'light' && fixture.colors === '16')!.samples) assert.equal(sample.reply, '', sample.name);
  // The reported rows on one screen; "Ran 1 shell command" two columns in, as a reply's row would be.
  const shot = fixtures.find(fixture => fixture.version === '2.1.331' && fixture.colors === '16')!.samples.find(sample => sample.name.includes('screenshot'))!;
  const plain = stripTerminalEscapes(shot.screen);
  for (const row of [/^✻ Waiting for \d+ background agents? to finish/m, /^› Message from @general-purpose \(ctrl\+o to expand\)/m, /^ {2}Ran 1 shell command\s*$/m, /^● Agent "\w+ helper" finished · \d+s/m])
    assert.match(plain, row);
});

test('real screens through the chat: the reply shows nothing of the rows around it, frame after frame', () => {
  for (const fixture of fixtures.filter(fixture => fixture.records.length)) {
    const known = bare(fixture.transcript);
    const display = new MessageDisplay(fixture.records.find(row => row.sessionId)!.sessionId);
    let written = 0;
    for (const sample of [...fixture.samples].sort((a, b) => a.frame - b.frame)) {
      display.ingestJsonl(fixture.records.slice(written, sample.records).map(row => JSON.stringify(row) + '\n').join(''));
      written = sample.records;
      display.ingestScreen(sample.screen);
      const reply = display.getMessages().filter(message => message.role === 'assistant').at(-1);
      for (const line of reply?.text.split('\n') ?? []) assert.ok(known.includes(bare(line)), `${fixture.version} ${sample.name}: ${JSON.stringify(line)}`);
    }
  }
});

const box = '────────────────────\n❯ \n────────────────────\n';
const read = (rows: string) => extractPreview(`❯ Explain\n${rows}\n✻ Thinking… (esc to interrupt)\n${box}`, 'Explain').text;

test("a reply's bullet is the theme's text colour at any colour depth; any other look is not a reply", () => {
  // Dark at 16 colours; dark and light at 256 (and 24-bit, which Claude Code does not use in tmux).
  for (const fg of ['97', '38;5;231', '38;5;16', '38;2;255;255;255', '38;2;0;0;0'])
    assert.equal(read(`\x1b[${fg}m●\x1b[39m The reply.\n  Its second row.`), 'The reply.\nIts second row.', fg);
  // Green and red (finished calls, notifications), grey (notices), dim (a running call), bold, inverse,
  // a background, the default colour: none confirms a reply; neither does a plain capture, nor black
  // at 16 colours, which the light theme writes for its green as well.
  for (const bullet of ['\x1b[30m●\x1b[39m', '\x1b[32m●\x1b[39m', '\x1b[31m●\x1b[39m', '\x1b[37m●\x1b[39m', CALL, '\x1b[1;97m●\x1b[0m', '\x1b[7;97m●\x1b[0m', '\x1b[97;44m●\x1b[0m', '●'])
    assert.equal(read(`${bullet} Not a reply.\n  Nor this row.`), '', JSON.stringify(bullet));
  assert.equal(read(`${DONE} Agent "Fix content-fade e2e flake" finished\x1b[2m · 2h 12m 19s\x1b[0m`), '');
});

test('a running call in the blank frame of its blinking bullet is not a row of the reply above it', () => {
  for (const bullet of [CALL, CALL_BLINK]) {
    const rows = `${said('Checking the build.')}\n\n${bullet} Running 1 shell command…\n  \x1b[2m⎿  $ npm test\x1b[0m`;
    assert.equal(read(rows), 'Checking the build.');
    // In plain text the blank frame reads as the reply's own row two columns in.
    if (bullet === CALL_BLINK) assert.match(stripTerminalEscapes(rows), /^ {2}Running 1 shell command…$/m);
  }
});

test("Claude Code's dim rows under a reply end it; a quote's dim bar and coloured code do not", () => {
  const folded = '  \x1b[2m\x1b[37mRan \x1b[0;1m\x1b[37m\x1b[49m1\x1b[0;2m\x1b[37m\x1b[49m shell command \x1b[0m';
  assert.equal(read(`${said('Done.')}\n${folded}\n  \x1b[2m⎿  $ ls\x1b[0m\n  more of the call`), 'Done.');
  assert.equal(read(`${said('Thinking first.')}\n  \x1b[2m\x1b[37mThought for \x1b[0;1m\x1b[37m3s\x1b[0m`), 'Thinking first.');
  // At 256 colours Claude Code dims with its inactive grey (dark 246, light 241) rather than SGR 2.
  for (const grey of ['246', '241'])
    assert.equal(read(`${said('Done.')}\n  \x1b[38;5;${grey}mRan \x1b[1m2\x1b[0m\x1b[38;5;${grey}m shell commands \x1b[39m\n  more`), 'Done.', grey);
  const quote = `${said('Quote:')}\n  \x1b[2m▎\x1b[0m A quoted line.\n  \x1b[32m# a comment only\x1b[39m\n  \x1b[97monly inline code\x1b[39m\n  After.`;
  assert.equal(read(quote), 'Quote:\n▎ A quoted line.\n# a comment only\nonly inline code\nAfter.');
  // A notification in the text colour gives itself away by its dim details.
  assert.equal(read(`${REPLY} Monitor event: tick-1\x1b[2m\x1b[37m · Tick watcher\x1b[0m`), '');
  assert.equal(read(`\x1b[38;5;231m●\x1b[39m Monitor event: tick-1\x1b[38;5;246m · Tick watcher\x1b[39m`), '');
  assert.equal(read(`${REPLY} A reply that ends with \x1b[97mcode · x\x1b[39m`), 'A reply that ends with code · x');
});

test('styled rows keep the plain text character for character, with each character its look', () => {
  const screen = '\x1b]8;;https://example.com\x07link\x1b]8;;\x07 \x1b(B\x1b[2K\x1b[38;5;231m●\x1b[0;1m\x1b[37mB\x1b[22m n\r\n\x1b[38;2;0;0;0;48;5;4m中\x1b[39;49m文\x1b[3;4;7mx\x1b[23;24;27my\x07';
  const rows = styledRows(screen);
  assert.deepEqual(rows.map(row => row.text), stripTerminalEscapes(screen).split('\n'));
  const [first, second] = rows;
  assert.deepEqual(first.cells.slice(5, 8), [{ fg: '38;5;231' }, { bold: true, fg: '37' }, { fg: '37' }]);
  assert.deepEqual(second.cells, [{ fg: '38;2;0;0;0', bg: '48;5;4' }, {}, { italic: true, underline: true, inverse: true }, {}]);
});
