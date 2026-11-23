import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKeyHints, parseNativeDialogLines } from '../src/core/native-dialog-screen';
import { parsePermissionScreen } from '../src/core/permission-screen';

// Native dialogs Lectern has no parser of its own for, read by their common layout. Real
// Claude Code 2.1.330 screens (120×40, loopback fake API in the cc-matrix sandbox): the project
// MCP server approval at startup (scripts: a .mcp.json in the folder), and the classifier billing
// notice, whose rewordings must still be readable.
const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
const mcp = fixture('native-dialog-2.1.330/mcp-server.txt');
const billing = fixture('auto-mode-billing-2.1.330/notice.txt');
const read = (text: string) => parseNativeDialogLines(text.split('\n'));
const RULE = '─'.repeat(120);

test('the MCP server approval: its title, text, unnumbered choices and key hints', () => {
  const dialog = read(mcp)!;
  assert.equal(dialog.title, 'New MCP server found in this project: demo-notes');
  assert.deepEqual(dialog.paragraphs, ['MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP documentation.']);
  assert.deepEqual(dialog.choices, [
    { label: 'Use this MCP server', focused: false },
    { label: 'Use this and all future MCP servers in this project', focused: false },
    { label: 'Continue without using this MCP server', focused: true },
  ]);
  assert.deepEqual(dialog.hints, [{ key: 'Enter', action: 'confirm' }, { key: 'Esc', action: 'cancel' }]);
  assert.equal(dialog.enter, 'confirm');
  assert.equal(dialog.escape, 'cancel');
  assert.equal(dialog.footer, 'Enter to confirm · Esc to cancel');
  // As a card: only on request (the caller has Claude Code's own "waiting"); choices numbered in screen order.
  assert.equal(parsePermissionScreen(mcp), undefined);
  const card = parsePermissionScreen(mcp, { generic: true })!;
  assert.equal(card.kind, 'native-dialog');
  assert.deepEqual(card.options.map(o => [o.number, o.label, o.focused, o.key]), [
    [1, 'Use this MCP server', false, undefined], [2, 'Use this and all future MCP servers in this project', false, undefined],
    [3, 'Continue without using this MCP server', true, undefined]]);
  assert.equal(card.escape, 'cancel');
  assert.deepEqual(card.subtitle, dialog.paragraphs);
});

