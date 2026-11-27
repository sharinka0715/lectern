import { useEffect, useRef, useState } from 'react';
import { Coins, MessageSquareWarning, ShieldAlert, ShieldQuestion, Terminal, X } from 'lucide-react';
import type { NativePermissionOption, PermissionAction, PermissionSnapshot } from '../shared/native-permission';
import { LinkedText } from './LinkedText';
import { ToolInput } from './ToolInput';
import type { OpenPath } from './artifact-paths';
import './question-card.css';
import { t } from '../shared/i18n';

interface Props {
  permission: PermissionSnapshot;
  busy: boolean;
  unconfirmed?: boolean;
  onAction(action: PermissionAction): Promise<void>;
  onViewTerminal(): void;
  /** Opens a file named in the call's input (read with the recording hook). */
  onOpenPath?: OpenPath;
}

/** Diff rows in Claude Code's edit dialog: "  12 -old" / "  12 +new". */
export function diffKind(line: string): 'add' | 'del' | undefined {
  const match = /^\s*\d+ ([+-])/u.exec(line);
  return match ? match[1] === '+' ? 'add' : 'del' : undefined;
}
/** A rejecting choice leaves the turn waiting for the user's guidance. */
export const rejects = (label: string) => /^No\b/u.test(label);
const keyGlyph = { Enter: 'Enter', BTab: '⇧Tab' } as const;
/** A keyed dialog's choices (core/auto-mode-screen.ts): what each one does, in the app's language.
 * A dialog Lectern only reads generically says it in its own words: the button names the key. */
function keyedCopy(kind: PermissionSnapshot['kind'], option: NativePermissionOption) {
  if (kind === 'native-dialog') return { label: option.label, hint: t('cards.nativeDialogKeyHint', { key: 'Enter' }), native: true };
  if (kind === 'auto-mode-billing') return { label: t('cards.autoModeBillingContinue'), hint: t('cards.autoModeBillingContinueHint') };
  if (option.key === 'Enter') return { label: t('cards.autoModeStay'), hint: t('cards.autoModeStayHint') };
  return { label: t('cards.autoModeLeave'), hint: option.unavailable ? t('cards.autoModeLeaveUnavailable') : t('cards.autoModeLeaveHint') };
}

