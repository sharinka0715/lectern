import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodePreview, codeLanguage } from '../src/renderer/CodePreview';
import { highlightLines } from '../src/renderer/syntax-highlight';
import { defaultPreview, loadDesktopState } from '../src/renderer/desktop-state';

test('file names pick a grammar; unknown names stay plain', () => {
  assert.equal(codeLanguage('train.py'), 'python');
  assert.equal(codeLanguage('App.TSX'), 'typescript');
  assert.equal(codeLanguage('kernel.cu'), 'cpp');
  assert.equal(codeLanguage('Dockerfile'), 'dockerfile');
  assert.equal(codeLanguage('CMakeLists.txt'), 'cmake');
  assert.equal(codeLanguage('notes.txt'), undefined);
  assert.equal(codeLanguage('LICENSE'), undefined);
});

test('highlighted tokens are cut at newlines and keep their classes on each line', () => {
  const lines = highlightLines('/* first\n second */\nconst answer = "42";\n', 'javascript');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], [{ text: '/* first', className: 'hljs-comment' }]);
  assert.deepEqual(lines[1], [{ text: ' second */', className: 'hljs-comment' }]);
  assert.deepEqual(lines[2].find(s => s.text === 'const'), { text: 'const', className: 'hljs-keyword' });
  assert.deepEqual(lines[2].find(s => s.text === '"42"'), { text: '"42"', className: 'hljs-string' });
  assert.equal(lines[2].map(s => s.text).join(''), 'const answer = "42";');
  assert.deepEqual(lines[3], []);
});

test('the code view shows the plain text at once, one box per line, without a trailing empty line', () => {
  const html = renderToStaticMarkup(createElement(CodePreview, { text: 'a = 1\n\nprint(a)\n', name: 'x.py', highlight: true, lineNumbers: true, wrap: true }));
  assert.match(html, /^<pre class="code-preview" data-wrap="true" data-line-numbers="true" data-language="python"/);
  assert.equal((html.match(/class="code-line"/g) ?? []).length, 3);
  assert.match(html, /<span class="code-text">a = 1\n<\/span>.*<span class="code-text">\n<\/span>.*<span class="code-text">print\(a\)\n<\/span>/s);
  // Line numbers are generated content, so the copied text is the file's own.
  assert.doesNotMatch(html, />1</);
  const plain = renderToStaticMarkup(createElement(CodePreview, { text: 'x', name: 'x.py', highlight: false, lineNumbers: false, wrap: false }));
  assert.match(plain, /data-wrap="false" data-line-numbers="false"/);
  assert.doesNotMatch(plain, /data-language/);
});

test('preview settings keep valid values and fall back per field', () => {
  const read = (value: unknown) => loadDesktopState({ getItem: () => JSON.stringify(value) });
  const fresh = loadDesktopState({ getItem: () => null });
  for (const key of Object.keys(defaultPreview) as (keyof typeof defaultPreview)[]) assert.equal(fresh[key], defaultPreview[key]);
  const saved = read({ previewCodeFontSize: 11, previewCodeLineHeight: 182, previewTextFontSize: 99, previewWrap: false, previewLineNumbers: 'no', previewHighlight: false });
  assert.equal(saved.previewCodeFontSize, 11);
  assert.equal(saved.previewCodeLineHeight, 180, 'snapped to the 5% step');
  assert.equal(saved.previewTextFontSize, 20, 'clamped to the range');
  assert.equal(saved.previewWrap, false);
  assert.equal(saved.previewLineNumbers, true, 'a non-boolean keeps the default');
  assert.equal(saved.previewHighlight, false);
});

test('the preview line height defaults to 140%; a saved height stays', () => {
  const read = (value: unknown) => loadDesktopState({ getItem: () => JSON.stringify(value) });
  assert.equal(defaultPreview.previewCodeLineHeight, 140);
  assert.equal(defaultPreview.previewTextLineHeight, 140);
  const chosen = read({ previewCodeLineHeight: 160, previewTextLineHeight: 165 });
  assert.deepEqual([chosen.previewCodeLineHeight, chosen.previewTextLineHeight], [160, 165]);
});
