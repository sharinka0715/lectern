import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDesktopState } from '../src/renderer/desktop-state';
import { fullResetTime, quotaCountdown, timeZoneChoices, validTimeZone, zonedAsOf, zonedReset, zoneOffset } from '../src/renderer/quota-time';
import { setLocale } from '../src/shared/i18n';

// 2026-11-20 (Friday) 12:00 UTC.
const noon = Date.UTC(2026, 10, 20, 12, 0) / 1000;

test('the 5h window counts down in hours and minutes', () => {
  assert.equal(quotaCountdown(2 * 3600 + 15 * 60), '2时15分后');
  assert.equal(quotaCountdown(42 * 60 - 20), '42分后');
  assert.equal(quotaCountdown(5), '1分后');
  assert.equal(quotaCountdown(-30), '1分后');
});

test('the 7d refill time is shown in the chosen zone with its GMT offset', () => {
  // Monday 2026-11-23 11:00 UTC.
  const monday = Date.UTC(2026, 10, 23, 11, 0) / 1000;
  assert.equal(zonedReset(monday, noon, 'UTC'), '周一 11:00 GMT+0');
  assert.equal(zonedReset(monday, noon, 'Asia/Shanghai'), '周一 19:00 GMT+8');
  assert.equal(zonedReset(monday, noon, 'Asia/Kolkata'), '周一 16:30 GMT+5:30');
  assert.equal(zonedReset(monday, noon, 'America/Los_Angeles'), '周一 03:00 GMT-8');
  // Today and tomorrow are counted in that zone: 20:00 UTC is already Saturday in Shanghai.
  const evening = Date.UTC(2026, 10, 20, 20, 0) / 1000;
  assert.equal(zonedReset(evening, noon, 'UTC'), '20:00 GMT+0');
  assert.equal(zonedReset(evening, noon, 'Asia/Shanghai'), '明天 04:00 GMT+8');
  assert.equal(zonedReset(noon + 10 * 86400, noon, 'UTC'), '11/30 12:00 GMT+0');
  assert.match(fullResetTime(monday, 'Asia/Shanghai'), /^2026\/11\/23 周一 19:00（Asia\/Shanghai，GMT\+8）$/);
  assert.match(fullResetTime(monday), /（本机时区，GMT/);
});

test('how recent the figures are: the time today, yesterday or the date, in the chosen zone', () => {
  // 2026-11-20 12:00 UTC is 20:00 in Shanghai, 04:00 in Los Angeles.
  assert.equal(zonedAsOf(noon - 2 * 3600, noon, 'UTC'), '10:00 GMT+0');
  assert.equal(zonedAsOf(noon - 2 * 3600, noon, 'Asia/Shanghai'), '18:00 GMT+8');
  // The day is counted in that zone: 03:00 UTC is still the day before in Los Angeles, the same day in Shanghai.
  const early = Date.UTC(2026, 10, 20, 3, 0) / 1000;
  assert.equal(zonedAsOf(early, noon, 'Asia/Shanghai'), '11:00 GMT+8');
  assert.equal(zonedAsOf(early, noon, 'America/Los_Angeles'), '昨天 19:00 GMT-8');
  assert.equal(zonedAsOf(noon - 3 * 86400, noon, 'UTC'), '11/17 12:00 GMT+0');
  assert.equal(zonedAsOf(Date.UTC(2025, 11, 31, 23, 30) / 1000, noon, 'UTC'), '2025/12/31 23:30 GMT+0');
  assert.match(zonedAsOf(noon - 60, noon), /\d\d:\d\d GMT[+-]\d+(?::\d\d)?$/, "this computer's zone when none is chosen");
  setLocale('en');
  try {
    assert.equal(zonedAsOf(early, noon, 'America/Los_Angeles'), 'yesterday 19:00 GMT-8');
    assert.equal(zonedAsOf(noon - 3 * 86400, noon, 'UTC'), '11/17 12:00 GMT+0');
  } finally { setLocale('zh-CN'); }
});

test('zones are checked and listed with their offsets', () => {
  assert.equal(validTimeZone(''), true);
  assert.equal(validTimeZone('Asia/Tokyo'), true);
  assert.equal(validTimeZone('Mars/Olympus'), false);
  assert.equal(zoneOffset('Asia/Tokyo', noon), 'GMT+9');
  const choices = timeZoneChoices(noon);
  assert.deepEqual(choices[0], { zone: 'UTC', offset: 'GMT+0' });
  assert.ok(choices.length > 300 && choices.some(choice => choice.zone === 'Europe/Berlin' && choice.offset === 'GMT+1'));
});

test('the chosen zone is kept only when the runtime knows it', () => {
  const read = (value: unknown) => loadDesktopState({ getItem: () => JSON.stringify(value) }).quotaTimeZone;
  assert.equal(read({}), '');
  assert.equal(read({ quotaTimeZone: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(read({ quotaTimeZone: 'Mars/Olympus' }), '');
  assert.equal(read({ quotaTimeZone: 8 }), '');
});
