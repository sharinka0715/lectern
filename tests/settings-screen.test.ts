import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { focusedSettingCommandHistory, hasPendingSettingCommand, isIdleEmptyComposer, newSettingViewport, priorComposerHistory, observeEffortFooter, parseModelSwitchConfirmation, parseSettingScreen, type SettingKind, type SettingMenuScreen } from '../src/core/settings-screen';
import { classifySessionScreen } from '../src/core/screen';

// Native Claude Code 2.1.326 menu layout, with paths and provider details omitted.
// These are test observations, not an inventory used by the application.
const staleHeader = `Claude Code v2.1.326
  haiku[1m] · API Usage Billing
❯ /unsupported
⏺ Unknown command: /unsupported.
`;
const modelRows = [
  '     1.  Default (recommended)             Use the default model (currently Opus 5.5) · $4/$20 per Mtok',
  '     2.  Opus 5.5                          Custom Opus model',
  '     3.  Fable                             Fable 5.1 · Most capable for your hardest and longest-running tasks',
  '     4.  google/models/gemini-4-argon[1m]  Custom Sonnet model (1M context)',
  '   ❯ 5.  Haiku 5.5 ✔                       Custom Haiku model',
  '     6.  Claude Opus 5                     Custom provider',
  '     7.  Claude Sonnet 5                   Custom provider',
  '     8.  Claude Sonnet 5.5                 Custom provider',
  '     9.  Gemini 4 Argon                    Custom provider',
  '     10. Gemini 4 Carbon                   Custom provider',
];
const modelFooter = '   Enter to set as default · s to use this session only · Esc to cancel';
function modelScreen(rows = modelRows, before = '', after = '     ↓ 1 more', effort = 'Medium') {
  return `${staleHeader}
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other or older models, use
   --model.

${before}
${rows.join('\n')}
${after}

   ◐ ${effort} effort (default) ←/→ to adjust

${modelFooter}\n`;
}
const effortScreen = `${staleHeader}
❯ /model
  ⎿ Kept model as Haiku 5.5

   Effort

                             Faster                             Smarter
                             ──────────▲───────────────────────────────      Ultracode  off
                             low     medium     high     xhigh      max      Tab to toggle

                                            The default effort for this model

   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
`;
const composer = '\n─────────────────────────────────\n❯ \n─────────────────────────────────\n  ? for shortcuts\n';
test('a wrapped slash-command description preserves the focused command and never becomes a choice', () => {
  const history = '❯ Previous command\n  ⎿  Finished\n\n';
  const suggestions = [
    '  ❯ /model'.padEnd(35) + 'Set the AI model for Claude Code',
    '    /model-library'.padEnd(35) + '用 CLI 管理模型仓库',
    ' '.repeat(35) + '浏览模型和可用版本，查看同步状态…',
    ' '.repeat(35) + '/a-path in the description',
    '    /auto-mode-setup'.padEnd(35) + 'Teach auto mode about your environment',
    '    /code-review'.padEnd(35) + 'Review the current diff',
  ].join('\n');
  const draft = composer.replace('❯ ', '❯\u00a0/model').replace('? for shortcuts', '⏵⏵ auto mode on (shift+tab to cycle)');
  const idle = history + draft.replace('❯\u00a0/model', '❯ ');
  for (const captured of [
    history + suggestions + draft,
    history + draft.replace('  ⏵⏵', suggestions + '\n  ⏵⏵'),
  ]) {
    assert.ok(hasPendingSettingCommand(captured, '/model', idle));
    assert.deepEqual(focusedSettingCommandHistory(captured, '/model'), ['❯ Previous command', '  ⎿  Finished']);
    assert.equal(focusedSettingCommandHistory(captured, '/effort'), undefined);
    const wrongFocus = captured.replace('❯ /model ', '  /model ').replace('    /model-library', '  ❯ /model-library');
    assert.equal(hasPendingSettingCommand(wrongFocus, '/model', idle), false);
    assert.equal(focusedSettingCommandHistory(wrongFocus, '/model'), undefined);
    for (const changed of [captured + 'Press Enter to continue', captured.replace('❯\u00a0/model', '❯\u00a0/model --extra'), captured + 'unexpected control']) {
      assert.equal(focusedSettingCommandHistory(changed, '/model'), undefined);
    }
  }
  assert.equal(focusedSettingCommandHistory(history + draft, '/model'), undefined);
});
test('Enter is bound to the exact boxed draft with matching native autocomplete focus', () => {
  const draft = composer.replace('❯ ', '❯\u00a0/model');
  const suggestions = '  ❯ /model          Set the AI model for Claude Code\n    /effort         Set the model’s effort level';
  assert.ok(hasPendingSettingCommand(suggestions + draft, '/model', composer));
  assert.ok(hasPendingSettingCommand(draft.replace('? for shortcuts', suggestions + '\n  ? for shortcuts'), '/model', composer));
  assert.ok(hasPendingSettingCommand(draft.replace('/model', '/effort'), '/effort', composer));
  const mode = '⏵⏵ auto mode on (shift+tab to cycle)';
  assert.ok(hasPendingSettingCommand(suggestions + draft.replace('? for shortcuts', mode), '/model',
    composer.replace('? for shortcuts', mode + ' · ← for agents')));
  const unboxed = 'Claude Code\n❯ \n  ? for shortcuts';
  assert.ok(hasPendingSettingCommand(unboxed.replace('❯ ', '❯ /model'), '/model', unboxed));
  assert.equal(hasPendingSettingCommand(unboxed.replace('❯ ', '❯ /model') + '\nPress Enter to continue', '/model', unboxed), false);
  for (const changed of [
    draft.replace('/model', '/model user draft'), draft.replace('/model', '/effort'),
    suggestions + composer, suggestions.replace('❯ /model', '❯ /effort') + draft,
    draft + 'Press Enter to continue', draft + 'Extra approval',
    'Do you want to proceed?\n' + draft,
    draft.replace('❯\u00a0/model', '❯\u00a0/model\nsecond line'),
  ]) assert.equal(hasPendingSettingCommand(changed, '/model', composer), false);
});
const modelConfirmation = `❯ /model
  ⎿ Kept model as Gemini 4 Carbon
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Switch model?
   Your next response will be slower and use more tokens

   This conversation is cached for the current model. Switching to Haiku 5.5 means the full history gets re-read.

   ❯ 1. Yes, switch to Haiku 5.5
     2. No, go back

   Enter to confirm · Esc to cancel
`;
function menu(screen: string, kind: SettingKind = 'model'): SettingMenuScreen {
  const parsed = parseSettingScreen(screen, kind);
  assert.equal(parsed.state, 'menu', JSON.stringify(parsed));
  return parsed as SettingMenuScreen;
}

