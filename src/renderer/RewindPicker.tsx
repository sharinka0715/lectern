import { useEffect, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import type { SessionSnapshot } from '../shared/types';
import './turn-controls.css';
import { t } from '../shared/i18n';

interface Props {
  snapshot: SessionSnapshot; busy: boolean; onClose(): void;
  onLoadEarlier(): Promise<void>; onSelect(uuid: string): Promise<void>;
}

export function RewindPicker({snapshot, busy, onClose, onLoadEarlier, onSelect}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const d = dialog.current!; d.showModal(); return () => d.close(); }, []);
  const prompts = snapshot.messages.filter(m => m.role === 'user' && m.rewindUuid).reverse();
  const run = async (operation: () => Promise<void>) => {
    if (busy || loading) return;
    setLoading(true); setError('');
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  return <dialog className="rewind-picker rewind-panel" ref={dialog} aria-label={t('composer.rewindPicker')} onCancel={e => {e.preventDefault(); onClose();}}>
    <header><History size={16}/><strong>{t('composer.rewindPicker')}</strong><button type="button" onClick={onClose} aria-label={t('composer.closeRewindPicker')}><X size={16}/></button></header>
    <p>{t('composer.rewindPickerHelp')}</p>
    <div className="rewind-choices">{prompts.map(m => <button type="button" disabled={busy || loading} key={m.rewindUuid} data-rewind-uuid={m.rewindUuid}
      onClick={() => void run(() => onSelect(m.rewindUuid!))}><span>{m.text}</span>
      <small title={m.rewindUuid}>{m.timestamp && new Date(m.timestamp).toLocaleTimeString()}<br/>{m.rewindUuid!.slice(0,8)}</small></button>)}</div>
    {!prompts.length && <p>{t('composer.noRewindTargets')}</p>}
    {snapshot.historyPage?.hasOlder && <button type="button" disabled={busy || loading} onClick={() => void run(onLoadEarlier)}>{t('composer.loadEarlier')}</button>}
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
