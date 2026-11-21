import { ArrowDown, ArrowUp, CornerDownLeft, History, ListOrdered, X } from 'lucide-react';
import type { TurnAction, TurnControls } from '../shared/turn-controls';
import './turn-controls.css';
import { t } from '../shared/i18n';

export function TurnPanel({ state, busy, act }: { state?: TurnControls; busy: boolean; act: (action: TurnAction) => void }) {
  const menu = state?.rewind;
  if (menu) return <section className="rewind-panel" aria-label={t('settings.rewindTitle')}>
    <header><History size={16}/><strong>{t('settings.rewindTitle')}</strong><button type="button" disabled={busy} aria-label={t('settings.cancelRewind')} onClick={() => act({kind:'cancelRewind', signature:menu.signature})}><X size={15}/></button></header>
    {menu.stage === 'checkpoint' ? <>
      <p>{t('settings.rewindPick')}</p>
      <div className="rewind-choices">{menu.rows.map((row, index) => <button type="button" key={index}
        disabled={busy || row.label === '(current)'} data-checkpoint={index} aria-current={index === menu.focused || undefined}
        onClick={() => act({kind:'checkpoint',signature:menu.signature,index})}>
        <span>{row.label === '(current)' ? t('settings.currentPoint') : row.label}</span>{index === menu.focused && <CornerDownLeft size={13}/>}
      </button>)}</div>
      <div className="rewind-navigation"><button type="button" disabled={busy} onClick={() => act({kind:'previous',signature:menu.signature})}><ArrowUp size={13}/>{t('settings.previousRow')}</button>
        <button type="button" disabled={busy} onClick={() => act({kind:'next',signature:menu.signature})}><ArrowDown size={13}/>{t('settings.nextRow')}</button></div>
    </> : <>
      <blockquote>{menu.message}</blockquote><p>{t('settings.rewindConfirmNote')}</p>
      <button type="button" className="rewind-confirm" disabled={busy} onClick={() => act({kind:'restore',signature:menu.signature})}>{t('settings.confirmRewind')}</button>
    </>}
  </section>;
  if (!state?.queued.length) return null;
  return <section className="turn-queue" aria-label={t('settings.queueLabel')}><header><ListOrdered size={15}/><strong>{t('settings.waitingToSend')}</strong>
    {state.compacting ? <span className="turn-queue-note">{t('settings.sendAfterCompact')}</span>
      : <button type="button" disabled={!state.running || busy} onClick={() => act({kind:'flushQueue'})}>{t('settings.flushQueue')}</button>}
  </header><ol>{state.queued.map((text, index) => <li key={index}>{text}</li>)}</ol></section>;
}