test('native model menu distinguishes persisted current, focus and observed session-only controls', () => {
  const parsed = menu(modelScreen());
  assert.equal(parsed.options.length, 10);
  assert.equal(parsed.options[3].label, 'google/models/gemini-4-argon[1m]');
  assert.equal(parsed.options[3].description, 'Custom Sonnet model (1M context)');
  assert.equal(parsed.currentKey, parsed.options[4].key);
  assert.equal(parsed.focusedKey, parsed.currentKey);
  assert.equal(parsed.displayCurrent, 'Haiku 5.5');
  assert.equal(parsed.sessionOnlyKey, 's');
  assert.equal(parsed.cancelKey, 'Escape');
  assert.equal(parsed.hasMoreAfter, true);
  assert.equal(parsed.moreAfterCount, 1);
  assert.equal(parsed.hasMoreBefore, false);
  assert.deepEqual(parsed.observedEffort, { value: 'Medium', source: 'model-focus' });
  assert.equal(isIdleEmptyComposer(modelScreen()), false);
});

test('native model-switch cache-cost confirmation reports its exact dynamic target and focused choice', () => {
  const parsed = parseModelSwitchConfirmation(modelConfirmation);
  assert.ok(parsed);
  assert.equal(parsed.targetLabel, 'Haiku 5.5');
  assert.equal(parsed.focused, 'confirm');
  assert.equal(parsed.confirmOrdinal, 1);
  assert.equal(parsed.cancelOrdinal, 2);
  assert.equal(parsed.confirmKey, 'Enter');
  assert.equal(parsed.cancelKey, 'Escape');
  assert.equal(parsed.footerObserved, true);
  assert.deepEqual(parseSettingScreen(modelConfirmation, 'model'), { state: 'model-confirmation', ...parsed });
  assert.equal(parseSettingScreen(modelConfirmation, 'effort').state, 'unrecognized');
  assert.equal(isIdleEmptyComposer(modelConfirmation), false);
  assert.equal(classifySessionScreen(modelConfirmation).status, 'waiting');
  const cancelled = parseModelSwitchConfirmation(modelConfirmation.replace('❯ 1.', '  1.').replace('  2. No', '❯ 2. No'));
  assert.equal(cancelled?.focused, 'cancel');
  assert.equal(cancelled?.targetLabel, parsed.targetLabel);
  assert.notEqual(cancelled?.signature, parsed.signature);
  const other = parseModelSwitchConfirmation(modelConfirmation.replaceAll('Haiku 5.5', 'arbitrary-provider/custom-model'));
  assert.equal(other?.targetLabel, 'arbitrary-provider/custom-model', 'The caller must compare the actual dialog target with its authorized request');
  assert.notEqual(other?.targetLabel, parsed.targetLabel);
});

