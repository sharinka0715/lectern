import assert from 'node:assert/strict';
import test from 'node:test';
import { commandPolicy, goalCommand, slashCommandName } from '../src/shared/native-commands';
import { builtinCommandNotes, matchingCommands } from '../src/shared/completion-commands';

test('native slash commands follow the allow-list; installed skills need a machine check; paths are text', () => {
  assert.equal(slashCommandName('/compact keep the tests'), 'compact');
  assert.equal(slashCommandName('/tmp/report.txt 有问题吗'), undefined);
  assert.equal(slashCommandName('  /team-report'), 'team-report');
  assert.deepEqual(commandPolicy('请看 /model'), { kind: 'text' });
  for (const name of ['compact', 'context', 'cost', 'init', 'review', 'rename x']) assert.equal(commandPolicy('/' + name).kind, 'send', name);
  assert.deepEqual(commandPolicy('/model'), { kind: 'route', name: 'model', target: 'model' });
  assert.deepEqual(commandPolicy('/effort high'), { kind: 'route', name: 'effort', target: 'effort' });
  assert.equal(commandPolicy('/branch').kind, 'route');
  for (const name of ['help', 'config', 'permissions', 'mcp', 'resume', 'clear', 'exit', 'login', 'memory', 'agents', 'status', 'usage', 'vim', 'ide', 'doctor']) {
    const policy = commandPolicy('/' + name);
    assert.equal(policy.kind, 'block', name);
  }
  assert.match((commandPolicy('/clear') as { message: string }).message, /新建对话/);
  assert.deepEqual(commandPolicy('/team-report list'), { kind: 'installed', name: 'team-report' });
  assert.deepEqual(commandPolicy('/plugin:deploy'), { kind: 'installed', name: 'plugin:deploy' });
});

test('completion offers only usable built-ins plus installed skills', () => {
  const offered = matchingCommands('').map(item => item.value);
  assert.deepEqual(offered.slice(0, 2), ['compact', 'context']);
  for (const hidden of ['help', 'config', 'resume', 'clear', 'login']) assert.equal(offered.includes(hidden), false, hidden);
  assert.deepEqual(matchingCommands('team', [{ value: 'team-report', kind: 'command', source: 'user' }]).map(item => item.value), ['team-report']);
});

test("Claude Code's /goal: a condition and a clear are sent, the bare command opens Lectern's goal pill, an overlong condition stays", () => {
  assert.deepEqual(commandPolicy('/goal all tests pass'), { kind: 'send', name: 'goal' });
  for (const alias of ['clear', 'stop', 'off', 'reset', 'none', 'cancel', 'CLEAR']) {
    assert.deepEqual(commandPolicy('/goal ' + alias), { kind: 'send', name: 'goal' }, alias);
    assert.deepEqual(goalCommand('/goal ' + alias), { kind: 'clear' }, alias);
  }
  assert.deepEqual(commandPolicy('/goal'), { kind: 'route', name: 'goal', target: 'goal' });
  assert.deepEqual(commandPolicy('  /goal   '), { kind: 'route', name: 'goal', target: 'goal' });
  assert.deepEqual(goalCommand('/goal  pause the work '), { kind: 'set', condition: 'pause the work' }, 'pause and status are conditions');
  assert.equal(goalCommand('/goals x'), undefined);
  assert.equal(goalCommand('please /goal x'), undefined);
  assert.equal(commandPolicy('/goal ' + 'x'.repeat(4000)).kind, 'send');
  const long = commandPolicy('/goal ' + 'x'.repeat(4001));
  assert.equal(long.kind, 'block');
  assert.match((long as { message: string }).message, /4000.*4001/u);
  const goal = matchingCommands('go');
  assert.equal(goal[0]?.value, 'goal');
  assert.equal(builtinCommandNotes.goal, 'composer.goalNote');
});
