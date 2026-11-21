import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';

// macOS /bin/sh is bash 3.2. Inside $( … ) it takes the `)` of a case pattern without a
// leading `(` for the end of the command substitution: "syntax error near unexpected token
// `;;'", and the whole remote command fails (the session poll did, on every Mac target).
// So every shell `case` in src writes its patterns as `(pattern)`, which POSIX allows.
// A static scan of the sources: it covers every script however it is composed, on any CI
// runner (no bash 3.2 on Linux or Windows), and costs a few milliseconds.
const CASE = /\bcase\s+(?:"(?:[^"\\\n]|\\.)*"|\$[\w{}#%@*?]+)\s+in\b/g;
const WORD = new RegExp(`${CASE.source}|\\besac\\b`, 'g');

/** `file:line` of each case pattern list without a leading `(`, and of each case without its `esac`. */
function caseWithoutParens(source: string, file = 'source'): string[] {
  const at = (index: number) => `${file}:${source.slice(0, index).split('\n').length}`;
  const found = new Set<string>();
  for (const open of source.matchAll(CASE)) {
    const start = open.index! + open[0].length;
    WORD.lastIndex = start;
    let depth = 1, end = -1;
    for (let word = WORD.exec(source); word; word = WORD.exec(source)) {
      depth += word[0] === 'esac' ? -1 : 1;
      if (!depth) { end = word.index; break; }
    }
    if (end < 0) { found.add(`${at(open.index!)} (no esac)`); continue; }
    // The first pattern list, and the one after each `;;` up to this case's `esac`.
    const body = source.slice(start, end);
    for (const after of [0, ...[...body.matchAll(/;;/g)].map(match => match.index! + 2)]) {
      const next = /^\s*(\S)/.exec(body.slice(after));
      if (next && next[1] !== '(' && !/^\s*esac\b/.test(body.slice(after))) found.add(at(start + after + next[0].length - 1));
    }
  }
  return [...found];
}

test('the scan finds case patterns without a leading parenthesis, nested ones too', () => {
  assert.deepEqual(caseWithoutParens(`x=$(case "$a" in (b) ;; (*) case $c in (d) y;; esac;; esac)`), []);
  assert.deepEqual(caseWithoutParens(`x=$(case "$a" in b) ;;\n *) z;; esac)`), ['source:1', 'source:2']);
  assert.deepEqual(caseWithoutParens(`case "\${a}" in (b) case $c in d) y;; esac;; esac`), ['source:1']);
  assert.deepEqual(caseWithoutParens(`case "$a" in (b) y;;`), ['source:1 (no esac)']);
  assert.deepEqual(caseWithoutParens(`// just in case the pane in the window closes\nswitch (x) { case 'a': break; }`), []);
});

test('every shell case in src has a leading parenthesis on each pattern list (bash 3.2 inside $( … ))', () => {
  const files = readdirSync(new URL('../src/', import.meta.url), { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file));
  assert.ok(files.length > 100, 'src is scanned');
  assert.deepEqual(files.flatMap(file => caseWithoutParens(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), `src/${file}`)), []);
});