test('model-switch confirmation requires matching body/choice labels and never accepts unknown approvals', () => {
  for (const altered of [
    modelConfirmation.replace('Switch model?', 'Switch account?'),
    modelConfirmation.replace('Switching to Haiku 5.5 means', 'Switching to Different model means'),
    modelConfirmation.replace('This conversation is cached for the current model. ', ''),
    modelConfirmation.replace(' means the full history gets re-read.', ''),
    modelConfirmation.replace('Your next response will be slower and use more tokens', 'Please approve this operation'),
    modelConfirmation.replace('❯ 1.', '  1.'),
    modelConfirmation.replace('  2. No', '❯ 2. No'),
    modelConfirmation.replace('Enter to confirm · Esc to cancel', 'Enter to approve'),
    modelConfirmation.replace('Enter to confirm · Esc to cancel', '3. Always approve\nEnter to confirm · Esc to cancel'),
    modelConfirmation + 'Confirm external account change? [Y/n]',
    modelConfirmation + composer,
    '⏺ Here is a quoted example:\n```text\n' + modelConfirmation,
  ]) {
    assert.equal(parseModelSwitchConfirmation(altered), undefined);
    assert.notEqual(parseSettingScreen(altered, 'model').state, 'model-confirmation');
  }
  assert.equal(parseModelSwitchConfirmation('Allow account access?\n❯ 1. Yes\n2. No\nEnter to confirm · Esc to cancel'), undefined);
});

test('confirmation tolerates observed wrapping and styling without weakening its exact body', () => {
  const wrapped = modelConfirmation.replace('Switching to Haiku 5.5 means', 'Switching to Haiku 5.5\n   means');
  assert.deepEqual(parseModelSwitchConfirmation('\x1b[33m' + wrapped.replaceAll(' ', '\u00a0') + '\x1b[0m\n\n'), parseModelSwitchConfirmation(modelConfirmation));
});

test('real legacy SSH cache confirmation is recognized without a footer only inside its exact bounded layout', () => {
  const captured = readFileSync(new URL('./fixtures/settings/model-confirmation-ssh-no-footer.txt', import.meta.url), 'utf8');
  const dialog = parseModelSwitchConfirmation(captured);
  assert.ok(dialog);
  assert.equal(dialog.targetLabel, 'Sonnet 5.5');
  assert.equal(dialog.focused, 'confirm');
  assert.equal(dialog.footerObserved, false);
  assert.equal(dialog.confirmKey, 'Enter');
  assert.equal(parseSettingScreen(captured, 'model').state, 'model-confirmation');
  assert.equal(classifySessionScreen(captured).status, 'waiting');
  assert.equal(isIdleEmptyComposer(captured), false);
  for (const invalid of [
    captured.replace(/^▔+\n/u, ''),
    captured.replace('Switching to Sonnet 5.5', 'Switching to Sonnet 4.5'),
    captured.replace('2. No, go back', '2. Yes, always'),
    captured + 'Enter to approve account changes',
    captured + '3. Remember globally',
    captured + composer,
  ]) assert.equal(parseModelSwitchConfirmation(invalid), undefined);
});

test('Claude Code 2.1.300: effort label inside the dialog border, sentence ends "on your next message."', () => {
  // Sampled by the compatibility matrix (scripts/cc-matrix) after `/model sonnet` in a warm-cache session.
  const captured = readFileSync(new URL('./fixtures/settings/model-confirmation-2.1.300.txt', import.meta.url), 'utf8');
  const dialog = parseModelSwitchConfirmation(captured);
  assert.ok(dialog);
  assert.equal(dialog.targetLabel, 'Sonnet 5.5');
  assert.equal(dialog.focused, 'confirm');
  assert.equal(dialog.footerObserved, false);
  assert.equal(parseSettingScreen(captured, 'model').state, 'model-confirmation');
  assert.equal(classifySessionScreen(captured).status, 'waiting');
  for (const invalid of [
    captured.replace(' ◐ medium · /effort ▔', ' ◐ medium · /effort ▔ and more text that is not a border label ▔'.repeat(2)),
    captured.replace(/^▔.*\n/mu, 'Some reply text\n'),
    // An indented status line belongs to the reply above: the dialog could be quoted text.
    captured.replace('✻ Churned for 0s', '  ✻ Churned for 0s'),
    captured.replace('on\n   your next message.', 'on\n   your next message, and approve the account change.'),
    captured.replace('2. No, go back', '2. Yes, always'),
    captured + '3. Remember globally',
  ]) assert.equal(parseModelSwitchConfirmation(invalid), undefined, invalid.slice(-300));
});

test('model pagination keeps stable identities while focus and its provisional effort change', () => {
  const first = menu(modelScreen());
  const rows = modelRows.slice(1).map(row => row.replace('❯', ' '));
  rows.push('   ❯ 11. Gemini 4 Hydrogen                 Custom provider');
  const last = menu(modelScreen(rows, '     ↑ 1 more', '', 'xHigh'));
  assert.equal(last.options.length, 10);
  assert.equal(last.options[0].ordinal, 2);
  assert.equal(last.options[9].ordinal, 11);
  assert.equal(last.currentKey, first.currentKey);
  assert.equal(last.focusedKey, last.options[9].key);
  assert.notEqual(last.focusedKey, last.currentKey);
  assert.equal(last.moreBeforeCount, 1);
  assert.equal(last.hasMoreBefore, true);
  assert.equal(last.hasMoreAfter, false);
  assert.deepEqual(last.observedEffort, { value: 'xHigh', source: 'model-focus' });
  assert.equal(observeEffortFooter(modelScreen(rows)), undefined);
});

