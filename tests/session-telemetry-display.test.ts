import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionTelemetryDisplay, usageLevel } from '../src/renderer/SessionTelemetryDisplay';
import type { SessionSnapshot } from '../src/shared/types';
import { setLocale } from '../src/shared/i18n';

const statusLine = { sessionId: 'sample', modelId: 'test-model', contextWindowSize: 1000000 };
const contextUsage: NonNullable<SessionSnapshot['contextUsage']> = {
  inputTokens: 1000, cacheReadInputTokens: 27000, cacheCreationInputTokens: 1000,
  totalInputTokens: 29000, outputTokens: 8000, source: 'jsonl-last-request',
  windowTokens: null, usedPercent: null,
};
function render(fields: Partial<SessionSnapshot> & { showCacheTtl?: boolean; showSubscriptionQuota?: boolean }) {
  return renderToStaticMarkup(createElement(SessionTelemetryDisplay, fields));
}
function native(fields: Partial<NonNullable<SessionSnapshot['statusLine']>>) {
  return render({ statusLineManaged: true, statusLine: { ...statusLine, ...fields } });
}

test('historical input shows exact tokens and an unknown capacity without a determinate bar', () => {
  const html = render({ contextUsage });
  assert.match(html, /上下文输入/);
  assert.match(html, />29,000 tokens</);
  assert.match(html, /data-context-input-tokens="29000"/);
  assert.match(html, /新输入 1,000 · 缓存读取 27,000 · 缓存写入 1,000/);
  assert.match(html, /容量未知/);
  assert.doesNotMatch(html, /37,000|8000|8,000|%|<progress/);
});

test('missing telemetry and last-observed native mode are identified', () => {
  const unknown = render({});
  assert.match(unknown, /未知权限模式/);
  assert.match(unknown, /用量未知/);
  assert.doesNotMatch(unknown, /手动|自动|0%|<progress/);
  const observed = render({ executionMode: { mode: 'plan', label: '计划模式', source: 'native-footer', evidence: 'plan mode on' }, executionModeLastObserved: true });
  assert.match(observed, /data-execution-mode="plan"/);
  assert.match(observed, /计划模式（上次）/);
});

test('current native input and window counts are visible with a real progress bar, including zero', () => {
  const capacity = native({});
  assert.match(capacity, /用量未知/);
  assert.match(capacity, />— \/ 1,000,000 tokens</);
  assert.doesNotMatch(capacity, /0%|<progress/);
  const zero = native({ usedPercentage: 0, inputTokens: 0 });
  assert.match(zero, /<progress[^>]*value="0"/);
  assert.match(zero, />0 \/ 1,000,000 tokens</);
  const used = native({ usedPercentage: 3, inputTokens: 28971 });
  assert.match(used, /<progress[^>]*value="3"/);
  assert.match(used, />3%</);
  assert.match(used, />28,971 \/ 1,000,000 tokens</);
});

