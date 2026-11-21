import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePath, outputRedirects, redirectFiles, resolveRedirect } from '../src/shared/shell-redirects';

const cwd = '/home/dev/proj';
const files = (command: string, dir = cwd) => redirectFiles(command, dir).map(file => [file.path, file.stream]);

test('output redirections: >, >>, &>, >&, >| and the order of 2>&1', () => {
  assert.deepEqual(files('npm test > out.log'), [[`${cwd}/out.log`, 'stdout']]);
  assert.deepEqual(files('npm test >> out.log 2>&1'), [[`${cwd}/out.log`, 'both']]);
  assert.equal(redirectFiles('npm test >> out.log 2>&1', cwd)[0].append, true);
  // stderr goes to the old stdout (the task's own output) before stdout moves.
  assert.deepEqual(files('npm test 2>&1 > out.log'), [[`${cwd}/out.log`, 'stdout']]);
  assert.deepEqual(files('npm test &> all.log'), [[`${cwd}/all.log`, 'both']]);
  assert.deepEqual(files('npm test &>> all.log'), [[`${cwd}/all.log`, 'both']]);
  assert.deepEqual(files('npm test >& all.log'), [[`${cwd}/all.log`, 'both']]);
  assert.deepEqual(files('echo x >| force.log'), [[`${cwd}/force.log`, 'stdout']]);
  assert.deepEqual(files('npm test 1>one.log'), [[`${cwd}/one.log`, 'stdout']]);
});

test('/dev targets, descriptors above 2 and closed streams are not output files', () => {
  assert.deepEqual(files('npm test 2>/dev/null'), []);
  assert.deepEqual(files('npm test > /dev/null 2>&1'), []);
  assert.deepEqual(files('npm test &>/dev/null'), []);
  assert.deepEqual(files('echo oops >&2'), []);
  assert.deepEqual(files('ls 3> fd3.log'), []);
  assert.deepEqual(files('cmd >&- 2>&-'), []);
  assert.deepEqual(files('npm test > out.log 2>/dev/null'), [[`${cwd}/out.log`, 'stdout']]);
});

test('several redirections: stdout files first, then stderr-only ones; one file named twice is one entry', () => {
  assert.deepEqual(files('nohup ./serve 2>serve.err 1>serve.out &'), [[`${cwd}/serve.out`, 'stdout'], [`${cwd}/serve.err`, 'stderr']]);
  assert.deepEqual(files('a > one.log; b > two.log'), [[`${cwd}/one.log`, 'stdout'], [`${cwd}/two.log`, 'stdout']]);
  assert.deepEqual(files('a > same.log; b 2> same.log'), [[`${cwd}/same.log`, 'both']]);
  assert.deepEqual(files('npm test 2> err.log'), [[`${cwd}/err.log`, 'stderr']]);
});

test('tee writes copies: options, -a, and tee after a prefix', () => {
  assert.deepEqual(files('npm test | tee build.log'), [[`${cwd}/build.log`, 'stdout']]);
  const append = redirectFiles('npm test 2>&1 | tee -a build.log > /dev/null', cwd);
  assert.deepEqual(append.map(file => [file.path, file.append, file.tee]), [[`${cwd}/build.log`, true, true]]);
  assert.deepEqual(files('make | sudo tee -- out.txt copy.txt'), [[`${cwd}/out.txt`, 'stdout'], [`${cwd}/copy.txt`, 'stdout']]);
  assert.deepEqual(files('tee < in.txt copy.txt'), [[`${cwd}/copy.txt`, 'stdout']]);
  assert.deepEqual(files('cat log | tee /dev/stderr'), []);
});

test('quotes, escapes, comments and heredoc bodies hide > from the parser', () => {
  assert.deepEqual(files('echo "a > b" > "my file.txt"'), [[`${cwd}/my file.txt`, 'stdout']]);
  assert.deepEqual(files("echo 'x > y'"), []);
  assert.deepEqual(files('echo a \\> b'), []);
  assert.deepEqual(files("echo $'tab\\t' > $'odd\\tname'"), [[`${cwd}/odd\tname`, 'stdout']]);
  assert.deepEqual(files('cmd # > comment.log'), []);
  assert.deepEqual(files('echo a#b > hash.log'), [[`${cwd}/hash.log`, 'stdout']]);
  assert.deepEqual(files('cat <<EOF > out.txt\nline > not-a-file\nEOF\necho done >> after.log'), [[`${cwd}/out.txt`, 'stdout'], [`${cwd}/after.log`, 'stdout']]);
  assert.deepEqual(files("cat > notes.md <<'END'\nhello >> nope\nEND"), [[`${cwd}/notes.md`, 'stdout']]);
  assert.deepEqual(files('cat <<-EOF > tabbed.txt\n\tbody > no\n\tEOF\n'), [[`${cwd}/tabbed.txt`, 'stdout']]);
  assert.deepEqual(files('grep x <<< "a > b"'), []);
  assert.deepEqual(files('sort <(ls) > sorted.txt'), [[`${cwd}/sorted.txt`, 'stdout']]);
  assert.deepEqual(files('cmd | tee >(gzip > z.gz)'), []);
  assert.deepEqual(files('long \\\n  --flag > continued.log'), [[`${cwd}/continued.log`, 'stdout']]);
});