test('a known dialog keeps its own card; a reworded one falls back to the generic card', () => {
  assert.equal(parsePermissionScreen(billing, { generic: true })?.kind, 'auto-mode-billing');
  // The 2.1.330 binary's other wording of the same notice (desktop app, gateway named).
  const reworded = billing
    .replace("We're changing auto mode to no longer charge for classifier requests in Claude Code.", 'Auto mode switched to its built-in safety check for this session')
    .replace(/ {2}However, this session isn't eligible[^\n]*\n[^\n]*\n/u, "  Auto mode is set to have actions checked through 127.0.0.1:34601, the server that connects you to Claude. In this\n  session those checks aren't working.\n");
  assert.equal(parsePermissionScreen(reworded), undefined, 'not the billing card');
  const card = parsePermissionScreen(reworded, { generic: true })!;
  assert.equal(card.kind, 'native-dialog');
  assert.equal(card.title, 'Auto mode switched to its built-in safety check for this session');
  assert.equal(card.subtitle[0], "Auto mode is set to have actions checked through 127.0.0.1:34601, the server that connects you to Claude. In this session those checks aren't working.");
  assert.equal(card.subtitle.at(-1), 'To fix it and access the new version of auto mode, ask your gateway to implement: https://code.claude.com/docs/en/auto-mode-classifier-billing');
  // No choices: Enter is option 1 with the screen's words, Esc the cancel.
  assert.deepEqual(card.options, [{ number: 1, label: 'continue', focused: false, key: 'Enter' }]);
  assert.equal(card.escape, 'cancel');
  // "Auto mode can't check actions" with a footer Lectern does not know: Enter and Esc still work.
  const unavailable = fixture('auto-mode-unavailable-2.1.330/dialog.txt').replace('Enter to stay in auto mode · shift+Tab to leave for accept edits mode and stop · Esc to cancel', 'Enter to stay · Tab to leave · Esc to cancel');
  const fallback = parsePermissionScreen(unavailable, { generic: true })!;
  assert.equal(fallback.kind, 'native-dialog');
  assert.deepEqual(fallback.options.map(o => [o.key, o.label]), [['Enter', 'stay']]);
});

test('numbered choices may wrap; key hints may wrap; a named session\'s rule may close the dialog', () => {
  const numbered = mcp.replace('    Use this MCP server\n', '    1. Use this MCP server\n')
    .replace('    Use this and all future MCP servers in this project\n', '    2. Use this and all future MCP servers in this project, which is a long label that a narrow\n       terminal wraps\n')
    .replace('  ❯ Continue without using this MCP server\n', '  ❯ 3. Continue without using this MCP server\n');
  const dialog = read(numbered)!;
  assert.deepEqual(dialog.choices.map(c => [c.label, c.focused]), [['Use this MCP server', false],
    ['Use this and all future MCP servers in this project, which is a long label that a narrow terminal wraps', false], ['Continue without using this MCP server', true]]);
  const wrapped = billing.replace('  Enter to continue · Esc to cancel', '  Enter to continue ·\n  Esc to cancel');
  assert.equal(read(wrapped)!.footer, 'Enter to continue · Esc to cancel');
  // The name's rule in any shape a long name gives it (editor-border.ts).
  for (const border of [`${'─'.repeat(105)} 示例会话名 ─`, `─── ${'n'.repeat(110)} ─`, ` ${'很长的会话名称'.repeat(8)}… ─`]) {
    const named = mcp.replace('  Enter to confirm · Esc to cancel\n', `  Enter to confirm · Esc to cancel\n\n${border}\n`);
    assert.equal(read(named)?.choices.length, 3, border);
  }
  // Only Esc: no Enter option, Esc is the way out.
  const notice = `${RULE}\n  Background tasks finished\n\n  Three tasks finished while you were away.\n\n  Esc to close\n`;
  const card = parsePermissionScreen(notice, { generic: true })!;
  assert.deepEqual(card.options, []);
  assert.equal(card.escape, 'close');
  // Wide characters across a wrap are joined without a space.
  assert.deepEqual(read(`${RULE}\n  示例对话框\n\n  这一段很长的说明在终端边缘\n  被折成两行。\n\n  Enter to continue\n`)!.paragraphs, ['这一段很长的说明在终端边缘被折成两行。']);
});

test('only a complete dialog at the bottom, below a full-width rule, is read; screens with an input box never are', () => {
  for (const [name, text] of [
    ['the input box after the notice', fixture('auto-mode-unavailable-2.1.300/billing-continued.txt')],
    ['an interrupted turn', fixture('auto-mode-unavailable-2.1.300/billing-cancelled.txt')],
    ['AskUserQuestion (its footer starts the row)', fixture('question-2.1.329/short.txt')],
    ['a reply working', `${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt\n`],
    ['only an Esc to interrupt', `${RULE}\n  Thinking\n\n  esc to interrupt\n`],
    ['no rule', mcp.replace(RULE, '')],
    ['a row at column 0', mcp.replace('  MCP servers may', 'MCP servers may')],
    ['two focused rows', mcp.replace('    Use this MCP server', '  ❯ Use this MCP server')],
    ['one choice', `${RULE}\n  Pick\n\n  ❯ Only this\n\n  Enter to confirm\n`],
    ['not key hints', mcp.replace('Enter to confirm · Esc to cancel', 'Enter the code shown in your browser')],
    ['hints without Enter or Esc', mcp.replace('Enter to confirm · Esc to cancel', 'Tab to switch · ctrl+g to edit')],
    ['something after the hints', mcp + '  Press any key\n'],
    ['a dialog quoted in a code block', `● Here is what it showed:\n\n  \`\`\`\n${mcp}`],
    ['too tall', `${RULE}\n  Title\n${'  line\n'.repeat(70)}  Enter to continue\n`],
  ] as const) assert.equal(read(text), undefined, name);
  // The same words quoted in a reply above an idle input box.
  const quoted = `● It asked:\n\n${mcp}\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
  assert.equal(read(quoted), undefined);
});

test('key hints are "<key> to <what>" joined by " · ", with Enter or Esc among them', () => {
  assert.deepEqual(parseKeyHints('Enter to select · ↑/↓ to navigate · Esc to cancel'), [{ key: 'Enter', action: 'select' }, { key: '↑/↓', action: 'navigate' }, { key: 'Esc', action: 'cancel' }]);
  assert.deepEqual(parseKeyHints('Enter to stay in auto mode · shift+Tab to leave for accept edits mode and stop · Esc to cancel')?.map(h => h.key), ['Enter', 'shift+Tab', 'Esc']);
  assert.deepEqual(parseKeyHints('Press Enter to continue…'), [{ key: 'Enter', action: 'continue' }]);
  assert.deepEqual(parseKeyHints('Esc to cancel · Tab to amend · ctrl+e to explain'), [{ key: 'Esc', action: 'cancel' }, { key: 'Tab', action: 'amend' }, { key: 'ctrl+e', action: 'explain' }]);
  for (const text of ['esc to interrupt', 'Tab to amend', 'Run the tests to see', 'Enter to continue · or not', '']) assert.equal(parseKeyHints(text), undefined, text);
});
