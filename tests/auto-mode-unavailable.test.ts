import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { classifySessionScreen, parseAutoModeNudge } from '../src/core/screen';
import { isIdleEmptyComposer } from '../src/core/settings-screen';
import { canInterruptTurn, turnComposer } from '../src/core/turn-controls';
import { parsePermissionScreen, samePermission } from '../src/core/permission-screen';

// "Auto mode can't check actions in this session", sampled with
// scripts/cc-matrix/probe-classifier-failure.mjs --server (loopback fake API, 120×50).
const VERSIONS = ['2.1.321', '2.1.326', '2.1.330'];
const fixture = (version: string, name: string) => readFileSync(new URL(`./fixtures/auto-mode-unavailable-${version}/${name}.txt`, import.meta.url), 'utf8');
const dialog = fixture('2.1.330', 'dialog');
const FOOTER = 'Enter to stay in auto mode · shift+Tab to leave for accept edits mode and stop · Esc to cancel';

test('the dialog is a card with Claude Code\'s paragraphs and its two keyed choices', () => {
  for (const version of VERSIONS) {
    if (!existsSync(new URL(`./fixtures/auto-mode-unavailable-${version}/dialog.txt`, import.meta.url))) continue;
    const text = fixture(version, 'dialog');
    const screen = parsePermissionScreen(text);
    assert.ok(screen, version);
    assert.equal(screen.kind, 'auto-mode-unavailable');
    assert.equal(screen.title, "Auto mode can't check actions in this session");
    assert.equal(screen.subtitle.length, 4, version);
    assert.match(screen.subtitle[0], /^Auto mode's safety check runs on the server\. Your requests go through 127\.0\.0\.1:\d+, and the check isn't getting through\.$/);
    assert.equal(screen.subtitle[1], 'You can stay in auto mode and approve each action that needs the check yourself.');
    assert.match(screen.subtitle[2], /^Or you can leave for accept edits mode, .* This turn stops, .* Claude goes on at your next message, or sooner\.$/);
    assert.equal(screen.subtitle[3], 'To get the check back, ask whoever runs your gateway to pass it through: https://code.claude.com/docs/en/permission-modes#server-side-classifier-review');
    assert.deepEqual(screen.options.map(o => [o.number, o.key, o.label, o.focused, !!o.unavailable]),
      [[1, 'Enter', 'stay in auto mode', false, false], [2, 'BTab', 'leave for accept edits mode and stop', false, false]]);
    assert.equal(screen.footer, FOOTER);
    assert.equal(screen.question, '');
    assert.deepEqual(screen.content, []);
    // A native prompt owns the keys: never an idle input box, nothing to interrupt from the composer.
    assert.equal(classifySessionScreen(text).status, 'waiting', version);
    assert.equal(isIdleEmptyComposer(text), false, version);
    assert.equal(turnComposer(text), undefined, version);
    assert.equal(canInterruptTurn(text, 'waiting'), false, version);
    assert.equal(parseAutoModeNudge(text), undefined, version);
  }
});

test('a terminal too short for the whole dialog cuts off its end: no card, but the input box stays held', () => {
  // 2.1.321 in 120×16 (Lectern's panes are 120×40, where the dialog fits). Shift+Tab is refused then.
  const text = fixture('2.1.321', 'cut-off-16-rows');
  assert.doesNotMatch(text, /Esc to cancel/);
  assert.equal(parsePermissionScreen(text), undefined);
  assert.equal(classifySessionScreen(text).status, 'waiting');
  assert.equal(isIdleEmptyComposer(text), false);
});

test('should the footer say Shift+Tab is refused, leaving auto mode is not offered', () => {
  // Claude Code's wording for a dialog taller than the terminal (its footer is usually cut off then).
  const short = dialog.replace('and stop · Esc', 'and stop (needs a taller window) · Esc');
  const screen = parsePermissionScreen(short)!;
  assert.equal(screen.kind, 'auto-mode-unavailable');
  assert.equal(screen.options[1].unavailable, true);
  assert.equal(screen.options[0].unavailable, undefined);
  assert.equal(samePermission(screen, parsePermissionScreen(dialog)!), false, 'a change in what can be chosen is a new dialog');
  assert.equal(samePermission(parsePermissionScreen(dialog)!, parsePermissionScreen(dialog)!), true);
});

test('a narrow terminal wraps the key hint; it is still the same choice', () => {
  const wrapped = dialog.replace(`  ${FOOTER}`, '  Enter to stay in auto mode · shift+Tab to leave for accept edits mode\n  and stop · Esc to cancel');
  assert.equal(parsePermissionScreen(wrapped)?.footer, FOOTER);
});

