import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { animatedLabelText, composerFrameGuard, goalRowText, guardWindow } from '../src/backend/composer-frame-guard';
import { turnComposer } from '../src/core/turn-controls';

// Claude Code's /goal indicator sits on the notice row right above the input box and its timer
// ticks every second for a minute; the notices in front of it are cut anew each time, so the
// whole row changes (research §4.1). A key guard must not refuse a key for that, here or on
// the target (the filter runs in sh with the system awk: mawk here, BSD awk on the Mac CI).
const capture = (version: string, name: string) => readFileSync(new URL(`./fixtures/goal-${version}/${name}.ansi.txt`, import.meta.url), 'utf8');
const onTarget = (filter: string, text: string) => execFileSync('sh', ['-c', 'cat' + filter], { input: text, encoding: 'utf8' });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** The next second of the indicator: "(2s)" becomes "(13s)", everything before it one cell further left. */
function tick(view: string): string {
  return view.split('\n').map(row => {
    const at = row.indexOf('◎ /goal active');
    if (at < 0) return row;
    const plain = /\(\d+s\)/u.test(row) ? row.replace(/\((\d+)s\)/u, (_, n) => `(${Number(n) + 11}s)`) : row.replace('◎ /goal active', '◎ /goal active (1s)');
    const grown = plain.length - row.length;
    return /^ {2,}/u.test(plain) && !/^ {1,2}\S/u.test(plain) ? plain.slice(grown) : plain.replace(/…/u, '').replace(/.(?= · \x1b)/u, '…');
  }).join('\n');
}
const wholeFrame = (read: string) => guardWindow(read, { viewport: read, filter: '' });
const footerOnly = (read: string) => guardWindow(read, { viewport: read, tailLines: turnComposer(read)!.tailLines - 1, filter: '' });
/** A draft in the input box: before its cursor (an inverse space). */
const typeInto = (view: string, text: string) => {
  const rows = view.split('\n');
  let at = rows.length - 1;
  while (at > 0 && !/❯[ \u00a0]/u.test(rows[at])) at--;
  rows[at] = rows[at].replace(/❯([ \u00a0])/u, `❯$1${text}`);
  return rows.join('\n');
};

test('a guard on the whole frame or from the input box down ignores the ticking goal row, nothing else', () => {
  for (const [version, name] of [['2.1.300', 'deferred'], ['2.1.331', 'deferred'], ['2.1.300', 'notice'], ['2.1.331', 'notice'], ['2.1.331', 'active']]) {
    const read = capture(version, name), later = tick(read), where = `${version} ${name}`;
    assert.notEqual(later, read, `${where}: the timer moved`);
    for (const [kind, guard] of [['whole frame', wholeFrame(read)], ['from the box', footerOnly(read)]] as const) {
      assert.equal(onTarget(guard.filter, read), guard.expected, `${where} ${kind}: the same frame`);
      assert.equal(onTarget(guard.filter, later), guard.expected, `${where} ${kind}: a tick later`);
      assert.notEqual(onTarget(guard.filter, typeInto(later, 'x')), guard.expected, `${where} ${kind}: a draft in the box still refuses`);
    }
    // The row above the box is not in a guard from the box down: no filter is added there.
    assert.doesNotMatch(footerOnly(read).filter, /goal/u, where);
  }
});

test('a settings paste into the idle box with the goal and the tmux advisory on its row', () => {
  for (const version of ['2.1.300', '2.1.331']) {
    const read = capture(version, 'deferred'), paste = guardWindow(read, composerFrameGuard(read));
    assert.equal(onTarget(paste.filter, tick(read)), paste.expected, version);
    assert.notEqual(onTarget(paste.filter, typeInto(read, '/model')), paste.expected, version);
  }
});

test('a partially repainted goal timer is blanked on either side of the key guard', () => {
  const native = capture('2.1.331', 'notice');
  const withIndicator = (text: string) => native.replace('◎ /goal active', text);
  const read = withIndicator('◎ /goal active (98s)');
  const guard = wholeFrame(read);
  for (const indicator of [
    '◎ /goal acttive (98s)', '◎◎ /goal active (98s)', '◎ /goal active ((98s)',  // One more digit.
    '◎ /goal ative (59s)', '◎ /goal active 59s)',  // Seconds give way to one minute.
  ]) {
    const partial = withIndicator(indicator);
    assert.equal(goalRowText(partial), goalRowText(read), indicator);
    assert.equal(onTarget(guard.filter, partial), guard.expected, indicator);
    const readDuringPaint = wholeFrame(partial);
    assert.equal(onTarget(readDuringPaint.filter, read), readDuringPaint.expected, indicator);
    assert.notEqual(onTarget(readDuringPaint.filter, typeInto(read, 'x')), readDuringPaint.expected, indicator);
  }
  const otherNotice = withIndicator('◎ /goal stopped (98s)');
  assert.notEqual(onTarget(guard.filter, otherNotice), guard.expected);
  const noMarker = withIndicator('/goal active (98s)');
  assert.notEqual(onTarget(guard.filter, noMarker), guard.expected);
});

test('without a goal the guard is unchanged; two reads a tick apart are one stable frame', () => {
  const plain = ['● done', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on (shift+tab to cycle)', ''].join('\n');
  assert.deepEqual(wholeFrame(plain), { filter: '', expected: plain });
  const read = capture('2.1.331', 'deferred');
  assert.equal(goalRowText(animatedLabelText(read)), goalRowText(animatedLabelText(tick(read))));
  assert.equal(hash(onTarget(wholeFrame(read).filter, read)), hash(wholeFrame(read).expected));
  // A quoted indicator in a reply (not right above a rule) is compared as it is.
  const quoted = plain.replace('● done', '● The footer shows ◎ /goal active (3s)');
  assert.equal(wholeFrame(quoted).filter, '');
});
