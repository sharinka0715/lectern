import test from 'node:test';
import assert from 'node:assert/strict';
import nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePermissionScreen } from '../src/core/permission-screen';
import { linkSegments } from '../src/renderer/LinkedText';
import type { NativePermissionScreen, PermissionSnapshot } from '../src/shared/native-permission';

// Node has no CSS loader; the renderer normally gets this stylesheet via Vite.
const cssHook = nodeModule.registerHooks?.({ load(url, context, next) {
  return url.endsWith('/question-card.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
// registerHooks first appeared in 22.15; the project's minimum is 22.12.
if (!cssHook) nodeModule.register(`data:text/javascript,${encodeURIComponent("export function load(url, context, next) { return url.endsWith('/question-card.css') ? {format:'module',source:'',shortCircuit:true} : next(url,context); }")}`);
const { PermissionCard } = await import('../src/renderer/PermissionCard');
cssHook?.deregister();

const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
const render = (screen: NativePermissionScreen) => renderToStaticMarkup(createElement(PermissionCard, {
  permission: { ...screen, token: 'token' } as PermissionSnapshot, busy: false, onAction: async () => {}, onViewTerminal() {} }));
const text = (html: string) => html.replace(/<[^>]+>/gu, ' ').replace(/&#x27;/gu, "'").replace(/&quot;/gu, '"').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ');

test('addresses in plain text become links; trailing sentence punctuation stays text', () => {
  assert.deepEqual(linkSegments('ask your gateway to implement: https://code.claude.com/docs/en/auto-mode-classifier-billing'),
    [{ text: 'ask your gateway to implement: ' }, { text: 'https://code.claude.com/docs/en/auto-mode-classifier-billing', href: 'https://code.claude.com/docs/en/auto-mode-classifier-billing' }]);
  assert.deepEqual(linkSegments('See https://example.com/a#b. Or (http://example.com/x), then 「https://example.com/中」。'), [
    { text: 'See ' }, { text: 'https://example.com/a#b', href: 'https://example.com/a#b' }, { text: '. Or (' },
    { text: 'http://example.com/x', href: 'http://example.com/x' }, { text: '), then 「' }, { text: 'https://example.com/中', href: 'https://example.com/中' }, { text: '」。' }]);
  for (const plain of ['no links here', 'file:///etc/passwd and javascript:alert(1)', 'https:// alone']) assert.deepEqual(linkSegments(plain), [{ text: plain }]);
});

test('the billing notice card: Claude Code\'s words with a working link, Continue (Enter) and Cancel (Esc)', () => {
  const html = render(parsePermissionScreen(fixture('auto-mode-billing-2.1.330/streamed.txt'))!);
  assert.match(html, /data-permission-kind="auto-mode-billing"/);
  assert.match(html, /<a href="https:\/\/code\.claude\.com\/docs\/en\/auto-mode-classifier-billing" target="_blank" rel="noreferrer noopener">/);
  const words = text(html);
  assert.match(words, /auto mode 计费说明/);
  assert.match(words, /Auto mode works for now, and its classifier requests are billed as before\./);
  assert.match(words, /Enter 继续 这个操作经本地安全检查后照常运行/);
  assert.match(words, /Esc 取消 中断本轮，这个操作不运行/);
  assert.equal((html.match(/data-permission-cancel="Escape"/gu) ?? []).length, 1, 'Esc is one of the choices, not a separate button');
});

test('a dialog Lectern does not know: its own words and key hints, its choices, and Esc as the screen names it', () => {
  const mcp = render(parsePermissionScreen(fixture('native-dialog-2.1.330/mcp-server.txt'), { generic: true })!);
  assert.match(mcp, /data-permission-kind="native-dialog"/);
  const words = text(mcp);
  assert.match(words, /Claude Code 对话框/);
  assert.match(words, /Lectern 不认识的对话框/);
  assert.match(words, /New MCP server found in this project: demo-notes/);
  assert.match(words, /Enter to confirm · Esc to cancel/);
  assert.match(words, /选一项：Lectern 在终端里用方向键移到这一项再按 Enter/);
  assert.deepEqual([...mcp.matchAll(/data-permission-option="(\d)"/gu)].map(m => m[1]), ['1', '2', '3']);
  assert.match(mcp, /aria-pressed="true"[^>]*data-permission-option="3"/, 'the native focus is shown');
  assert.match(words, /Esc cancel 在终端按 Esc/);
  // Keyed: Enter with the screen's words; without "Esc to …" there is no way to cancel on the card.
  const keyed = parsePermissionScreen(fixture('auto-mode-billing-2.1.330/streamed.txt')
    .replace("We're changing auto mode to no longer charge for classifier requests in Claude Code.", 'Auto mode switched to its built-in safety check for this session')
    .replace('Enter to continue · Esc to cancel', 'Enter to continue'), { generic: true })!;
  const html = render(keyed);
  assert.match(text(html), /Enter continue 在终端按 Enter/);
  assert.match(html, /<a href="https:\/\/code\.claude\.com\/docs\/en\/auto-mode-classifier-billing"/);
  assert.doesNotMatch(html, /data-permission-cancel/);
  assert.doesNotMatch(text(html), /取消（Esc）/);
});
