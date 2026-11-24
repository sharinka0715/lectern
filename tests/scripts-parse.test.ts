import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Many scripts under scripts/ are opt-in specials that nothing runs on CI (real SSH hosts,
// real model requests). native-ssh-continue.mjs failed to parse from 0.2.0 on ("Identifier
// 'folder' has already been declared") and nobody noticed. This runs Node's own parser
// (`node --check`, the same V8 early errors as running the file) on every .mjs/.cjs under
// scripts/, subfolders included. Nothing executes; it needs no POSIX tools, so Windows runs it.
const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const env = { ...process.env };
delete env.NODE_OPTIONS; // tsx's loader is not needed to parse plain JavaScript.

/** The parse error of a file, or undefined when Node accepts it. */
function check(file: string): Promise<string | undefined> {
  return new Promise(resolve => execFile(process.execPath, ['--check', file], { env, timeout: 30_000 }, (error, _out, stderr) =>
    resolve(error ? (String(stderr).trim() || String(error)).split('\n').filter(Boolean).slice(0, 6).join('\n') : undefined)));
}

/** `file: error` for each file that fails, a few at a time. */
async function failures(files: string[], label = (file: string) => file): Promise<string[]> {
  const found: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < files.length) {
      const file = files[next++];
      const error = await check(file);
      if (error) found.push(`${label(file)}: ${error}`);
    }
  }));
  return found.sort();
}

test('the check rejects a redeclared const and accepts valid ES modules and CommonJS', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lectern-parse-'));
  try {
    const write = (name: string, source: string) => { writeFileSync(path.join(dir, name), source); return path.join(dir, name); };
    const bad = write('redeclared.mjs', "const folder = 1;\nawait Promise.resolve();\nconst folder = 2;\n");
    const good = [write('ok.mjs', "import path from 'node:path';\nexport const x = path.sep;\nawait 0;\n"), write('ok.cjs', "module.exports = require('node:path').sep;\n")];
    const found = await failures([bad, ...good], file => path.basename(file));
    assert.equal(found.length, 1, found.join('\n'));
    assert.match(found[0], /^redeclared\.mjs: [\s\S]*SyntaxError: Identifier 'folder' has already been declared/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every .mjs and .cjs under scripts/ parses', { timeout: 120_000 }, async () => {
  const files = readdirSync(scripts, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.[mc]js$/.test(file) && !file.split(/[\\/]/).includes('node_modules'))
    .map(file => file.split(path.sep).join('/')).sort();
  for (const expected of ['native-ssh-continue.mjs', 'cc-matrix/app.mjs', 'fixtures/electron.mjs', 'mac-sign.cjs']) assert.ok(files.includes(expected), `${expected} is checked`);
  assert.deepEqual(await failures(files.map(file => path.join(scripts, file)), file => path.relative(scripts, file).split(path.sep).join('/')), []);
});
