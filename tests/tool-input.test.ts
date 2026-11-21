import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolInput } from '../src/renderer/ToolInput';

const render = (name: string, input: unknown) => renderToStaticMarkup(createElement(ToolInput, {
  tool: { id: 't', name, input: typeof input === 'string' ? input : JSON.stringify(input, null, 2) }, onOpen: () => {} }));

test('a command shows its description, real line breaks (coloured) and flags, not JSON', () => {
  const html = render('Bash', { command: "python -u - <<'EOF'\nprint(1)\nEOF", description: 'Rank checkpoints', timeout: 300000, run_in_background: true });
  assert.match(html, /class="tool-input-caption">Rank checkpoints</);
  const command = /<pre class="shell-code">(.*?)<\/pre>/s.exec(html)![1];
  assert.equal(command.replace(/<[^>]+>/g, ''), 'python -u - &lt;&lt;&#x27;EOF&#x27;\nprint(1)\nEOF');
  assert.match(command, /<span class="sh-command">python<\/span> <span class="sh-flag">-u<\/span>/);
  assert.match(html, />后台运行</); assert.match(html, />时限 5 分钟</);
  assert.doesNotMatch(html, /&quot;command&quot;|\\n|timeout/);
});

test('files, patterns and tasks show the fields that matter', () => {
  const read = render('Read', { file_path: '/work/a.md', offset: 10, limit: 20 });
  assert.match(read, /tool-field-label">文件<\/span><div class="tool-field-value">\/work\/a.md</); assert.match(read, />第 10–29 行</);
  const grep = render('Grep', { pattern: 'TODO\\(', path: '/work', output_mode: 'files_with_matches', '-i': true, '-n': true });
  assert.match(grep, /class="tool-inline-code">TODO\\\(</); assert.match(grep, />只列文件</); assert.match(grep, />忽略大小写</);
  assert.doesNotMatch(grep, /-n/);
  const agent = render('Agent', { description: '查资料', prompt: '找出\n三个来源', subagent_type: 'Explore', run_in_background: true });
  assert.match(agent, />查资料</); assert.match(agent, />Explore</); assert.match(agent, /class="tool-prose">找出\n三个来源</);
  const todos = render('TodoWrite', { todos: [{ content: '读代码', status: 'completed' }, { content: '改样式', status: 'in_progress' }] });
  assert.match(todos, /<li data-status="completed">读代码<\/li><li data-status="in_progress">改样式<\/li>/);
});

test('other tools list their fields; arguments that are not an object stay verbatim', () => {
  const html = render('mcp__docs__search', { query: 'release notes', limit: 5, filters: { lang: 'zh' } });
  assert.match(html, /tool-field-label">搜索<\/span><div class="tool-field-value">release notes</);
  assert.match(html, /tool-field-label">limit<\/span><div class="tool-field-value">5</);
  assert.match(html, /<pre>\{\n  &quot;lang&quot;: &quot;zh&quot;\n\}<\/pre>/);
  assert.match(render('Bash', '{"command": "unterminated'), /<pre>\{&quot;command&quot;: &quot;unterminated<\/pre>/);
  assert.equal(render('Bash', ''), '');
});
