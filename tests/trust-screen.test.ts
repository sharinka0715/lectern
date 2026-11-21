import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectoryTrust } from '../src/core/trust-screen';

// Native Claude Code 2.1.326 startup layout. Only the fixture path is replaced.
const captured = `
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /example/project

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

test('native trust chooser exposes the exact directory and its default No focus without authorizing an action', () => {
  const dialog = parseDirectoryTrust(captured);
  assert.ok(dialog);
  assert.equal(dialog.cwd, '/example/project');
  assert.equal(dialog.scope, 'unspecified');
  assert.equal(dialog.focused, 'exit');
  assert.equal(dialog.acceptLabel, 'Yes, I trust this folder');
  assert.equal(dialog.cancelLabel, 'No, exit');
  assert.equal(dialog.acceptIndex, 1);
  assert.equal(dialog.cancelIndex, 0);
  assert.equal(dialog.acceptOrdinal, undefined);
  assert.equal(dialog.cancelOrdinal, undefined);
  assert.equal(dialog.confirmKey, 'Enter');
  assert.equal(dialog.cancelKey, 'Escape');
  assert.ok(dialog.signature.includes('/example/project'));
});

test('native home-directory notice reports session-only scope solely from its explicit text', () => {
  const home = captured.replace('/example/project', '/Users/example').replace('files here.',
    'files here. This is your home folder, so Yes lasts for this session\n only.');
  const dialog = parseDirectoryTrust(home);
  assert.ok(dialog);
  assert.equal(dialog.cwd, '/Users/example');
  assert.equal(dialog.scope, 'session');
  assert.equal(dialog.focused, 'exit');
  assert.equal(dialog.acceptIndex, 1);
  assert.equal(parseDirectoryTrust(captured.replace('/example/project', '/Users/example'))?.scope, 'unspecified');
  assert.notEqual(dialog.signature, parseDirectoryTrust(captured.replace('/example/project', '/Users/example'))?.signature);
  assert.equal(parseDirectoryTrust(home.replace('this session\n only', 'all future sessions')), undefined);
});

test('trust selection, option ordering and observed ordinals are independent of approval', () => {
  const focused = captured.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust');
  assert.equal(parseDirectoryTrust(focused)?.focused, 'trust');
  assert.notEqual(parseDirectoryTrust(focused)?.signature, parseDirectoryTrust(captured)?.signature);
  const numbered = captured.replace('❯ No, exit\n   Yes, I trust this folder', '❯ 1. Yes, I trust this directory\n   2. No, exit');
  const dialog = parseDirectoryTrust(numbered);
  assert.ok(dialog);
  assert.equal(dialog.acceptIndex, 0);
  assert.equal(dialog.cancelIndex, 1);
  assert.equal(dialog.acceptOrdinal, 1);
  assert.equal(dialog.cancelOrdinal, 2);
  assert.equal(dialog.focused, 'trust');
});

test('trust parser preserves literal directory strings for backend comparison and rejects clipped or relative paths', () => {
  for (const cwd of ['/Users/example', '/tmp/a project/中文', '/tmp/nonbreaking\u00a0space', 'C:\\Users\\example', '\\\\host\\share\\folder']) {
    assert.equal(parseDirectoryTrust(captured.replace('/example/project', cwd))?.cwd, cwd);
  }
  for (const cwd of ['~/project', 'relative/path', '/example/\n project']) {
    assert.equal(parseDirectoryTrust(captured.replace('/example/project', cwd)), undefined);
  }
  assert.notEqual(parseDirectoryTrust(captured.replace('/example/project', '/different/path'))?.signature, parseDirectoryTrust(captured)?.signature);
});

test('generic permissions, partial trust text, ambiguous focus and unrelated overlays never become a trust action', () => {
  for (const altered of [
    'Do you trust this folder?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel',
    captured.replace('Accessing workspace:', 'Allow filesystem access?'),
    captured.replace("Claude Code'll be able to read, edit, and execute files here.", ''),
    captured.replace('Quick safety check:', 'Permission required:'),
    captured.replace('Security guide', 'Account access guide'),
    captured.replace('❯ No, exit', '  No, exit'),
    captured.replace('  Yes, I trust', '❯ Yes, I trust'),
    captured.replace('No, exit', 'No, keep running'),
    captured.replace('Enter to confirm · Esc to cancel', '3. Always allow\nEnter to confirm · Esc to cancel'),
    captured.replace('Enter to confirm · Esc to cancel', 'Enter to continue'),
    captured + 'Approve external account change? [Y/n]',
    captured + '────────────\n❯ draft\n────────────',
    '⏺ Here is an example:\n```text\n' + captured,
  ]) assert.equal(parseDirectoryTrust(altered), undefined, altered);
});