test('expansions make a target unknown; $HOME and ~ stay as the home directory', () => {
  assert.deepEqual(files('echo $X > $OUT'), []);
  assert.deepEqual(files('echo hi > "$LOGDIR/x.log"'), []);
  assert.deepEqual(files('echo hi > log-$(date +%s).txt'), []);
  assert.deepEqual(files('echo hi > `name`.txt'), []);
  assert.deepEqual(files('echo hi > *.log'), []);
  assert.deepEqual(files('echo hi > out{1,2}.log'), []);
  assert.deepEqual(files('echo hi > ~user/x.log'), []);
  assert.deepEqual(files('echo hi > ~/x.log'), [['~/x.log', 'stdout']]);
  assert.deepEqual(files('echo hi > "$HOME/x.log"'), [['~/x.log', 'stdout']]);
  assert.deepEqual(files('echo hi > ${HOME}/y.log'), [['~/y.log', 'stdout']]);
  assert.deepEqual(files('echo hi > "{literal}.log"'), [[`${cwd}/{literal}.log`, 'stdout']]);
});

test('cd before the command: relative names follow it; a subshell keeps its cd, { } does not', () => {
  assert.deepEqual(files('cd build && make > make.log 2>&1'), [[`${cwd}/build/make.log`, 'both']]);
  assert.deepEqual(files('cd .. && cd other && run > x.log'), [['/home/dev/other/x.log', 'stdout']]);
  assert.deepEqual(files('(cd sub; ./run.sh > run.log); ./other > top.log'), [[`${cwd}/sub/run.log`, 'stdout'], [`${cwd}/top.log`, 'stdout']]);
  assert.deepEqual(files('{ cd sub; a; } > group.log; b > next.log'), [[`${cwd}/group.log`, 'stdout'], [`${cwd}/sub/next.log`, 'stdout']]);
  assert.deepEqual(files('( a; b ) > sub.log 2>&1'), [[`${cwd}/sub.log`, 'both']]);
  assert.deepEqual(files('cd /srv/app && run > app.log'), [['/srv/app/app.log', 'stdout']]);
  assert.deepEqual(files('cd && run > home.log'), [['~/home.log', 'stdout']]);
  // An unknown cd target leaves relative names unknown; absolute ones still count.
  assert.deepEqual(files('cd $DIR && run > rel.log; run > /abs/path.log'), [['/abs/path.log', 'stdout']]);
  assert.deepEqual(files('cd - && run > back.log'), []);
  assert.deepEqual(files('pushd lib && run > lib.log; popd; run > lost.log'), [[`${cwd}/lib/lib.log`, 'stdout']]);
  assert.deepEqual(files('FOO=1 cd sub && run > env.log'), [[`${cwd}/sub/env.log`, 'stdout']]);
});

test('exec, background jobs and groups; nothing to read from an empty or odd command', () => {
  assert.deepEqual(files('exec > script.log 2>&1\nls'), [[`${cwd}/script.log`, 'both']]);
  assert.deepEqual(files('python -u train.py > logs/train.log 2>&1 &'), [[`${cwd}/logs/train.log`, 'both']]);
  assert.deepEqual(files('{ a; b; } > group.log 2>&1'), [[`${cwd}/group.log`, 'both']]);
  assert.deepEqual(files(''), []);
  assert.deepEqual(files('ls >'), []);
  assert.deepEqual(redirectFiles(undefined), []);
  assert.equal(redirectFiles(Array.from({ length: 10 }, (_, i) => `a > f${i}.log`).join('; '), cwd).length, 6);
});

test('paths resolve against the command cwd, or stay relative without one', () => {
  assert.equal(normalizePath('/a/./b/../c'), '/a/c');
  assert.equal(normalizePath('/../x'), '/x');
  assert.equal(normalizePath('~/a/../../b'), '~/b');
  assert.equal(normalizePath('a/../../b'), '../b');
  assert.equal(normalizePath('./'), '.');
  const [target] = outputRedirects('cd build && make > ../out.log');
  assert.equal(resolveRedirect(target, cwd), `${cwd}/out.log`);
  assert.equal(resolveRedirect(target), 'out.log');
  assert.equal(resolveRedirect({ path: 'x', dir: undefined, stream: 'stdout', append: false }, cwd), undefined);
  assert.equal(resolveRedirect({ path: 'x', dir: '~/w', stream: 'stdout', append: false }, cwd), '~/w/x');
});
