import assert from 'node:assert/strict';
import test from 'node:test';
import { shellTokens, type ShellTokenKind } from '../src/renderer/shell-tokens';

const kinds = (text: string) => shellTokens(text).filter(token => token.kind).map(token => [token.kind, token.text] as [ShellTokenKind, string]);
const of = (text: string, kind: ShellTokenKind) => shellTokens(text).filter(token => token.kind === kind).map(token => token.text);

test('tokens always join back to the command', () => {
  for (const text of [
    'D=/tmp/x/logs; until grep -q "全部完成" $D/edit.log || ! ps -p $(cat $D/edit.pid) > /dev/null; do sleep 10; done; tail -6 $D/edit.log',
    "echo 'unterminated",
    'echo "a \\" b',
    'x=$((1+2)) && printf "%s\\n" "${x}" 2>&1 | tee -a out.log &',
    'cat <<EOF\nline $HOME\nEOF',
    'ls \\\n  -la # list',
    'trailing\\',
    '$',
    '',
  ]) assert.equal(shellTokens(text).map(token => token.text).join(''), text, text);
});

test('the command, flags, variables, strings and operators are told apart', () => {
  const text = 'D=/tmp/x/logs; until grep -q "全部完成" $D/edit.log || ! ps -p $(cat $D/edit.pid) > /dev/null; do sleep 10; done; tail -6 $D/edit.log';
  assert.deepEqual(of(text, 'command'), ['grep', 'ps', 'cat', 'sleep', 'tail']);
  assert.deepEqual(of(text, 'keyword'), ['until', '!', 'do', 'done']);
  assert.deepEqual(of(text, 'assign'), ['D=']);
  assert.deepEqual(of(text, 'flag'), ['-q', '-p', '-6']);
  assert.deepEqual(of(text, 'variable'), ['$D', '$D', '$D']);
  assert.deepEqual(of(text, 'string'), ['"全部完成"']);
  assert.deepEqual(of(text, 'number'), ['10']);
  assert.deepEqual(of(text, 'operator'), [';', '||', '$(', ')', '>', ';', ';', ';']);
});

test('pipes and separators start a new command; redirections and flags do not', () => {
  assert.deepEqual(of('npm run build 2>&1 | tail -20 && echo done', 'command'), ['npm', 'tail', 'echo']);
  assert.deepEqual(of('npm run build 2>&1 | tail -20', 'operator'), ['2>&1', '|']);
  assert.deepEqual(of('sudo nohup python -u train.py --lr=3e-4 --out "$DIR/x" &', 'command'), ['sudo', 'nohup', 'python']);
  assert.deepEqual(of('python -u train.py --lr=3e-4 --out "$DIR/x"', 'flag'), ['-u', '--lr=', '--out']);
  assert.deepEqual(kinds('python --out "$DIR/x"').slice(-3), [['string', '"'], ['variable', '$DIR'], ['string', '/x"']]);
  assert.deepEqual(of('cd /tmp && FOO=1 BAR=2 make all', 'assign'), ['FOO=', 'BAR=']);
  assert.deepEqual(of('cd /tmp && FOO=1 BAR=2 make all', 'command'), ['cd', 'make']);
  assert.deepEqual(of('echo "#not" # real comment', 'comment'), ['# real comment']);
  assert.deepEqual(of('for f in *.log; do wc -l "$f"; done', 'command'), ['wc']);
  assert.deepEqual(of('ssh host "ls"\nls -la', 'command'), ['ssh', 'ls']);
  assert.deepEqual(of('x$(date +%s)', 'command'), ['x', 'date']);
  assert.deepEqual(of('timeout 10m nice -n 5 make -j8', 'command'), ['timeout', 'nice', 'make']);
  assert.deepEqual(of('timeout 10m nice -n 5 make -j8', 'flag'), ['-n', '-j8']);
});