test('ANSI styling, tmux padding and wrapped safety prose preserve the same trust observation', () => {
  assert.deepEqual(parseDirectoryTrust('\x1b[33m' + captured + '\x1b[0m' + '\n'.repeat(40)), parseDirectoryTrust(captured));
  assert.deepEqual(parseDirectoryTrust(captured.replace('created or one you trust?', 'created or one\n you trust?')), parseDirectoryTrust(captured));
});

test('known project warnings are displayed in full and affect the decision signature', () => {
  const warnings = [
    '⚠ This folder pre-approves 2 tool permissions in .claude/settings.json:', 'Bash(npm test), Read',
    '⚠ This folder adds 1 directory to the workspace in .claude/settings.json:', '/example/extra',
    '⚠ This folder runs commands to mint HTTP headers (headersHelper), declared in .claude/settings.json',
    'These will apply without asking. Only proceed if you trust this configuration.',
  ];
  const frame = captured.replace('Security guide', warnings.join('\n') + '\n Security guide')
    .replace('No, exit', 'No, continue without these permissions');
  const dialog = parseDirectoryTrust(frame);
  assert.equal(dialog?.cancelDecision, 'continue');
  assert.equal(dialog?.focused, 'continue');
  assert.deepEqual(dialog?.warnings, warnings);
  assert.notEqual(parseDirectoryTrust(frame.replace('/example/extra', '/another'))?.signature, dialog?.signature);
  for (const prefix of ['⏺ Example:\n', '⏺ Bash(cat prompt)\n  ⎿ Output:\n', '⏺ Example:\n```\n']) {
    assert.equal(parseDirectoryTrust(prefix + frame), undefined);
  }
  for (const changed of [frame.replace(warnings[3], ''), frame.replace(warnings[0], 'A new warning'), frame.replace(warnings[5], 'Always allow this directory')]) {
    assert.equal(parseDirectoryTrust(changed), undefined);
  }
});

// Claude Code 2.1.327 (Linux) and 2.1.328 (macOS) captures. Only the paths are replaced.
// A folder with .claude/settings*.json or .mcp.json adds "Trusting this folder loads …",
// which used to hide the trust card entirely (HOME with user settings, most projects).
const loadsFrame = (cwd: string, extra: string, home = false) => `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 ${cwd}

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.${home ? ' This is your home folder, so Yes lasts for this session\n only.' : ''}
${extra}
 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

test('settings and MCP disclosures of newer Claude Code still produce the trust card, shown verbatim', () => {
  const home = parseDirectoryTrust(loadsFrame('/home/example', '\n Trusting this folder loads .claude/settings.json (sets environment variables).\n', true));
  assert.equal(home?.scope, 'session');
  assert.equal(home?.disclosure, 'Trusting this folder loads .claude/settings.json (sets environment variables).');
  assert.equal(home?.warnings, undefined);
  const hooks = parseDirectoryTrust(loadsFrame('/example/hooks', '\n Trusting this folder loads .claude/settings.local.json (runs commands).\n'));
  assert.equal(hooks?.scope, 'unspecified');
  assert.equal(hooks?.disclosure, 'Trusting this folder loads .claude/settings.local.json (runs commands).');
  const all = parseDirectoryTrust(loadsFrame('/example/all', `
 ⚠ This folder pre-approves 2 tool permissions in .claude/settings.json:
   Bash(ls:*) and Read(/tmp/**)

 ⚠ This folder adds 1 directory to the workspace in .claude/settings.json:
   /tmp

 These will apply without asking. Only proceed if you trust this configuration.

 Trusting this folder loads .claude/settings.json (runs commands and sets environment variables) and .mcp.json here or
 above (MCP servers).
`));
  assert.deepEqual(all?.warnings, ['⚠ This folder pre-approves 2 tool permissions in .claude/settings.json:', 'Bash(ls:*) and Read(/tmp/**)',
    '⚠ This folder adds 1 directory to the workspace in .claude/settings.json:', '/tmp', 'These will apply without asking. Only proceed if you trust this configuration.']);
  assert.equal(all?.disclosure, 'Trusting this folder loads .claude/settings.json (runs commands and sets environment variables) and .mcp.json here or above (MCP servers).');
  assert.equal(all?.focused, 'exit');
  // The disclosure is part of what the user approves.
  assert.notEqual(parseDirectoryTrust(loadsFrame('/example/hooks', '\n Trusting this folder loads .claude/settings.json (runs commands).\n'))?.signature, hooks?.signature);
});

test('a malformed or misplaced disclosure is not a trust card', () => {
  for (const extra of [
    '\n Trusting this folder loads .claude/settings.json (runs commands)\n', // no closing period
    '\n Trusting this folder loads ❯ Yes\n',
    '\n Trusting this folder loads .claude/settings.json.\n ⚠ This folder adds 1 directory to the workspace in .claude/settings.json:\n /tmp\n These will apply without asking. Only proceed if you trust this configuration.\n',
    '\n Something else loads .claude/settings.json (runs commands).\n',
  ]) assert.equal(parseDirectoryTrust(loadsFrame('/example/project', extra)), undefined, extra);
});
