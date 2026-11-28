// When the subscription windows refill: the 5h window as a countdown, the 7d
// window as a clock time in the chosen time zone (default: this computer's),
// with its GMT offset, since an SSH machine may run in another zone.

import { t } from "../shared/i18n";

const formats = new Map<string, Intl.DateTimeFormat>();

/** True for a time zone name this runtime knows ("" is this computer's zone). */
export function validTimeZone(zone: string) {
  if (!zone) return true;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

function parts(seconds: number, zone?: string) {
  const key = zone ?? "";
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone || undefined, year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short", timeZoneName: "shortOffset" });
    formats.set(key, format);
  }
  const list = format.formatToParts(seconds * 1000), get = (type: Intl.DateTimeFormatPartTypes) => list.find(part => part.type === type)?.value ?? "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), time: `${get("hour")}:${get("minute")}`,
    // Runtimes write UTC as "GMT" or "GMT+0"; always show the number.
    weekday: t('telemetry.weekday', { day: get("weekday") }), offset: /^(?:GMT|UTC)?$/u.test(get("timeZoneName")) ? "GMT+0" : get("timeZoneName").replace(/^UTC/u, "GMT") };
}

/** "GMT+8", "GMT+5:30", "GMT+0" for a zone ("" or undefined: this computer's) at a moment. */
export function zoneOffset(zone?: string, seconds = Date.now() / 1000) {
  return parts(seconds, zone).offset;
}

/** Time left in minutes: "2时15分后", "42分后" ("in 2h 15m", "in 42m"). */
export function quotaCountdown(seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes >= 60 ? t('telemetry.countdownHours', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('telemetry.countdownMinutes', { m: minutes });
}

/** The refill moment in the zone: the time today, "明天 09:00", the weekday within a week, else the date; then the offset. */
export function zonedReset(resetsAt: number, now: number, zone?: string) {
  const at = parts(resetsAt, zone), today = parts(now, zone);
  const days = Math.round((Date.UTC(at.year, at.month - 1, at.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86400000);
  const when = days <= 0 ? at.time : days === 1 ? t('telemetry.tomorrow', { time: at.time }) : days < 7 ? `${at.weekday} ${at.time}` : `${at.month}/${at.day} ${at.time}`;
  return `${when} ${at.offset}`;
}

/** How recent the figures are, in the zone: the time today, "昨天 14:32", else the date (with
 * the year when it is another one); then the offset, like the refill times beside it. */
export function zonedAsOf(asOf: number, now: number, zone?: string) {
  return `${zonedPastTime(asOf, now, zone)} ${parts(asOf, zone).offset}`;
}

/** A past moment in the zone without its offset: "14:32", "昨天 14:32", "11/26 14:32", "2025/11/26 14:32". */
export function zonedPastTime(seconds: number, now: number, zone?: string) {
  const at = parts(seconds, zone), today = parts(now, zone);
  const days = Math.round((Date.UTC(today.year, today.month - 1, today.day) - Date.UTC(at.year, at.month - 1, at.day)) / 86400000);
  return days <= 0 ? at.time : days === 1 ? t('telemetry.yesterday', { time: at.time })
    : at.year === today.year ? `${at.month}/${at.day} ${at.time}` : `${at.year}/${at.month}/${at.day} ${at.time}`;
}

/** The full date and time in the zone, for the tooltip. */
export function fullResetTime(resetsAt: number, zone?: string) {
  const at = parts(resetsAt, zone);
  return t('telemetry.fullReset', { date: `${at.year}/${at.month}/${at.day}`, weekday: at.weekday, time: at.time, zone: zone || t('telemetry.localTimeZone'), offset: at.offset });
}

/** Every zone the runtime lists, with its current offset, for the settings menu. */
export function timeZoneChoices(now = Date.now() / 1000) {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
  return ["UTC", ...zones.filter(zone => zone !== "UTC")].map(zone => ({ zone, offset: zoneOffset(zone, now) }));
}