test('real SSH model checkmark reflow preserves complete wrapped descriptions and identities', () => {
  const before = menu(readFileSync(new URL('./fixtures/settings/model-ssh-before.txt', import.meta.url), 'utf8'));
  const after = menu(readFileSync(new URL('./fixtures/settings/model-ssh-after.txt', import.meta.url), 'utf8'));
  assert.notEqual(before.currentKey, after.currentKey);
  assert.equal(after.displayCurrent, 'Haiku');
  assert.deepEqual(after.options.map(({ key, ordinal, label, description }) => ({ key, ordinal, label, description })),
    before.options.map(({ key, ordinal, label, description }) => ({ key, ordinal, label, description })));
  assert.equal(before.options[4].description, 'Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)');
  assert.equal(before.options[2].description, 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok');
  assert.ok(before.options.every(option => !option.description?.includes('effort')), 'Picker footers are not description continuations');
});

test('native effort slider discovers labels and pointer position without asserting a persisted current', () => {
  const parsed = menu(effortScreen, 'effort');
  assert.deepEqual(parsed.options.map(option => option.label), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(parsed.focusedKey, parsed.options[1].key);
  assert.equal(parsed.currentKey, undefined);
  assert.ok(parsed.options.every(option => !option.current));
  assert.deepEqual(parsed.observedEffort, { value: 'medium', source: 'effort-focus' });
  assert.equal(parsed.sessionOnlyKey, 's');
  assert.equal(parsed.cancelKey, 'Escape');
  assert.equal(parsed.hasMoreBefore, false);
  assert.equal(parsed.hasMoreAfter, false);
  assert.equal(isIdleEmptyComposer(effortScreen), false);
  assert.equal(observeEffortFooter(effortScreen), undefined);
});

test('menu inventory is dynamic, including custom model names and arbitrary effort labels', () => {
  const parsed = menu(modelScreen([
    '  73.  Local custom v9 ✔   Model supplied by this installation',
    '❯ 74.  my/provider-beta    Another model',
  ], '↑ more', '↓ 25 more'));
  assert.deepEqual(parsed.options.map(option => option.label), ['Local custom v9', 'my/provider-beta']);
  assert.equal(parsed.currentKey, parsed.options[0].key);
  assert.equal(parsed.focusedKey, parsed.options[1].key);
  assert.equal(parsed.moreBeforeCount, undefined);
  assert.equal(parsed.moreAfterCount, 25);
  const slider = menu(`Effort
  ─────────────────▲─────────
  quick   careful   extensive
←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`, 'effort');
  assert.deepEqual(slider.options.map(option => option.label), ['quick', 'careful', 'extensive']);
  assert.equal(slider.focusedKey, slider.options[2].key);
});

test('unknown-command feedback is observed without inventing a fallback and active menu supersedes it', () => {
  const unknown = `${staleHeader}${composer}`;
  assert.deepEqual(parseSettingScreen(unknown, 'model'), { state: 'unknown-command', command: '/unsupported' });
  assert.equal(isIdleEmptyComposer(unknown), true);
  assert.equal(parseSettingScreen(modelScreen(), 'model').state, 'menu');
  assert.equal(parseSettingScreen(effortScreen, 'effort').state, 'menu');
  assert.deepEqual(parseSettingScreen(`${staleHeader}\n❯ /model\n  ⎿ Kept model as A\n${composer}`, 'model'), { state: 'idle', emptyInput: true });
  assert.deepEqual(parseSettingScreen('❯ /new-choice\nUnknown command: /new-choice.\n' + composer, 'model'), { state: 'unknown-command', command: '/new-choice' });
});

test('empty composer guard rejects drafts, busy state and native confirmations', () => {
  assert.equal(isIdleEmptyComposer(composer), true);
  assert.equal(isIdleEmptyComposer(composer.replace('❯ ', '❯ do not overwrite my draft')), false);
  assert.equal(isIdleEmptyComposer('✻ Thinking… (esc to interrupt)' + composer), false);
  assert.equal(isIdleEmptyComposer('Press Enter to continue…'), false);
  assert.equal(isIdleEmptyComposer('❯ hello\n  ⎿ API Error: 429 too many requests\n' + composer), true);
  assert.equal(isIdleEmptyComposer(composer.replace('❯ ', '❯ Try "explain this file"')), true);
  assert.equal(isIdleEmptyComposer('❯ Try "explain this file"'), false);
  assert.equal(parseSettingScreen('Claude Code\nhaiku[1m] · API Usage Billing', 'model').state, 'unrecognized');
});

test('native API failure permits settings recovery only from the explicit boxed empty retry hint', () => {
  const retryComposer = composer.replace('❯ ', '❯\u00a0Once fixed, resend your message');
  const failure = '❯ Connectivity check\n\n⏺ API Error: 400 Unsupported model\n  (request details omitted)\n';
  const observed = failure + retryComposer;
  assert.equal(isIdleEmptyComposer(observed), true);
  assert.deepEqual(parseSettingScreen(observed, 'model'), { state: 'idle', emptyInput: true });
  assert.ok(hasPendingSettingCommand(failure + composer.replace('❯ ', '❯ /model'), '/model', observed));
  assert.equal(isIdleEmptyComposer(failure + composer), true);
  assert.equal(isIdleEmptyComposer(retryComposer), false, 'No native error means the same literal text is not assumed empty');
  assert.equal(isIdleEmptyComposer(failure + '❯ Once fixed, resend your message'), false);
  assert.equal(isIdleEmptyComposer(observed.replace('Once fixed, resend your message', 'Once fixed, resend your message please')), false);
  assert.equal(isIdleEmptyComposer(failure + composer.replace('❯ ', '❯ keep my draft')), false);
  assert.equal(isIdleEmptyComposer(failure + '✻ Thinking… (esc to interrupt)\n' + retryComposer), false);
  assert.equal(isIdleEmptyComposer(failure + '────────────\nDo you want to proceed?\n' + retryComposer), false);
  assert.equal(isIdleEmptyComposer(failure + '❯ New submitted prompt\n' + retryComposer), false, 'A previous turn error cannot justify a new retry placeholder');
});

test('captured API error retry input stays empty after acknowledged model and effort menus close', () => {
  // Native 2.1.326 idle-confirm capture;
  // unrelated transcript content and the submitted prompt are omitted/redacted.
  const observed = readFileSync(new URL('./fixtures/settings/api-error-after-model-close.txt', import.meta.url), 'utf8');
  assert.equal(isIdleEmptyComposer(observed), true);
  assert.equal(classifySessionScreen(observed).status, 'error');
  assert.deepEqual(parseSettingScreen(observed, 'model'), { state: 'idle', emptyInput: true });
  const afterBoth = observed.replace('  ⎿ \u00a0Kept model as Sonnet 5.5', '  ⎿ \u00a0Kept model as Sonnet 5.5\n\n❯ /effort\n  ⎿ \u00a0Cancelled');
  assert.equal(isIdleEmptyComposer(afterBoth), true);
  assert.equal(classifySessionScreen(afterBoth).status, 'error');
  assert.deepEqual(parseSettingScreen(afterBoth, 'effort'), { state: 'idle', emptyInput: true });
});

test('retry recovery crosses only exact closed native setting blocks and never a new turn or draft', () => {
  const observed = readFileSync(new URL('./fixtures/settings/api-error-after-model-close.txt', import.meta.url), 'utf8');
  for (const changed of [
    observed.replace('❯ /model', '❯ A new submitted user turn'),
    observed.replace('❯ /model', '❯ /help'),
    observed.replace('❯ /model', '❯ /model custom-model'),
    observed.replace('❯ /model', '❯ /effort'),
    observed.replace('  ⎿ \u00a0Kept model as Sonnet 5.5', ''),
    observed.replace('Kept model as Sonnet 5.5', 'Kept model as   '),
    observed.replace('Kept model as Sonnet 5.5', 'Cancelled'),
    observed.replace('Kept model as Sonnet 5.5', 'Set model to Sonnet 5.5'),
    observed.replace('Kept model as Sonnet 5.5', 'Kept model as Sonnet 5.5\n  Additional unrecognized output'),
    observed.replace('❯ /model', '❯ New submitted user turn\n\n❯ /model'),
    observed.replace(/^● API Error:.*$/m, ''),
    observed.replace('Once fixed, resend your message', 'keep my unsent draft'),
    observed.replace('Once fixed, resend your message', 'Once fixed, resend your message please'),
    observed.replace('❯ /model', '\n'.repeat(21) + '❯ /model'),
  ]) {
    assert.equal(isIdleEmptyComposer(changed), false, changed);
    assert.notEqual(classifySessionScreen(changed).status, 'error', changed);
  }
});

test('closed-setting recovery keeps native classification, active status, and current boxed-input guards', () => {
  const observed = readFileSync(new URL('./fixtures/settings/api-error-after-model-close.txt', import.meta.url), 'utf8');
  assert.equal(classifySessionScreen('● A quoted example:\n```text\n' + observed + '```').status, 'unknown');
  assert.notEqual(classifySessionScreen(observed.replace('❯ Connectivity check', '● An example:\n```text') + '```').status, 'error');
  const working = observed.replace('❯ /model', '✻ Retrying… (esc to interrupt)\n❯ /model');
  assert.equal(classifySessionScreen(working).status, 'working');
  assert.equal(isIdleEmptyComposer(working), false);
  const waiting = observed.replace('❯ /model', '────────────\nDo you want to proceed?\n❯ /model');
  assert.equal(classifySessionScreen(waiting).status, 'waiting');
  assert.equal(isIdleEmptyComposer(waiting), false);
  const unboxed = observed.replace(/^─+\n/m, '');
  assert.notEqual(classifySessionScreen(unboxed).status, 'error');
  assert.equal(isIdleEmptyComposer(unboxed), false);
});

test('captured session-only model change and repeated verified settings blocks preserve current API recovery evidence', () => {
  // Native apply-confirm capture;
  // unrelated transcript content and the submitted prompt are omitted/redacted.
  const observed = readFileSync(new URL('./fixtures/settings/api-error-after-model-set.txt', import.meta.url), 'utf8');
  const moreClosedMenus = '❯ /model\n  ⎿ Kept model as Haiku 5.5\n\n❯ /effort\n  ⎿ Cancelled\n\n';
  const verified = observed.replace(/^─/m, moreClosedMenus + '─');
  for (const screen of [observed, verified]) {
    assert.equal(isIdleEmptyComposer(screen), true);
    assert.equal(classifySessionScreen(screen).status, 'error');
    assert.deepEqual(parseSettingScreen(screen, 'model'), { state: 'idle', emptyInput: true });
  }
  const lines = verified.split('\n');
  assert.ok(lines.findIndex(line => line.includes('Once fixed')) - lines.findIndex(line => line.includes('API Error:')) > 20,
    'transparent closed settings blocks may exceed the ordinary error window');
});

test('model-change recovery rejects unknown scope, new turns, stale ordinary evidence, and more than 64 total lines', () => {
  const observed = readFileSync(new URL('./fixtures/settings/api-error-after-model-set.txt', import.meta.url), 'utf8');
  for (const changed of [
    observed.replace('Set model to Haiku 5.5 for this session only', 'Set model to Haiku 5.5'),
    observed.replace('for this session only', 'as default'),
    observed.replace('for this session only', 'for all sessions'),
    observed.replace('for this session only', 'for this session only and future sessions'),
    observed.replace('Set model to Haiku 5.5 for this session only', 'Set model to for this session only'),
    observed.replace('Set model to Haiku 5.5 for this session only', 'Set model to   for this session only'),
    observed.replace('Set model to Haiku 5.5 for this session only', 'Set model to Haiku 5.5 for this session only\n  Unexpected acknowledgement'),
    observed.replace('❯ /model', '❯ A new user request\n\n❯ /model'),
    observed.replace('❯ /model', '❯ /unrecognized\n\n❯ /model'),
    observed.replace('❯ /model', '\n'.repeat(21) + '❯ /model'),
    observed.replace('❯ /model', '❯ /model\n  ⎿ Kept model as Haiku 5.5\n\n'.repeat(17) + '❯ /model'),
    observed.replace('Once fixed, resend your message', 'keep my draft'),
  ]) {
    assert.equal(isIdleEmptyComposer(changed), false, changed);
    assert.notEqual(classifySessionScreen(changed).status, 'error', changed);
  }
});

test('old menu followed by a current empty composer is no longer an active settings dialog', () => {
  const old = modelScreen().replace(staleHeader, '');
  assert.deepEqual(parseSettingScreen(old + composer, 'model'), { state: 'idle', emptyInput: true });
  assert.equal(isIdleEmptyComposer(old + composer), true);
  const draft = old + composer.replace('❯ ', '❯ keep this draft');
  assert.equal(parseSettingScreen(draft, 'model').state, 'unrecognized');
  assert.equal(isIdleEmptyComposer(draft), false);
});

test('a new unknown overlay below the menu footer cannot be mistaken for the owned menu', () => {
  for (const suffix of ['Confirm external account change? [Y/n]', 'Confirm external account change?\nEnter to confirm · Esc to cancel']) {
    assert.equal(parseSettingScreen(modelScreen() + suffix, 'model').state, 'unrecognized');
    assert.equal(isIdleEmptyComposer(modelScreen() + suffix), false);
    assert.equal(parseSettingScreen(effortScreen + suffix, 'effort').state, 'unrecognized');
  }
  assert.equal(parseSettingScreen(modelScreen() + '\n   \n', 'model').state, 'menu');
});

test('only explicit idle effort footer is a current observation; welcome banner is never used', () => {
  assert.deepEqual(observeEffortFooter('haiku[1m] · old effort\n' + composer + '  ◐ adventurous · /effort\n'), { value: 'adventurous', source: 'composer-footer' });
  assert.equal(observeEffortFooter('haiku[1m] · medium effort\n' + composer), undefined);
  assert.equal(observeEffortFooter('  ◐ medium · /effort\n✻ Thinking… (esc to interrupt)' + composer), undefined);
  assert.equal(observeEffortFooter(modelScreen()), undefined);
});

test('ANSI styling, nonbreaking spaces and tmux trailing rows preserve parsed identities', () => {
  const plain = menu(modelScreen());
  const decorated = menu('\x1b[32m' + modelScreen().replaceAll(' ', '\u00a0') + '\x1b[0m\n\n\n');
  assert.deepEqual(decorated, plain);
});

test('unsupported or ambiguous menus fail closed and session-only support is never guessed', () => {
  for (const rows of [
    [' 1.  A ✔', ' 2.  B'],
    ['❯ 1.  A ✔', '❯ 2.  B'],
    ['❯ 1.  A ✔', ' 2.  B ✔'],
    ['❯ 1.  A ✔', ' 1.  B'],
  ]) assert.equal(parseSettingScreen(modelScreen(rows), 'model').state, 'unrecognized');
  assert.equal(parseSettingScreen(modelScreen().replace(modelFooter, ''), 'model').state, 'unrecognized');
  assert.equal(parseSettingScreen(modelScreen(), 'effort').state, 'unrecognized');
  assert.equal(parseSettingScreen(effortScreen.replace('▲', '─'), 'effort').state, 'unrecognized');
  const noSessionShortcut = menu(modelScreen().replace(' · s to use this session only', ''));
  assert.equal(noSessionShortcut.sessionOnlyKey, undefined);
  assert.equal(noSessionShortcut.cancelKey, 'Escape');
});

test('effort cache dialogs and folded model rows stay inactive in assistant, tool and fenced output', () => {
  const effort = modelConfirmation.slice(modelConfirmation.indexOf('▔')).replace('Switch model?', 'Change effort level?')
    .replace('current model.', 'current effort level.').replaceAll('Haiku 5.5', 'heavy');
  const folded = modelScreen(['❯ 1. Custom ✔', '   ▸ More models'], '', '').replace(staleHeader, '');
  assert.equal(parseSettingScreen(effort, 'effort').state, 'effort-confirmation');
  assert.equal(classifySessionScreen(effort).status, 'waiting');
  assert.equal(parseSettingScreen(effort.replace('current effort level.', 'current model.'), 'effort').state, 'unrecognized');
  assert.equal(menu(folded).options[1].disclosure, 'collapsed');
  for (const prefix of ['⏺ An example:\n', '⏺ Bash(cat example)\n  ⎿ Output:\n', '⏺ Example:\n```text\n']) {
    assert.equal(parseSettingScreen(prefix + effort, 'effort').state, 'unrecognized');
    assert.equal(parseSettingScreen(prefix + folded, 'model').state, 'unrecognized');
  }
});

test('dim disabled labels are distinct from dim numbers, descriptions and RGB channel values', () => {
  const frame = modelScreen([
    '❯ \x1b[2m1. \x1b[22mEnabled ✔  \x1b[2mDescription\x1b[0m',
    '  \x1b[2m2. Disabled  Description\x1b[0m',
    '  \x1b[38;2;2;22;0m3. Colored  Description\x1b[0m',
  ], '', '');
  assert.deepEqual(menu(frame).options.map(option => !!option.disabled), [false, true, false]);
  assert.equal(menu(frame.replace('s to use this session only', 'ctrl+s to use this session only')).sessionOnlyKey, undefined);
});

test('the exact offline Electron capture opens a native menu below a complete assistant answer and tmux padding', () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/settings/offline-demo-model-open.json', import.meta.url), 'utf8'));
  assert.equal(parseSettingScreen(capture.opening, 'model').state, 'unrecognized');
  const changed = newSettingViewport(capture.opening, priorComposerHistory(capture['before-open']));
  assert.deepEqual(menu(changed).options.map(item => item.label), ['Fixture Alpha', 'Fixture Beta']);
  assert.equal(newSettingViewport('⏺ A new example\n' + capture.opening, priorComposerHistory(capture['before-open'])), '⏺ A new example\n' + capture.opening);
});

test('resumed SSH native picker redraw moves the idle effort badge and changes the number of empty rows', () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/settings/ssh-resume-model-open.json', import.meta.url), 'utf8'));
  const baseline = priorComposerHistory(capture['282']);
  for (const seq of ['392', '1074']) {
    const changed = newSettingViewport(capture[seq], baseline);
    const parsed = menu(changed);
    assert.equal(parsed.displayCurrent, 'Sonnet');
    assert.equal(parsed.options.length, 5);
    assert.ok(parsed.options.every(option => !option.disabled));
  }
});

