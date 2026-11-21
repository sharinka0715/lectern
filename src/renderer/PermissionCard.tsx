import { useEffect, useRef, useState } from 'react';
import { ShieldAlert, ShieldQuestion, Terminal, X } from 'lucide-react';
import type { NativePermissionOption, PermissionAction, PermissionSnapshot } from '../shared/native-permission';
import './question-card.css';
import { t } from '../shared/i18n';

interface Props {
  permission: PermissionSnapshot;
  busy: boolean;
  unconfirmed?: boolean;
  onAction(action: PermissionAction): Promise<void>;
  onViewTerminal(): void;
}

/** Diff rows in Claude Code's edit dialog: "  12 -old" / "  12 +new". */
export function diffKind(line: string): 'add' | 'del' | undefined {
  const match = /^\s*\d+ ([+-])/u.exec(line);
  return match ? match[1] === '+' ? 'add' : 'del' : undefined;
}
/** A rejecting choice leaves the turn waiting for the user's guidance. */
export const rejects = (label: string) => /^No\b/u.test(label);
const keyGlyph = { Enter: 'Enter', BTab: '⇧Tab' } as const;
/** "Auto mode can't check actions in this session": what each keyed choice does, in the app's language. */
function keyedCopy(option: NativePermissionOption) {
  if (option.key === 'Enter') return { label: t('cards.autoModeStay'), hint: t('cards.autoModeStayHint') };
  return { label: t('cards.autoModeLeave'), hint: option.unavailable ? t('cards.autoModeLeaveUnavailable') : t('cards.autoModeLeaveHint') };
}

/** A projection of Claude Code's tool permission dialog; every click is checked against the live screen. */
export function PermissionCard({ permission: p, busy, unconfirmed, onAction, onViewTerminal }: Props) {
  const [result, setResult] = useState<{ token: string; error?: string }>();
  const inFlight = useRef(false);
  const root = useRef<HTMLElement>(null);
  const pending = result?.token === p.token && !result.error;
  const blocked = busy || pending || !!unconfirmed;
  const keyed = p.kind === 'auto-mode-unavailable';
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>('.question-option[aria-pressed="true"]')?.focus({ preventScroll: true }); }, [p.toolUseId]);
  const act = async (action: PermissionAction) => {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setResult({ token: p.token });
    try { await onAction(action); }
    catch (error) { setResult({ token: p.token, error: error instanceof Error ? error.message : String(error) }); }
    finally { inFlight.current = false; }
  };
  return <section ref={root} className={`question-card permission-card${keyed ? ' auto-mode-unavailable' : ''}`} aria-label={keyed ? t('cards.autoModeUnavailable') : t('cards.permission')}
    aria-busy={blocked} data-permission-token={p.token} data-permission-kind={p.kind}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // Number keys pick numbered native choices only; a keyed dialog has none.
      const option = !keyed && /^[1-9]$/u.test(event.key) ? p.options.find(row => row.number === Number(event.key)) : undefined;
      if (option) { event.preventDefault(); void act({ kind: 'choose', number: option.number }); }
      else if (event.key === 'Escape') { event.preventDefault(); void act({ kind: 'cancel' }); }
    }}>
    <header className="question-header">
      <span>{keyed ? <><ShieldAlert size={15} aria-hidden="true" />{t('cards.autoModeUnavailable')}</>
        : <><ShieldQuestion size={15} aria-hidden="true" />{t('cards.needsConfirmation', { title: p.title })}</>}</span>
      <button type="button" onClick={onViewTerminal} title={t('cards.viewPermissionScreen')}><Terminal size={14} aria-hidden="true" />{t('cards.viewScreen')}</button>
    </header>
    {keyed && <p className="permission-intro">{t('cards.autoModeUnavailableIntro')}</p>}
    {keyed ? <figure className="question-preview permission-native">
      <figcaption>{t('cards.autoModeNative')}</figcaption>
      <p lang="en"><strong>{p.title}</strong></p>
      {p.subtitle.map((line, index) => <p key={index} lang="en">{line}</p>)}
    </figure> : p.subtitle.map((line, index) => <p key={index} className="question-guidance permission-subtitle">{line}</p>)}
    {p.content.length > 0 && <figure className="question-preview permission-content">
      <pre>{p.content.map((line, index) => <span key={index} className={diffKind(line) ? `permission-${diffKind(line)}` : undefined}>{line}{'\n'}</span>)}</pre>
    </figure>}
    {p.notice?.map((line, index) => <p key={index} className="question-guidance permission-notice">{line}</p>)}
    {p.question && <h3>{p.question}</h3>}
    <ul className="question-options" aria-label={t('cards.options')}>
      {p.options.map(row => {
        const copy = row.key ? keyedCopy(row) : undefined;
        return <li key={row.number}>
          <div className="question-option-row">
            <button type="button" className="question-option" aria-pressed={row.focused} disabled={blocked || row.unavailable}
              data-permission-option={row.number} data-permission-key={row.key} onClick={() => void act({ kind: 'choose', number: row.number })}>
              <span className={`question-mark${row.key ? ' key' : ''}`} aria-hidden="true">{row.key ? keyGlyph[row.key] : row.number}</span>
              {copy ? <span className="question-option-copy"><strong>{copy.label}</strong><small>{copy.hint}</small>
                <small lang="en" className="permission-native-label">{row.label}</small></span>
                : <span className="question-option-copy"><strong>{row.label}</strong>
                  {rejects(row.label) && <small>{t('cards.rejectHint')}</small>}</span>}
            </button>
          </div>
        </li>;
      })}
    </ul>
    {unconfirmed && <p className="question-error" role="alert">{t('cards.resultUnconfirmed')}</p>}
    {!unconfirmed && result?.token === p.token && result.error && <p className="question-error" role="alert">{result.error}</p>}
    <div className="question-actions">
      <button type="button" disabled={blocked} onClick={() => void act({ kind: 'cancel' })}><X size={13} aria-hidden="true" />{keyed ? t('cards.autoModeStopEsc') : t('cards.cancelEsc')}</button>
      {pending && !unconfirmed && <span role="status">{t('cards.confirmingScreen')}</span>}
    </div>
  </section>;
}
