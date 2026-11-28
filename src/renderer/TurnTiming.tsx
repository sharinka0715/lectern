// When a reply's turn ended and how long it took, under the reply. The clock uses the
// subscription refill time zone (Preferences; default: this computer's), like the quota times;
// the zone and its offset are on hover, with the full date.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { t } from "../shared/i18n";
import type { TurnTiming as Timing } from "../shared/types";
import { fullResetTime, zonedPastTime } from "./quota-time";

interface Clock { zone: string; now: number }
const ClockContext = createContext<Clock>({ zone: "", now: Date.now() });

/** The zone's calendar day: "昨天" and dates move on at midnight, with one timer for all replies. */
function dayKey(zone: string, at = Date.now()) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: zone || undefined, dateStyle: "short" }).format(at); }
  catch { return new Date(at).toDateString(); }
}

export function TurnClockProvider({ zone, children }: { zone: string; children: ReactNode }) {
  const [clock, setClock] = useState<Clock>(() => ({ zone, now: Date.now() }));
  useEffect(() => {
    setClock(current => current.zone === zone ? current : { zone, now: Date.now() });
    const timer = window.setInterval(() => setClock(current =>
      dayKey(zone) === dayKey(zone, current.now) ? current : { zone, now: Date.now() }), 60_000);
    return () => window.clearInterval(timer);
  }, [zone]);
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

/** "12秒", "3分12秒", "1时5分" (seconds rounded, at least 1). */
export function turnDurationText(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t("chat.turnSeconds", { s: seconds });
  if (seconds < 3600) return t("chat.turnMinutes", { m: Math.floor(seconds / 60), s: seconds % 60 });
  return t("chat.turnHours", { h: Math.floor(seconds / 3600), m: Math.floor(seconds % 3600 / 60) });
}

/** When it ended or was interrupted, then the time taken (one word for both: hover tells which measure). */
export function TurnTimingLabel({ timing }: { timing: Timing }) {
  const { zone, now } = useContext(ClockContext);
  const at = Date.parse(timing.at) / 1000;
  const duration = timing.stopped ? timing.wallMs : timing.workMs ?? timing.wallMs;
  const title = [
    t(timing.stopped ? "chat.turnStoppedAt" : "chat.turnEndedAt", { time: fullResetTime(at, zone) }),
    timing.stopped ? timing.wallMs !== undefined && t("chat.turnStoppedNote", { time: turnDurationText(timing.wallMs) })
      : timing.workMs !== undefined && t("chat.turnWorkNote"),
    !timing.stopped && timing.workMs !== undefined && timing.wallMs !== undefined && Math.abs(timing.wallMs - timing.workMs) >= 1000
      && t("chat.turnWallNote", { time: turnDurationText(timing.wallMs) }),
  ].filter(Boolean).join("\n");
  return <span className="turn-timing" title={title}>
    <time dateTime={timing.at}>{zonedPastTime(at, now / 1000, zone)}</time>
    {duration !== undefined && <> · {t("chat.turnWorked", { time: turnDurationText(duration) })}</>}
  </span>;
}