test('only the complete dialog at the bottom is a card; a lookalike never is', () => {
  for (const changed of [
    dialog + '❯ \n',
    dialog + '  3. Something else\n',
    dialog.replace(/^─+$/mu, ''),
    dialog.replace("  Auto mode can't check actions in this session", "  Auto mode can check actions in this session"),
    dialog.replace(FOOTER, 'Enter to stay in auto mode · Esc to cancel'),
    dialog.replace(FOOTER, FOOTER.replace('shift+Tab', 'ctrl+t')),
    dialog.replace(FOOTER, `${FOOTER} · Tab to amend`),
    dialog.replace('  You can stay in auto mode', ' You can stay in auto mode'),
    dialog.replace('  You can stay in auto mode', '    You can stay in auto mode'),
    dialog.replace(/\n\n {2}You can stay[^\n]*\n\n {2}Or you can leave[\s\S]*?sooner\.\n\n {2}To get[^\n]*\n[^\n]*\n/u, '\n\n'),
  ]) assert.equal(parsePermissionScreen(changed)?.kind, undefined, changed.slice(-300));
});

test('a variant the card cannot read still holds the input box', () => {
  for (const variant of [
    dialog.replace(FOOTER, 'Enter to stay in auto mode · ctrl+t to leave for accept edits mode and stop · Esc to cancel'),
    dialog.replace('  Auto mode\'s safety check runs on the server.', '    Auto mode\'s safety check runs on the server.'),
  ]) {
    assert.equal(parsePermissionScreen(variant), undefined);
    assert.equal(classifySessionScreen(variant).status, 'waiting');
    assert.equal(isIdleEmptyComposer(variant), false);
  }
});

test('the dialog\'s words quoted in a reply above an idle input box change nothing', () => {
  const composer = '\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ \n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n';
  const quoted = ' ▐▛███▛█   Claude Code v2.1.330\n\n❯ What does it say?\n\n● It says:\n\n  Auto mode can\'t check actions in this session\n\n  ' + FOOTER + '\n' + composer;
  assert.equal(parsePermissionScreen(quoted), undefined);
  assert.notEqual(classifySessionScreen(quoted).status, 'waiting');
  assert.equal(isIdleEmptyComposer(quoted), true);
});

test('2.1.300 and 2.1.310 have no such dialog; their billing notice in the same spot is no card but still a native prompt', () => {
  for (const version of ['2.1.300', '2.1.310']) {
    const text = fixture(version, 'billing-notice');
    assert.match(text, /We're changing auto mode to no longer charge for classifier requests/);
    assert.equal(parsePermissionScreen(text), undefined, version);
    assert.equal(classifySessionScreen(text).status, 'waiting', version);
    assert.equal(isIdleEmptyComposer(text), false, version);
  }
});

test('after "stay", the action asks like any tool, with the reason, unnumbered choices and "No" first', () => {
  for (const version of ['2.1.321', '2.1.330']) checkAfterStay(fixture(version, 'after-stay'));
});
function checkAfterStay(text: string) {
  const screen = parsePermissionScreen(text)!;
  assert.equal(screen.kind, undefined);
  assert.equal(screen.title, 'Bash command');
  assert.deepEqual(screen.notice, ["Auto mode can't check actions in this session, so this one needs your approval"]);
  assert.equal(screen.question, 'Do you want to proceed?');
  assert.deepEqual(screen.options.map(o => [o.number, o.label, o.focused]), [[1, 'No', true], [2, 'Yes', false]]);
  assert.equal(classifySessionScreen(text).status, 'waiting');
  // Numbered and unnumbered rows never mix; a stray unnumbered row is no option list.
  assert.equal(parsePermissionScreen(text.replace('   Yes', '   2. Yes')), undefined);
  assert.equal(parsePermissionScreen(text.replace(' ❯ No', ' ❯ No\n      wrapped')), undefined);
}

test('after leaving for accept edits mode, a pipeline that writes asks with a plain reason line: a card too', () => {
  // The next message's command in accept edits mode (2.1.330); before plain reason lines were read, no card showed.
  const text = fixture('2.1.330', 'accept-edits-asks');
  const screen = parsePermissionScreen(text)!;
  assert.deepEqual(screen.notice, ['This command requires approval']);
  assert.deepEqual(screen.options.map(o => [o.number, o.label, o.focused]), [[1, 'Yes', true], [2, 'Yes, and don’t ask again for: tee again-0.txt', false], [3, 'No', false]]);
  // A plain line that is not at the dialog's indent, or a stray rule, is still no card.
  assert.equal(parsePermissionScreen(text.replace(' This command requires approval', '   This command requires approval')), undefined);
  assert.equal(parsePermissionScreen(text.replace(' This command requires approval', ' This command requires approval\n ─────')), undefined);
});
