import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactMarkdown } from '../src/renderer/ArtifactLinks';

const noop = () => {};
const render = (text: string) => renderToStaticMarkup(createElement(ArtifactMarkdown, { onOpen: noop, text }));
const formulas = (html: string) => (html.match(/class="katex"/g) ?? []).length;
const displays = (html: string) => (html.match(/class="katex-display"/g) ?? []).length;
const visible = (html: string) => html.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, '');

test('a $$ formula alone in a paragraph is set as a display formula: no emphasis from its _ and *', () => {
  const tex = String.raw`g=\frac1N\sum_i \hat A_i\sum_{t,k}\Big[\underbrace{\nabla_\theta\log\pi_\theta(y^k_{i,t}\mid c^k_{i,t})}_{\text{第一项：实际采到的 token 的 score}}-\underbrace{\mathbb E_{v\sim\mu(\cdot\mid c^k_{i,t})}\nabla_\theta\log\pi_\theta(v\mid c^k_{i,t})}_{\text{第二项：score 在 rollout 策略 }\mu\text{ 下的期望}}\Big]`;
  const html = render(`论文公式 (2) 是：\n\n$$ ${tex} $$\n\n第二项减去的是 **score 函数**。`);
  assert.equal(displays(html), 1);
  assert.equal(formulas(html), 1);
  assert.doesNotMatch(html, /<em>|katex-error/);
  assert.match(html, /<annotation encoding="application\/x-tex">/, 'the TeX source is kept for copying');
  assert.match(html, /<strong>score 函数<\/strong>/);
  // Fenced on their own lines, and inline in a sentence.
  assert.equal(displays(render('$$\na_i + b_i\n$$')), 1);
  const inline = render(String.raw`梯度 $\nabla_\theta \log \pi$ 和 $$x^2$$ 在句中。`);
  assert.equal(formulas(inline), 2);
  assert.equal(displays(inline), 0);
});

test('prices and shell variables stay text: one $ is a formula only as Pandoc reads it', () => {
  for (const text of ['costs $5 and $10 today', 'set $HOME and $PATH', 'price $ 5 $ x', 'from $1.5M to $2M', 'between $3$4 apart'])
    assert.equal(formulas(render(text)), 0, text);
  assert.equal(visible(render('costs $5 and $10 today')), 'costs $5 and $10 today');
  // The text after a $ that is not a formula is read again: its code span, emphasis and a later formula.
  const mixed = render('run $HOME with `cmd --x` and **bold** then $y$ ok');
  assert.match(mixed, /<code>cmd --x<\/code>/);
  assert.match(mixed, /<strong>bold<\/strong>/);
  assert.equal(formulas(mixed), 1);
  assert.equal(formulas(render('cost is $5. Then $x$ too')), 1);
  assert.equal(formulas(render('**cost $5 and $10** here')), 0);
  assert.match(render('a $5 x _b_ c'), /<em>b<\/em>/, 'text read again keeps its _emphasis_');
  assert.match(visible(render('price $ 5 $ x')), /^price \$ 5 \$ x$/);
  assert.match(render('**cost $5 and $10** here'), /<strong>cost \$5 and \$10<\/strong>/);
  // Code keeps its dollars; tildes stay text next to a formula.
  assert.match(render('`$x$` and\n\n```\necho $HOME $x$\n```'), /<code>\$x\$<\/code>[\s\S]*echo \$HOME \$x\$/);
  assert.equal(formulas(render('`$x$`')), 0);
  assert.match(visible(render('range 20~100 and ~3, with $x$')), /range 20~100 and ~3, with/);
});

test('a formula never runs trusted commands, and an invalid one shows its source', () => {
  // Which paths become links needs them checked on disk: artifacts-ui-e2e.mjs (verifyFormulas).
  assert.equal(formulas(render('see $a/b.ts$ and src/x.ts')), 1);
  const href = render(String.raw`$\href{javascript:alert(1)}{x}$ and $$\url{https://example.com}$$`);
  assert.doesNotMatch(href, /href="javascript|href="https:\/\/example\.com"/);
  const broken = render(String.raw`$$\frac{1}{$$`);
  assert.match(broken, /katex-error/);
  assert.match(visible(broken), /\\frac\{1\}\{/);
});
