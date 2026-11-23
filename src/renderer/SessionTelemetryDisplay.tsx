import { useEffect, useState } from "react";
import { BellOff, CircleHelp, Clock, FilePen, Hand, ListChecks, RotateCw, ShieldOff, Zap, type LucideIcon } from "lucide-react";
import type { EndpointBilling, NativeStatusLineObservation, SessionSnapshot, SubscriptionWindow } from "../shared/types";
import { fullResetTime, quotaCountdown, zonedAsOf, zonedReset } from "./quota-time";
import { tip } from "./Tooltip";
import { formatNumber, t, type MessageKey } from "../shared/i18n";
import { rich } from "./i18n";

const number = { format: (value: number) => formatNumber(value, { maximumFractionDigits: 1 }) };

function contextDisplay({
  statusLineManaged, statusLine, contextUsage,
}: Pick<SessionSnapshot, "statusLineManaged" | "statusLine" | "contextUsage">) {
  if (statusLineManaged && statusLine) {
    const { usedPercentage, contextWindowSize: capacity, inputTokens } = statusLine;
    if (capacity !== undefined || inputTokens !== undefined || usedPercentage !== undefined) {
      // Native percentages can be rounded. Only exact counters can supply a token count.
      const percent = usedPercentage ?? (capacity !== undefined && capacity > 0 && inputTokens !== undefined
        ? Math.min(100, inputTokens / capacity * 100) : undefined);
      const counts = inputTokens !== undefined || capacity !== undefined
        ? `${inputTokens === undefined ? "—" : number.format(inputTokens)} / ${capacity === undefined ? "—" : number.format(capacity)} tokens`
        : t('telemetry.tokensUnknown');
      const percentageLabel = percent === undefined ? undefined
        : percent > 0 && percent < 0.1 ? "<0.1%" : `${number.format(percent)}%`;
      const label = percentageLabel ?? t(inputTokens === undefined ? 'telemetry.usageUnknown' : 'telemetry.capacityUnknown');
      return {
        inputTokens, percent, counts, label, caption: t('telemetry.context'),
        title: [
          t('telemetry.sourceStatusLine'),
          inputTokens === undefined ? t('telemetry.noInputYet') : t('telemetry.contextInput', { tokens: number.format(inputTokens) }),
          capacity === undefined ? t('telemetry.windowUnknown') : t('telemetry.windowSize', { tokens: number.format(capacity) }),
          percentageLabel ? t('telemetry.windowUsed', { percent: percentageLabel }) : null,
        ].filter(Boolean).join("\n"),
      };
    }
  }
  if (contextUsage) {
    const usage = contextUsage;
    return {
      inputTokens: usage.totalInputTokens, percent: undefined,
      caption: t(statusLineManaged ? 'telemetry.lastInput' : 'telemetry.contextInputCaption'),
      label: t('telemetry.capacityUnknown'), counts: `${number.format(usage.totalInputTokens)} tokens`,
      title: [
        t('telemetry.lastRequestInput', { tokens: number.format(usage.totalInputTokens) }),
        t('telemetry.inputBreakdown', { input: number.format(usage.inputTokens), read: number.format(usage.cacheReadInputTokens), write: number.format(usage.cacheCreationInputTokens) }),
        t('telemetry.updatedAfterReply'),
      ].join("\n"),
    };
  }
  return { caption: t('telemetry.context'), label: t('telemetry.usageUnknown'), counts: undefined, title: t('telemetry.noContextUsage'), inputTokens: undefined, percent: undefined };
}

type Props = Pick<SessionSnapshot, 'executionMode' | 'executionModeLastObserved' | 'contextUsage' | 'statusLineManaged' | 'statusLine' | 'endpointBilling'> & {
  showCacheTtl?: boolean; showSubscriptionQuota?: boolean;
  /** The zone for the 7d refill time; empty or absent: this computer's. */
  timeZone?: string;
};

function countdown(seconds: number) {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 86400) return t('telemetry.daysHours', { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600) });
  if (s >= 3600) return t('telemetry.hoursMinutes', { h: Math.floor(s / 3600), m: Math.floor(s % 3600 / 60) });
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function cacheState(line: NativeStatusLineObservation | undefined, context: SessionSnapshot['contextUsage'], now: number) {
  const cache = line?.promptCache;
  if (cache) {
    const ttl = cache.ttl ? t('telemetry.prefixTtl', { ttl: cache.ttl }) : '';
    const title = t('telemetry.cacheSource', { ttl });
    if (cache.cachingObserved === false) return { label: t('telemetry.notObserved'), title: t('telemetry.notObservedTitle') };
    if (cache.warm === false && (cache.expiresAt === undefined || cache.expiresAt > now)) return { label: t('telemetry.cold'), title };
    if (cache.expiresAt !== undefined) return { expires: cache.expiresAt, title };
    return { label: cache.ttl ? `TTL ${cache.ttl}` : t('telemetry.unknown'), title: t('telemetry.noExpiry', { title }) };
  }
  const ttl = context?.cacheCreationTtl, recorded = Date.parse(context?.timestamp ?? '');
  if (ttl && Number.isFinite(recorded) && recorded > 0 && recorded / 1000 <= now) return {
    expires: recorded / 1000 + (ttl === '5m' ? 300 : 3600), estimated: true,
    title: t('telemetry.estimatedTitle', { ttl }),
  };
  return { label: t('telemetry.unknown'), title: t('telemetry.noCacheInfo') };
}

