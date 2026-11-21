import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSedScript, sedEdit, shellWords } from '../src/shared/sed-edit';
import { toolActivity } from '../src/renderer/reply-activities';

test('in-place sed is recognized in GNU and BSD forms, with cd prefixes and several expressions', () => {
  assert.deepEqual(sedEdit("sed -i 's/^\\.danger-button { old }$/.danger-button { new }/' src/renderer/context-menu.css"), {
    files: ['src/renderer/context-menu.css'], edits: [{ old_string: '^\\.danger-button { old }$', new_string: '.danger-button { new }' }], notes: [], regex: 'basic' });
  const bsd = sedEdit("cd /repo && sed -i '' -e 's|a/b|c/d|g' -e '3d' one.ts two.ts 2>&1");
  assert.deepEqual(bsd?.files, ['one.ts', 'two.ts']);
  assert.deepEqual(bsd?.edits, [{ old_string: 'a/b', new_string: 'c/d', replace_all: true }]);
  assert.deepEqual(bsd?.notes, ['删除第 3 行']);
  assert.deepEqual(sedEdit("sed -i.bak -E 's/(foo)+/bar/' f.txt")?.regex, 'extended');
  assert.deepEqual(sedEdit("sed -Ei 's/x/y/' f.txt")?.files, ['f.txt']);
  assert.deepEqual(sedEdit('sed -i "s/old\\/path/new/" "file name.md"')?.edits, [{ old_string: 'old/path', new_string: 'new' }]);
  assert.deepEqual(sedEdit("sed --in-place --expression='12s/a/b/' x")?.notes, ['替换只作用于第 12 行']);
});

test('insertions, deletions and addressed edits are described; other sed scripts stay raw', () => {
  const ops = sedEdit("sed -i '/^import/d; $a\\export default x' main.ts");
  assert.deepEqual(ops?.edits, [{ old_string: '', new_string: 'export default x' }]);
  assert.deepEqual(ops?.notes, ['删除地址 /^import/匹配的行', '在其后追加：最后一行']);
  const unknown = sedEdit("sed -i 'y/abc/xyz/' f");
  assert.deepEqual(unknown?.files, ['f']);
  assert.match(unknown?.notes[0] ?? '', /未能解析的 sed 脚本/);
  assert.deepEqual(parseSedScript('1,5s/a/b/g'), [{ kind: 's', address: '1,5', pattern: 'a', replacement: 'b', flags: 'g' }]);
  assert.equal(parseSedScript('s/a/b/w out.txt'), undefined, 'writing another file is not described');
});

test('read-only sed, unknown shell constructs and redirection targets are not edits', () => {
  for (const command of ["sed -n '880,930p' src/main/controller.ts", 'sed s/a/b/ file > out.txt', 'grep x f | sed s/a/b/',
    'sed -i "s/$(date)/x/" f', "sed -i -f script.sed f", 'echo sed -i', "sed -i 's/a/b/'"]) {
    assert.equal(sedEdit(command), undefined, command);
  }
  assert.deepEqual(shellWords("a 'b c' \"d\\\"e\" f\\ g && h 2>&1 > /dev/null; i"), [
    { word: 'a' }, { word: 'b c' }, { word: 'd"e' }, { word: 'f g' }, { op: '&&' }, { word: 'h' }, { op: 'dup' }, { op: 'redirect' }, { word: '/dev/null' }, { op: ';' }, { word: 'i' }]);
});

test('the chat shows an in-place sed as an edit of its file', () => {
  const tool = { id: 't', name: 'Bash', input: JSON.stringify({ command: "sed -i 's/a/b/' src/x.ts src/y.ts", description: 'Rename' }), result: '' };
  const row = toolActivity(tool);
  assert.equal(row.category, 'write');
  assert.equal(row.verb, '编辑');
  assert.equal(row.file, 'src/x.ts');
  assert.equal(row.subject, '等 2 个文件 · sed');
  assert.equal(toolActivity({ ...tool, input: JSON.stringify({ command: "sed -n '1,5p' src/x.ts" }) }).category, 'command');
});
