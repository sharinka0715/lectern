import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifySessionScreen, parseAutoModeNudge } from '../src/core/screen';
import { isIdleEmptyComposer } from '../src/core/settings-screen';
import { canInterruptTurn, turnComposer } from '../src/core/turn-controls';
import { parsePermissionScreen, samePermission } from '../src/core/permission-screen';

// The classifier billing notice: Claude Code 2.1.300 and 2.1.310 with auto mode's server-side
// check on and a gateway that does not pass it through (here the loopback fake API), sampled
// with scripts/cc-matrix/probe-classifier-failure.mjs (120×50), before the first checked action.
const fixture = (version: string, name: string) => readFileSync(new URL(`./fixtures/auto-mode-unavailable-${version}/${name}.txt`, import.meta.url), 'utf8');
const notice = fixture('2.1.300', 'billing-notice');
const TITLE = "We're changing auto mode to no longer charge for classifier requests in Claude Code.";
const FOOTER = 'Enter to continue · Esc to cancel';

test('the notice is a card with Claude Code\'s own paragraphs and "continue" on Enter', () => {
  for (const version of ['2.1.300', '2.1.310']) {
    const text = fixture(version, 'billing-notice');
    const screen = parsePermissionScreen(text);
    assert.ok(screen, version);
    assert.equal(screen.kind, 'auto-mode-billing');
    assert.equal(screen.title, TITLE);
    assert.equal(screen.subtitle.length, 3, version);
    assert.match(screen.subtitle[0], /^However, this session isn't eligible because your requests go through 127\.0\.0\.1:\d+, which isn't compatible with this update\.$/);
    assert.equal(screen.subtitle[1], 'Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.');
    assert.equal(screen.subtitle[2], 'To fix it and access the new version of auto mode, ask your gateway to implement: https://code.claude.com/docs/en/auto-mode-classifier-billing');
    assert.deepEqual(screen.options.map(o => [o.number, o.key, o.label, o.focused]), [[1, 'Enter', 'continue', false]]);
    assert.equal(screen.footer, FOOTER);
    assert.equal(screen.question, '');
    assert.deepEqual(screen.content, []);
    // A native prompt owns the keys: never an idle input box, nothing to interrupt from the composer.
    assert.deepEqual(classifySessionScreen(text), { status: 'waiting', detail: 'Claude Code 的 auto mode 计费说明，等你确认继续或取消' });
    assert.equal(isIdleEmptyComposer(text), false, version);
    assert.equal(turnComposer(text), undefined, version);
    assert.equal(canInterruptTurn(text, 'waiting'), false, version);
    assert.equal(parseAutoModeNudge(text), undefined, version);
  }
});

