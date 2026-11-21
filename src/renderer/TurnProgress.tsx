import type { CompactReceipt, SessionSnapshot } from '../shared/types';
import { tip } from './Tooltip';
import './turn-progress.css';
import { dateTimeText, formatNumber, t } from '../shared/i18n';

const numbers = { format: (value: number) => formatNumber(value) };
function tokenText(tokens: NonNullable<CompactReceipt['lastObservedTokens']>) {
  return `${tokens.direction === 'up' ? '↑ ' : tokens.direction === 'down' ? '↓ ' : ''}${tokens.display} tokens`;
}
function duration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  return [seconds >= 3600 && `${Math.floor(seconds / 3600)}h`, seconds >= 60 && `${Math.floor(seconds / 60) % 60}m`, `${seconds % 60}s`].filter(Boolean).join(' ');
}

function CompactSummary({ receipt }: { receipt: CompactReceipt }) {
  const { preTokens, postTokens, durationMs, trigger, timestamp } = receipt;
  return <details className="turn-progress turn-progress-receipt" data-compact-receipt={receipt.id}>
    <summary>
      <span>{t('telemetry.compactDone')}</span>
      <span title={durationMs === undefined ? undefined : t('telemetry.nativeDuration', { ms: numbers.format(durationMs) })}>{durationMs === undefined ? t('telemetry.durationMissing') : duration(durationMs)}</span>
      {receipt.lastObservedTokens && <span>{t('telemetry.lastEstimate', { tokens: tokenText(receipt.lastObservedTokens) })}</span>}
      <span>{t('telemetry.usageNotReported')}</span>
    </summary>
    <div className="turn-progress-facts">
      <p>{t(trigger === 'auto' ? 'telemetry.compactAuto' : trigger === 'manual' ? 'telemetry.compactManual' : 'telemetry.compactSession')}{timestamp && <>{t('telemetry.compactAt')}<time dateTime={timestamp}>{dateTimeText(timestamp)}</time></>}{t('telemetry.compactSource')}</p>
      {(preTokens !== undefined || postTokens !== undefined) && <p>{t('telemetry.contextScale', {
        before: preTokens === undefined ? t('telemetry.beforeUnknown') : t('telemetry.beforeTokens', { tokens: numbers.format(preTokens) }),
        after: postTokens === undefined ? t('telemetry.afterUnknown') : t('telemetry.afterTokens', { tokens: numbers.format(postTokens) }) })}</p>}
      <p>{t('telemetry.compactUsageNote')}</p>
    </div>
  </details>;
}

export function TurnProgress({ snapshot }: { snapshot?: Pick<SessionSnapshot, 'sessionId' | 'turnProgress' | 'lastCompact'> | null }) {
  const live = snapshot?.turnProgress;
  if (!live) return snapshot?.lastCompact ? <CompactSummary key={`${snapshot.sessionId}:${snapshot.lastCompact.id}`} receipt={snapshot.lastCompact} /> : null;
  const { activity, compactPhase, elapsed, tokens, detail } = live;
  const label = compactPhase === 'compacting' ? 'Compacting session' : activity;
  const title = [t('telemetry.screenActivity', { activity }), elapsed ? t('telemetry.screenElapsed', { elapsed }) : t('telemetry.noScreenElapsed'),
    t(tokens ? 'telemetry.tokensEstimated' : 'telemetry.noScreenTokens')].join('\n');
  return <div className="turn-progress turn-progress-live" data-turn-progress={compactPhase ?? 'running'}
    {...tip(t(compactPhase === 'compacting' ? 'telemetry.compacting' : 'telemetry.turnProgress'),
      `${t(compactPhase === 'compacting' ? 'telemetry.compactingHelp' : 'telemetry.progressHelp')}\n${title}`)}>
    <svg viewBox="0 0 16 16" width="16" height="16" focusable="false" aria-hidden="true" className="turn-progress-dots">
      <circle cx="8" cy="2.5" r="1.6" /><circle cx="4" cy="4.3" r="1.35" opacity=".7" /><circle cx="2.6" cy="8.3" r="1" opacity=".48" />
    </svg>
    <span role="status" className="turn-progress-label">{label}</span>
    {elapsed && <span className="turn-progress-count" aria-label={t('telemetry.screenElapsed', { elapsed })}>{elapsed}</span>}
    {tokens && <span className="turn-progress-count" aria-label={t('telemetry.screenEstimate', { tokens: tokenText(tokens) })}>{tokenText(tokens)}</span>}
    {detail && <span className="turn-progress-detail">{detail}</span>}
  </div>;
}