test('the SSH effort picker can replace the idle tmux advisory with a decorated or plain ruler below the same answer', () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/settings/ssh-effort-focus-events.json', import.meta.url), 'utf8'));
  const history = priorComposerHistory(capture.before);
  for (const frame of [capture.opening, capture.settled]) {
    assert.equal(parseSettingScreen(frame, 'effort').state, 'unrecognized');
    const parsed = parseSettingScreen(newSettingViewport(frame, history), 'effort');
    assert.equal(parsed.state, 'menu');
    if (parsed.state !== 'menu') assert.fail();
    assert.deepEqual(parsed.options.map(option => option.label), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(parsed.focusedKey, 'effort:medium');
    assert.equal(parsed.sessionOnlyKey, 's');
    const quoted = frame.replace('Recorded answer.', 'Here is an example menu.');
    assert.equal(newSettingViewport(quoted, history), quoted);
    assert.equal(parseSettingScreen(quoted, 'effort').state, 'unrecognized');
  }
  assert.ok(priorComposerHistory(capture.before.replace('tmux focus-events off', 'Unknown advisory'))
    .some(line => line.includes('Unknown advisory')));
});

test('the model picker scrolls idle history out of a full tmux pane', () => {
  // Captured 40-row before/opening frames with private history and models replaced.
  const capture = JSON.parse(readFileSync(new URL('./fixtures/settings/scrolled-model-open.json', import.meta.url), 'utf8'));
  const previous = priorComposerHistory(capture['before-open']);
  assert.equal(parseSettingScreen(capture.opening, 'model').state, 'unrecognized');
  const parsed = menu(newSettingViewport(capture.opening, previous));
  assert.equal(parsed.displayCurrent, 'Model 10');
  assert.equal(parsed.options.length, 10);
  assert.equal(parsed.moreAfterCount, 1);
  assert.equal(parsed.sessionOnlyKey, 's');
  for (const changed of [
    '⏺ New answer quoting the picker\n' + capture.opening,
    capture.opening.replace('Earlier result 15', 'New tool output'),
    capture.opening.replace('Earlier output line 31', 'Earlier output line 32'),
    capture.opening.replace('✻ Worked for 10s', '⏺ A copy from the transcript'),
    capture.opening.replace(/^▔+$/mu, 'A separator from an example:'),
  ]) {
    assert.equal(newSettingViewport(changed, previous), changed);
    assert.equal(parseSettingScreen(changed, 'model').state, 'unrecognized');
  }
  const stale = newSettingViewport(capture.opening + composer, previous);
  assert.equal(parseSettingScreen(stale, 'model').state, 'idle');
});