test('later wordings of the notice (Claude Code 2.1.321–2.1.330 still carry it for a fallback) are the same card', () => {
  const later = notice
    .replace('  Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.',
      '  Auto mode works for now, and its classifier requests are billed as before. An upcoming release removes this fallback. In\n  sessions like this one, each checked action will then be asked about or denied.');
  const screen = parsePermissionScreen(later)!;
  assert.equal(screen.kind, 'auto-mode-billing');
  assert.match(screen.subtitle[1], /^Auto mode works for now, .* each checked action will then be asked about or denied\.$/);
  // Without a gateway named: "However, this session isn't eligible." and a support link.
  const unnamed = notice.replace(/ {2}However, this session isn't eligible because[^\n]*\n[^\n]*\n/u, "  However, this session isn't eligible.\n")
    .replace(/ {2}To fix it[^\n]*\n[^\n]*\n/u, "  If this keeps happening, contact support or your company's admin:\n  https://code.claude.com/docs/en/auto-mode-classifier-billing\n");
  const plain = parsePermissionScreen(unnamed)!;
  assert.equal(plain.kind, 'auto-mode-billing');
  assert.equal(plain.subtitle[0], "However, this session isn't eligible.");
  assert.equal(samePermission(plain, parsePermissionScreen(notice)!), false, 'other words are another dialog');
  assert.equal(samePermission(parsePermissionScreen(notice)!, parsePermissionScreen(notice)!), true);
});

test('only the complete notice at the bottom is a card; a lookalike never is', () => {
  for (const changed of [
    notice + '❯ \n',
    notice + '  ❯ 1. Yes\n',
    notice.replace(/^─+$/mu, ''),
    notice.replace(`  ${TITLE}`, "  We're changing auto mode."),
    notice.replace(FOOTER, 'Enter to confirm · Esc to cancel'),
    notice.replace(FOOTER, `${FOOTER} · Tab to amend`),
    notice.replace('  Nothing breaks', ' Nothing breaks'),
    notice.replace('  Nothing breaks', '    Nothing breaks'),
    notice.replace("  However, this session isn't eligible", '  This session is eligible'),
    notice.replace('are billed as before', 'are free now'),
  ]) assert.equal(parsePermissionScreen(changed)?.kind, undefined, changed.slice(-300));
});

test('a variant the card cannot read, or a notice a short terminal cuts off, still holds the input box', () => {
  for (const variant of [
    notice.replace("  However, this session isn't eligible", '  Some new reason'),
    notice.replace(FOOTER, 'Enter to go on · Esc to cancel'),
    // 120×16: the end of the notice (and its key hint) below the screen.
    notice.split('\n').slice(0, -8).join('\n') + '\n',
  ]) {
    assert.equal(parsePermissionScreen(variant), undefined);
    assert.equal(classifySessionScreen(variant).status, 'waiting');
    assert.equal(isIdleEmptyComposer(variant), false);
  }
});

test('the notice\'s words quoted in a reply above an idle input box change nothing', () => {
  const composer = '\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ \n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n';
  const quoted = ' ▐▛███▛█   Claude Code v2.1.300\n\n❯ What did it say?\n\n● It said:\n\n  ' + TITLE + '\n\n  ' + FOOTER + '\n' + composer;
  assert.equal(parsePermissionScreen(quoted), undefined);
  assert.notEqual(classifySessionScreen(quoted).status, 'waiting');
  assert.equal(isIdleEmptyComposer(quoted), true);
});

test('after continue the turn finishes; after cancel it is interrupted; either way the input box is back', () => {
  for (const name of ['billing-continued', 'billing-cancelled']) {
    const text = fixture('2.1.300', name);
    assert.equal(parsePermissionScreen(text), undefined, name);
    assert.notEqual(classifySessionScreen(text).status, 'waiting', name);
    assert.equal(isIdleEmptyComposer(text), true, name);
  }
  assert.match(fixture('2.1.300', 'billing-cancelled'), /Interrupted · What should Claude do instead\?/);
});

// Claude Code 2.1.330 shows the notice too, with its newer wording, when the default level of
// telemetry lets it fall back to its own check (scripts/cc-matrix/probe-classifier-failure.mjs with
// CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1): before the first checked action, and under a
// streamed reply ("streamed": a reply text, the unmarked heading of the waiting call), the layout of
// the screen a user behind a gateway saw only as a "dialog open" banner.
const billing330 = (name: string) => readFileSync(new URL(`./fixtures/auto-mode-billing-2.1.330/${name}.txt`, import.meta.url), 'utf8');

test('Claude Code 2.1.330\'s notice is the same card, also under a streamed reply', () => {
  for (const name of ['notice', 'streamed']) {
    const text = billing330(name);
    const screen = parsePermissionScreen(text)!;
    assert.equal(screen?.kind, 'auto-mode-billing', name);
    assert.equal(screen.title, TITLE);
    assert.match(screen.subtitle[0], /^However, this session isn't eligible because your requests go through 127\.0\.0\.1:\d+, which isn't compatible with this update\.$/);
    assert.equal(screen.subtitle[1], 'Auto mode works for now, and its classifier requests are billed as before. An upcoming release removes this fallback. In sessions like this one, each checked action will then be asked about or denied.');
    assert.match(screen.subtitle[2], / https:\/\/code\.claude\.com\/docs\/en\/auto-mode-classifier-billing$/);
    assert.deepEqual(screen.options.map(o => [o.number, o.key, o.label]), [[1, 'Enter', 'continue']]);
    assert.equal(classifySessionScreen(text).status, 'waiting', name);
    assert.equal(isIdleEmptyComposer(text), false, name);
  }
  assert.match(billing330('streamed'), /● I will search the docs first, then report back\.\n\n {2}Searching docs for findings\n/);
  // Esc interrupts the turn (the call is refused); Enter runs it after Claude Code's own check.
  for (const name of ['cancelled', 'continued']) {
    const text = billing330(name);
    assert.equal(parsePermissionScreen(text), undefined, name);
    assert.equal(parsePermissionScreen(text, { generic: true }), undefined, name);
    assert.equal(isIdleEmptyComposer(text), true, name);
  }
  assert.match(billing330('cancelled'), /Interrupted · What should Claude do instead\?/);
  assert.match(billing330('continued'), /Ran 1 shell command[\s\S]*Probe finished \(ccm-probe-done\)\./);
});
