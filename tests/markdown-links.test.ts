import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactMarkdown } from '../src/renderer/ArtifactLinks';

const render = (text: string) => renderToStaticMarkup(createElement(ArtifactMarkdown, { onOpen: () => {}, text }));
const links = (html: string) => [...html.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(match => [match[1], match[2]]);

test('a bare link ends at CJK punctuation, so the ** around it is bold again', () => {
  const html = render('- 地址是 **http://127.0.0.1:8810/**。从你自己的电脑访问，需要用 VS Code 端口转发或 `ssh -L 8810:127.0.0.1:8810` 把端口带出来。');
  assert.deepEqual(links(html), [['http://127.0.0.1:8810/', 'http://127.0.0.1:8810/']]);
  assert.match(html, /<strong><a href="http:\/\/127\.0\.0\.1:8810\/"[^>]*>http:\/\/127\.0\.0\.1:8810\/<\/a><\/strong>。从你自己的电脑访问，需要用 VS Code/);
  assert.doesNotMatch(html, /\*\*/);
  assert.match(html, /<code>ssh -L 8810:127\.0\.0\.1:8810<\/code>/);
  assert.deepEqual(links(render('访问 https://example.com/a?b=1，然后重启。')), [['https://example.com/a?b=1', 'https://example.com/a?b=1']]);
  assert.deepEqual(links(render('打开 www.example.com。')), [['http://www.example.com', 'www.example.com']]);
  assert.deepEqual(links(render('**http://a.dev/**、**http://b.dev/x**（备用）')).map(([href]) => href), ['http://a.dev/', 'http://b.dev/x']);
  assert.equal((render('**http://a.dev/**、**http://b.dev/x**（备用）').match(/<strong><a /g) ?? []).length, 2);
  // A link inside emphasis read again, then another bare link after it in the same paragraph.
  const nested = render('*见 http://a.dev/。* 再看 **https://b.dev/x**，好。');
  assert.deepEqual(links(nested).map(([href]) => href), ['http://a.dev/', 'https://b.dev/x']);
  assert.match(nested, /<em>见 <a [^>]*>http:\/\/a\.dev\/<\/a>。<\/em> 再看 <strong><a [^>]*>https:\/\/b\.dev\/x<\/a><\/strong>，好。/);
});

test('CJK letters, plain GFM endings, angle brackets and code keep their links as before', () => {
  assert.deepEqual(links(render('见 https://zh.wikipedia.org/wiki/数学 了解')), [['https://zh.wikipedia.org/wiki/%E6%95%B0%E5%AD%A6', 'https://zh.wikipedia.org/wiki/数学']]);
  assert.deepEqual(links(render('see https://example.com/x. Then (https://example.com/y).')).map(([href]) => href), ['https://example.com/x', 'https://example.com/y']);
  assert.deepEqual(links(render('<http://a.dev/中。文>')), [['http://a.dev/%E4%B8%AD%E3%80%82%E6%96%87', 'http://a.dev/中。文']]);
  assert.equal(links(render('`http://a.dev/。x`')).length, 0);
  assert.deepEqual(links(render('[文档](http://a.dev/。x)')), [['http://a.dev/%E3%80%82x', '文档']]);
});

test('in a table cell and a heading, next to formulas and tildes', () => {
  const table = render('| 地址 | 说明 |\n| --- | --- |\n| **http://x.dev/**：本地 | 20~100 次 |');
  assert.match(table, /<td><strong><a href="http:\/\/x\.dev\/"[^>]*>http:\/\/x\.dev\/<\/a><\/strong>：本地<\/td>/);
  assert.match(table, /<td>20~100 次<\/td>/);
  assert.match(render('## 打开 http://x.dev/。'), /<h2>打开 <a href="http:\/\/x\.dev\/"[^>]*>http:\/\/x\.dev\/<\/a>。<\/h2>/);
  const mixed = render('费用 $5，见 **http://a.dev/**。约 ~3 次，公式 $x$。');
  assert.match(mixed, /费用 \$5，见 <strong><a href="http:\/\/a\.dev\/"/);
  assert.match(mixed, /约 ~3 次/);
  assert.equal((mixed.match(/class="katex"/g) ?? []).length, 1);
});