/** A projection of Claude Code's tool permission dialog; every click is checked against the live screen. */
export function PermissionCard({ permission: p, busy, unconfirmed, onAction, onViewTerminal, onOpenPath }: Props) {
  const [result, setResult] = useState<{ token: string; error?: string }>();
  const inFlight = useRef(false);
  const root = useRef<HTMLElement>(null);
  const pending = result?.token === p.token && !result.error;
  const blocked = busy || pending || !!unconfirmed;
  // Not a tool's own dialog: "Auto mode can't check actions", the classifier billing notice,
  // or any other native dialog Lectern reads only by its layout (`generic`).
  const keyed = !!p.kind, billing = p.kind === 'auto-mode-billing', generic = p.kind === 'native-dialog';
  // Esc is a choice of its own where the dialog's key hints name it ("Esc to cancel").
  const escapeRow = billing || (generic && p.escape !== undefined);
  const heading = generic ? t('cards.nativeDialog') : billing ? t('cards.autoModeBilling') : keyed ? t('cards.autoModeUnavailable') : t('cards.permission');
  const intro = generic ? t('cards.nativeDialogIntro') : billing ? t('cards.autoModeBillingIntro') : t('cards.autoModeUnavailableIntro');
  // The card takes the keyboard only when nothing has it (the element that had it was removed or
  // disabled) or another card of this chat had it: never from an input box someone is typing in (an
  // Enter would answer the card) nor from the other split pane, the sidebar, the terminal or a dialog.
  useEffect(() => {
    const card = root.current, active = document.activeElement;
    const nowhere = !active || active === document.body || active.matches(':disabled');
    const cards = !!active && !!card?.closest('.composer-area')?.contains(active) && !!active.closest('.question-card, .directory-trust-card');
    if (nowhere || cards) card?.querySelector<HTMLButtonElement>('.question-option[aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [p.cardId]);
  const act = async (action: PermissionAction) => {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setResult({ token: p.token });
    try { await onAction(action); }
    catch (error) { setResult({ token: p.token, error: error instanceof Error ? error.message : String(error) }); }
    finally { inFlight.current = false; }
  };
  return <section ref={root} className={`question-card permission-card${keyed ? ` ${p.kind}` : ''}`} aria-label={heading}
    aria-busy={blocked} data-permission-token={p.token} data-permission-kind={p.kind} data-permission-call={p.toolUseId}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // Number keys pick numbered native choices only; a keyed dialog has none.
      const option = !keyed && /^[1-9]$/u.test(event.key) ? p.options.find(row => row.number === Number(event.key)) : undefined;
      if (option) { event.preventDefault(); void act({ kind: 'choose', number: option.number }); }
      else if (event.key === 'Escape' && (!generic || escapeRow)) { event.preventDefault(); void act({ kind: 'cancel' }); }
    }}>
    <header className="question-header">
      <span>{keyed ? <>{billing ? <Coins size={15} aria-hidden="true" /> : generic ? <MessageSquareWarning size={15} aria-hidden="true" /> : <ShieldAlert size={15} aria-hidden="true" />}{heading}</>
        : <><ShieldQuestion size={15} aria-hidden="true" />{t('cards.needsConfirmation', { title: p.title })}</>}</span>
      <button type="button" onClick={onViewTerminal} title={t('cards.viewPermissionScreen')}><Terminal size={14} aria-hidden="true" />{t('cards.viewScreen')}</button>
    </header>
    {keyed && <p className="permission-intro">{intro}</p>}
    {keyed ? <figure className="question-preview permission-native">
      <figcaption>{t('cards.autoModeNative')}</figcaption>
      <p lang="en"><strong>{p.title}</strong></p>
      {p.subtitle.map((line, index) => <p key={index} lang="en"><LinkedText text={line} /></p>)}
      {generic && <p lang="en" className="permission-native-footer">{p.footer}</p>}
    </figure> : p.subtitle.filter(line => line !== p.call?.input.description) // the call's input below shows it already
      .map((line, index) => <p key={index} className="question-guidance permission-subtitle">{line}</p>)}
    {/* Read with the recording hook: the call's whole input in place of what the dialog's box fits. */}
    {p.call ? <figure className="question-preview permission-call" data-permission-hook-tool={p.call.toolName}>
      <figcaption>{t('cards.permissionCallInput', { tool: p.call.toolName })}</figcaption>
      <ToolInput tool={{ id: p.toolUseId ?? '', name: p.call.toolName, input: JSON.stringify(p.call.input) }} onOpen={onOpenPath ?? (() => {})} />
    </figure> : p.content.length > 0 && <figure className="question-preview permission-content">
      <pre>{p.content.map((line, index) => <span key={index} className={diffKind(line) ? `permission-${diffKind(line)}` : undefined}>{line}{'\n'}</span>)}</pre>
    </figure>}
    {p.notice?.map((line, index) => <p key={index} className="question-guidance permission-notice">{line}</p>)}
    {p.question && <h3>{p.question}</h3>}
    {generic && p.options.length > 0 && !p.options[0].key && <p className="question-guidance">{t('cards.nativeDialogChoices')}</p>}
    <ul className="question-options" aria-label={t('cards.options')}>
      {p.options.map(row => {
        const copy = row.key ? keyedCopy(p.kind, row) : undefined;
        return <li key={row.number}>
          <div className="question-option-row">
            <button type="button" className="question-option" aria-pressed={row.focused} disabled={blocked || row.unavailable}
              data-permission-option={row.number} data-permission-key={row.key} onClick={() => void act({ kind: 'choose', number: row.number })}>
              <span className={`question-mark${row.key ? ' key' : ''}`} aria-hidden="true">{row.key ? keyGlyph[row.key] : row.number}</span>
              {copy ? <span className="question-option-copy"><strong lang={copy.native ? 'en' : undefined}>{copy.label}</strong><small>{copy.hint}</small>
                {!copy.native && <small lang="en" className="permission-native-label">{row.label}</small>}</span>
                : <span className="question-option-copy"><strong>{row.label}</strong>
                  {rejects(row.label) && <small>{t('cards.rejectHint')}</small>}</span>}
            </button>
          </div>
        </li>;
      })}
      {/* The billing notice's footer is "Enter to continue · Esc to cancel": both are choices here, as
          Esc is in any dialog whose key hints name it. */}
      {escapeRow && <li>
        <div className="question-option-row">
          <button type="button" className="question-option" aria-pressed={false} disabled={blocked} data-permission-cancel="Escape" onClick={() => void act({ kind: 'cancel' })}>
            <span className="question-mark key" aria-hidden="true">Esc</span>
            {generic ? <span className="question-option-copy"><strong lang="en">{p.escape}</strong><small>{t('cards.nativeDialogKeyHint', { key: 'Esc' })}</small></span>
              : <span className="question-option-copy"><strong>{t('cards.autoModeBillingCancel')}</strong><small>{t('cards.autoModeBillingCancelHint')}</small>
                <small lang="en" className="permission-native-label">cancel</small></span>}
          </button>
        </div>
      </li>}
    </ul>
    {unconfirmed && <p className="question-error" role="alert">{t('cards.resultUnconfirmed')}</p>}
    {!unconfirmed && result?.token === p.token && result.error && <p className="question-error" role="alert">{result.error}</p>}
    <div className="question-actions">
      {!billing && !generic && <button type="button" disabled={blocked} onClick={() => void act({ kind: 'cancel' })}><X size={13} aria-hidden="true" />{keyed ? t('cards.autoModeStopEsc') : t('cards.cancelEsc')}</button>}
      {pending && !unconfirmed && <span role="status">{t('cards.confirmingScreen')}</span>}
    </div>
  </section>;
}