test('derive percentages only from exact matching counters, never token counts from a rounded percentage', () => {
  const exact = native({ inputTokens: 12345 });
  assert.match(exact, /<progress[^>]*value="1.2345/);
  assert.match(exact, />1.2%</);
  assert.match(native({ inputTokens: 1 }), /&lt;0.1%/);
  const rounded = native({ usedPercentage: 3 });
  assert.match(rounded, /<progress[^>]*value="3"/);
  assert.match(rounded, />— \/ 1,000,000 tokens</);
  assert.doesNotMatch(rounded, /30,000/);
});

test('display native expiry without restarting it on poll; never present a duration as time left', () => {
  assert.match(native({ promptCache: { ttl: '1h', expiresAt: 1 } }), /缓存 已到期/);
  assert.match(native({ promptCache: { ttl: '1h', warm: true } }), /缓存 TTL 1h/);
  assert.match(native({ promptCache: { expiresAt: Math.ceil(Date.now() / 1000) + 243 } }), /缓存 <svg[^>]*lucide-clock[^>]*>.*?<\/svg>4:\d\d</);
  assert.match(native({ promptCache: { ttl: '1h', cachingObserved: false } }), /缓存 未观测/);
  const historical = { ...contextUsage, cacheCreationTtl: '5m' as const, timestamp: new Date().toISOString() };
  assert.match(render({ contextUsage: historical }), /缓存 估计<svg[^>]*lucide-clock[^>]*>.*?<\/svg>\d+:\d\d</);
  assert.doesNotMatch(render({ contextUsage: historical }), />[^<]*剩/, "the clock replaces the visible word");
  assert.match(render({ contextUsage: historical, statusLineManaged: true, statusLine: { ...statusLine, promptCache: { warm: false } } }), /缓存 未热/);
  assert.doesNotMatch(render({ contextUsage: historical, showCacheTtl: false }), /data-cache-ttl/);
});

test('only current subscription evidence yields quotas, with independent windows and expired reset handling', () => {
  const line = { ...statusLine, fiveHour: { usedPercentage: 71, resetsAt: Math.ceil(Date.now() / 1000) + 86400 }, sevenDay: { usedPercentage: 100, resetsAt: 1 } };
  const props = { statusLineManaged: true, statusLine: line };
  const html = render(props);
  // Each window is a ring like the context meter: filled share and number are the used part.
  assert.match(html, /data-quota-window="5h"[^>]*>.*?<span>5h<\/span><svg class="context-ring".*?stroke-dasharray="71 100".*?<progress[^>]*value="71".*?>71%</);
  assert.match(html, /窗口已用 71%，剩余 29%/);
  assert.match(html, /data-quota-window="7d"[^>]*>.*?<span>7d<\/span><svg class="context-ring"[^>]*><circle[^>]*stroke-dasharray="2 2"[^>]*><\/circle><\/svg><span class="context-number">待更新</);
  assert.doesNotMatch(native({ sevenDay: { usedPercentage: 0 } }), /data-quota-window="5h"/);
  for (const billing of ['third-party', 'api'] as const) assert.doesNotMatch(render({ ...props, endpointBilling: billing }), /data-quota-window|额度未上报/);
  assert.doesNotMatch(render({ ...props, statusLine: { ...line, nonSubscriptionRoute: 'gateway' } }), /data-quota-window/);
  assert.doesNotMatch(render({ ...props, showSubscriptionQuota: false }), /data-quota-window|data-billing-source/);
  assert.doesNotMatch(render({ ...props, statusLineManaged: false, endpointBilling: 'subscription' }), /data-quota-window/);
  assert.match(render({ endpointBilling: 'subscription' }), /额度未上报/);
});

test('current report and historical input are never combined', () => {
  assert.match(render({ statusLineManaged: true, contextUsage }), /上次输入/);
  const html = render({ statusLineManaged: true, statusLine, contextUsage });
  assert.match(html, /用量未知/);
  assert.doesNotMatch(html, /29,000|<progress/);
});

test('subscription windows show when they refill, and rings turn from green to blue, orange and red as they fill', () => {
  const now = Date.now() / 1000, at = (seconds: number) => Math.ceil(now + seconds);
  const clock = (seconds: number) => { const d = new Date(seconds * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const soon = at(2 * 3600), later = at(3 * 86400 + 600);
  const html = native({ fiveHour: { usedPercentage: 72, resetsAt: soon }, sevenDay: { usedPercentage: 30, resetsAt: later } });
  // The hover card's text spans lines (data-tip-detail).
  const five = /data-quota-window="5h".*?<\/span><\/span>/s.exec(html)![0], seven = /data-quota-window="7d".*?<\/span><\/span>/s.exec(html)![0];
  // The 5h window counts down; the 7d window shows its weekday and time with the GMT offset (here: this computer's zone).
  assert.match(five, /class="quota-reset"[^>]*>.*?2时[01]分后</);
  assert.match(seven, new RegExp(`class="quota-reset"[^>]*>.*?周[日一二三四五六] ${clock(later)} GMT[^<]*<`));
  const shanghai = renderToStaticMarkup(createElement(SessionTelemetryDisplay, { statusLineManaged: true, timeZone: 'Asia/Shanghai',
    statusLine: { ...statusLine, fiveHour: { usedPercentage: 72, resetsAt: soon }, sevenDay: { usedPercentage: 30, resetsAt: later } } }));
  assert.match(shanghai, /data-quota-window="7d".*?GMT\+8</s);
  assert.match(five, /data-level="warn"/);
  assert.match(seven, /data-level="low"/);
  assert.match(native({ fiveHour: { usedPercentage: 95 } }), /data-level="high"/);
  assert.deepEqual([0, 39.9, 40, 69, 70, 89, 90, 100, undefined].map(usageLevel),
    ['low', 'low', 'mid', 'mid', 'warn', 'warn', 'high', 'high', undefined]);
  // No reported reset: no reset time.
  assert.doesNotMatch(native({ fiveHour: { usedPercentage: 10 } }), /quota-reset/);
  // The permission mode carries its icon.
  assert.match(render({ executionMode: { mode: 'auto', label: '自动', source: 'native-footer', evidence: 'auto mode on' } }), /data-execution-mode="auto"[^>]*><svg[^>]*lucide-zap/);
});

test('each quota hover card says how recent its figures are, in the chosen zone and both languages', () => {
  const now = Date.now() / 1000;
  const detail = (html: string, label: string) => {
    const tag = new RegExp(`<span[^>]*data-quota-window="${label}"[^>]*>`).exec(html)![0];
    return /data-tip-detail="([^"]*)"/.exec(tag)![1].replace(/&#x27;/g, "'");
  };
  const windows = { fiveHour: { usedPercentage: 40, resetsAt: Math.ceil(now) + 3600 }, sevenDay: { usedPercentage: 60, resetsAt: Math.ceil(now) + 3 * 86400 } };
  const shown = (asOf: number | undefined, timeZone?: string) => renderToStaticMarkup(createElement(SessionTelemetryDisplay,
    { statusLineManaged: true, timeZone, statusLine: { ...statusLine, ...windows, ...(asOf !== undefined && { quotaAsOf: asOf }) } }));
  // Earlier today in UTC (or yesterday right after midnight): the time, then the offset; both windows share it.
  const recent = Math.floor(now) - 60;
  const html = shown(recent, 'UTC');
  const clock = new Date(recent * 1000).toISOString().slice(11, 16);
  for (const label of ['5h', '7d']) {
    assert.match(detail(html, label), new RegExp(`\\n截至 (昨天 )?${clock} GMT\\+0。\\n这是该对话最近一次模型请求时的用量：Claude Code 只在发出请求时更新`));
    assert.match(html, new RegExp(`data-quota-window="${label}" data-quota-as-of="${recent}"`));
  }
  // Two days ago in Shanghai: the date.
  const older = Math.floor(now) - 2 * 86400;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(older * 1000);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  assert.match(detail(shown(older, 'Asia/Shanghai'), '7d'), new RegExp(`截至 ${get('month')}/${get('day')} ${get('hour')}:${get('minute')} GMT\\+8。`));
  // Not known: said so, never the time of the read.
  const unknown = detail(shown(undefined), '5h');
  assert.match(unknown, /截至时间未知：打开这个对话之前就已有。/);
  assert.doesNotMatch(unknown, /截至 /);
  assert.match(shown(undefined), /data-quota-as-of=""/);
  // The reset passed: still dated.
  assert.match(detail(native({ fiveHour: { usedPercentage: 90, resetsAt: 1 }, quotaAsOf: recent }), '5h'), /上报的重置时间已过[^]*\n截至 /);
  setLocale('en');
  try {
    const english = shown(recent, 'UTC');
    assert.match(detail(english, '5h'), new RegExp(`\\nAs of (yesterday )?${clock} GMT\\+0\\.\\nThis is the usage as of this conversation's latest model request`));
    assert.match(detail(shown(undefined), '7d'), /As of: unknown, from before this conversation was opened\./);
  } finally { setLocale('zh-CN'); }
});