const billingLabels: Record<EndpointBilling, MessageKey> = {
  subscription: 'telemetry.billingSubscription', api: 'telemetry.billingApi', 'third-party': 'telemetry.billingThirdParty',
  'signed-out': 'telemetry.billingSignedOut', unknown: 'telemetry.billingUnknown',
};

/** What each permission mode means for the user, for its hover card. */
const modeHelp: Record<string, MessageKey> = {
  default: 'telemetry.modeDefault',
  auto: 'telemetry.modeAuto',
  plan: 'telemetry.modePlan',
  acceptEdits: 'telemetry.modeAcceptEdits',
  bypassPermissions: 'telemetry.modeBypass',
  dontAsk: 'telemetry.modeDontAsk',
};

const modeIcons: Record<string, LucideIcon> = {
  auto: Zap, acceptEdits: FilePen, plan: ListChecks, bypassPermissions: ShieldOff, dontAsk: BellOff, default: Hand,
};

/** How full a meter is: green while little is used, then blue, orange and red as the share nears the limit. */
export function usageLevel(percent: number | undefined) {
  return percent === undefined ? undefined : percent >= 90 ? "high" : percent >= 70 ? "warn" : percent >= 40 ? "mid" : "low";
}

/** Same ring as the context meter: the filled arc is the used share; a dashed ring means no current figure. */
function UsageRing({ percent, tone }: { percent?: number; tone?: string }) {
  return <svg className="context-ring" data-level={tone} aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="6" stroke="var(--line-strong)" strokeDasharray={percent === undefined ? '2 2' : undefined} />
    {percent !== undefined && <circle className="ring-value" cx="8" cy="8" r="6" pathLength="100" transform="rotate(-90 8 8)"
      strokeDasharray={`${percent} 100`} />}
  </svg>;
}

/** When a window refills: the 5h window counts down, the 7d window shows the time in the chosen zone. */
function resetTime(label: string, seconds: number, now: number, zone?: string) {
  return label === "5h" ? quotaCountdown(seconds - now) : zonedReset(seconds, now, zone);
}

/** `asOf`: the figures are at least this recent (seconds); absent: not known, and the card says so. */
function quotaMeter(label: string, window: SubscriptionWindow, now: number, zone?: string, asOf?: number) {
  const expired = window.resetsAt !== undefined && now >= window.resetsAt;
  const percent = Math.min(100, Math.max(0, window.usedPercentage));
  const used = `${number.format(percent)}%`, remaining = `${number.format(100 - percent)}%`;
  const detail = [
    expired ? t('telemetry.resetPassed') : t('telemetry.windowUsage', { label, used, remaining }),
    !expired && (window.resetsAt === undefined ? t('telemetry.resetUnknown') : t('telemetry.resetsAt', { time: fullResetTime(window.resetsAt, zone), left: countdown(window.resetsAt - now) })),
    asOf === undefined ? t('telemetry.asOfUnknown') : t('telemetry.asOf', { time: zonedAsOf(asOf, now, zone) }),
    t('telemetry.asOfHelp'),
    t(label === '5h' ? 'telemetry.fiveHourHelp' : 'telemetry.sevenDayHelp'),
    t('telemetry.ringHelp'),
  ].filter(Boolean).join('\n');
  return <span key={label} className="telemetry-item session-quota-usage" data-quota-window={label} data-quota-as-of={asOf ?? ""}
    {...tip(t('telemetry.quotaTitle', { hours: label === '5h' ? 5 : 7 }), detail)}>
    <span>{label}</span>
    <UsageRing percent={expired ? undefined : percent} tone={expired ? undefined : usageLevel(percent)} />
    {!expired && <progress className="telemetry-sr-only" aria-label={t('telemetry.windowUsedLabel', { label })} max={100} value={percent}
      aria-valuetext={t('telemetry.usedLeft', { used, remaining })} />}
    <span className="context-number">{expired ? t('telemetry.pendingUpdate') : used}</span>
    {!expired && window.resetsAt !== undefined && <span className="quota-reset" aria-label={t('telemetry.resetLabel', { time: resetTime(label, window.resetsAt, now, zone) })}>
      <RotateCw size={10} aria-hidden="true" />{resetTime(label, window.resetsAt, now, zone)}
    </span>}
  </span>;
}