test('a named session border and right-aligned notices do not hide the typed setting command', () => {
  const width = 100;
  const titled = '─'.repeat(width - 14) + ' discuss umi ─';
  const right = (text: string) => ' '.repeat(width - text.length) + text;
  const box = (draft: string, footer: string) => `\n${titled}\n❯ ${draft}\n${'─'.repeat(width)}\n${footer}\n`;
  const idle = '  上一轮回复\n' + right('◐ medium · /effort') + box('', '  ? for shortcuts' + ' '.repeat(40) + 'Update available · restart to apply');
  assert.ok(isIdleEmptyComposer(idle));
  const suggestions = ['  ❯ /effort'.padEnd(40) + "Set the model's effort level", '    /team-report'.padEnd(40) + '汇总本周的提交和评审', '    /code-review'.padEnd(40) + 'Review the current diff'].join('\n');
  // The same frame as the reported screenshot: completion below the titled editor.
  const typed = '  上一轮回复\n' + box('/effort', suggestions);
  assert.ok(hasPendingSettingCommand(typed, '/effort', idle));
  // An IDE or update notice may appear or vanish between the two frames.
  const noticed = '  上一轮回复\n' + right('Visual Studio Code disconnected') + box('/effort', suggestions + '\n  ? for shortcuts' + ' '.repeat(30) + 'IDE disconnected');
  assert.ok(hasPendingSettingCommand(noticed, '/effort', idle.replace('Update available · restart to apply', '')));
  assert.deepEqual(priorComposerHistory(idle), ['  上一轮回复']);
  assert.equal(hasPendingSettingCommand(typed.replace('/effort\n', '/effort extra\n'), '/effort', idle), false);
});

test('a "Switch model?" dialog with the tmux advisory in its top border (2.1.300, 2.1.310) is still the confirmation', () => {
  for (const version of ['2.1.300', '2.1.310']) {
    // Captured in the matrix sandbox: an inline /model sonnet while a background subagent ran.
    const screen = readFileSync(new URL(`./fixtures/settings/model-confirmation-tmux-advisory-${version}.txt`, import.meta.url), 'utf8');
    assert.match(screen, /▔ tmux detected · scroll with PgUp\/PgDn · or add 'set -g mouse on' to ~\/\.tmux\.conf for wheel scroll ▔/u);
    const parsed = parseSettingScreen(screen, 'model');
    assert.deepEqual(parsed.state === 'model-confirmation' ? [parsed.targetLabel, parsed.focused, parsed.footerObserved] : parsed, ['Sonnet 5.5', 'confirm', false], version);
    // Only that advisory: any other long text there is not the dialog's border.
    assert.equal(parseSettingScreen(screen.replace('tmux detected', 'see the docs'), 'model').state, 'unrecognized');
  }
});