export function SessionTelemetryDisplay({
  executionMode, executionModeLastObserved, endpointBilling, showCacheTtl = true, showSubscriptionQuota = true, timeZone, ...usage
}: Props) {
  const context = contextDisplay(usage);
  const line = usage.statusLineManaged ? usage.statusLine : undefined;
  const now = Date.now() / 1000;
  const cache = cacheState(line, usage.contextUsage, now);
  const billing = line?.nonSubscriptionRoute ? 'third-party'
    : endpointBilling === 'api' || endpointBilling === 'third-party' ? endpointBilling
    : line?.fiveHour || line?.sevenDay ? 'subscription' : endpointBilling ?? 'unknown';
  const showLimits = showSubscriptionQuota && billing === 'subscription';
  const activeCache = !!(showCacheTtl && cache.expires && cache.expires > now);
  const nextReset = showLimits && [line?.fiveHour?.resetsAt, line?.sevenDay?.resetsAt].some(t => t !== undefined && t > now);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!activeCache && !nextReset) return;
    const id = setInterval(() => tick(n => n + 1), activeCache ? 1000 : 15000);
    return () => clearInterval(id);
  }, [activeCache, nextReset]);
  const cacheText = cache.expires === undefined ? cache.label : cache.expires <= now ? t(cache.estimated ? 'telemetry.estimatedExpired' : 'telemetry.expired')
    : <>{cache.estimated && t('telemetry.estimated')}<Clock size={12} role="img" aria-label={t('telemetry.remaining')} />{countdown(cache.expires - now)}</>;
  const ModeIcon = (executionMode && modeIcons[executionMode.mode]) || CircleHelp;
  const sourceTitle = line?.nonSubscriptionRoute ? t('telemetry.sourceCustomRoute')
    : showLimits && (line?.fiveHour || line?.sevenDay) ? t('telemetry.sourceSubscription')
    : t('telemetry.sourceLogin');
  const billingText = line?.nonSubscriptionRoute === 'custom' ? t('telemetry.customRoute') : t(billingLabels[billing]);
  return (
    // Three groups that wrap as units on narrow chats: mode, context and cache, subscription.
    <div className="session-telemetry">
      <span className="telemetry-group">
      <span className="telemetry-item session-execution-mode" data-execution-mode={executionMode?.mode ?? "unknown"}
        {...tip(executionMode ? t('telemetry.modeTitle', { label: executionMode.label }) : t('telemetry.modeUnknownTitle'), [
          executionMode ? (modeHelp[executionMode.mode] ? t(modeHelp[executionMode.mode]) : undefined) : t('telemetry.modeNotShown'),
          executionMode && t(executionModeLastObserved ? 'telemetry.modeLastSeen' : 'telemetry.modeFromFooter'),
          t('telemetry.modeSwitchHint'),
        ].filter(Boolean).join("\n"))}>
        <ModeIcon size={12} aria-hidden="true" />
        {executionMode?.label ?? t('telemetry.modeUnknown')}{executionMode && executionModeLastObserved ? t('telemetry.modeLast') : ""}
      </span>
      </span>
      <span className="telemetry-group">
      <span className="telemetry-item session-context-usage" data-context-input-tokens={context.inputTokens ?? ""}
        {...tip(t('telemetry.contextTitle', { label: context.label }), `${context.title}\n${t('telemetry.contextHelp')}\n${t('telemetry.ringHelp')}`)}>
        <span>{context.caption}</span>
        <UsageRing percent={context.percent} tone={usageLevel(context.percent)} />
        {context.percent !== undefined && <progress className="telemetry-sr-only" aria-label={t('telemetry.contextUsedLabel')} max={100} value={context.percent}
          aria-valuetext={context.counts ? t('telemetry.labelWithCounts', { label: context.label, counts: context.counts }) : context.label} />}
        <span className="context-number">{context.label}</span>
        {context.counts && <span className="telemetry-sr-only context-counts">{context.counts}</span>}
      </span>
      {showCacheTtl && <span className="telemetry-item telemetry-chip telemetry-cache" data-cache-ttl=""
        {...tip(t('telemetry.cacheTitle', { state: cache.expires === undefined ? cache.label : cache.expires <= now ? t('telemetry.expired') : t('telemetry.cacheLeft', { left: countdown(cache.expires - now) }) }),
          `${cache.title}\n${t('telemetry.cacheHelp')}`)}>{rich('telemetry.cacheChip', { state: cacheText })}</span>}
      </span>
      {showSubscriptionQuota && <span className="telemetry-group telemetry-quota">
      <span className="telemetry-chip telemetry-billing" data-billing-source={billing}
        {...tip(t('telemetry.billingTitle', { source: billingText }), `${sourceTitle}\n${t('telemetry.billingHelp')}`)}>{billingText}</span>
      {showLimits && line?.fiveHour && quotaMeter('5h', line.fiveHour, now, timeZone, line.quotaAsOf)}
      {showLimits && line?.sevenDay && quotaMeter('7d', line.sevenDay, now, timeZone, line.quotaAsOf)}
      {showLimits && !line?.fiveHour && !line?.sevenDay && <span className="telemetry-item telemetry-chip" {...tip(t('telemetry.quotaMissing'), t('telemetry.quotaMissingHelp'))}>{t('telemetry.quotaMissing')}</span>}
      </span>}
    </div>
  );
}
