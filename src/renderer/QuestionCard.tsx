import { useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Eye, ListChecks, MessageSquare, PencilLine, Terminal } from 'lucide-react';
import { isQuestionText, type QuestionAction, type QuestionSnapshot } from '../shared/question-action';
import { reportActionError } from './diagnostics';
import './question-card.css';
import { imeOwnsKey, isEnterKey } from './enter-key';
import { t } from '../shared/i18n';

type Row = QuestionSnapshot['options'][number];
interface Props {
  question: QuestionSnapshot;
  busy: boolean;
  unconfirmed?: boolean;
  onAction(action: QuestionAction): Promise<void>;
  onViewTerminal(): void;
}

/** A projection of the live form: no local answer collection, key sequences or replay. */
export function QuestionCard({ question: q, busy, unconfirmed, onAction, onViewTerminal }: Props) {
  const [result, setResult] = useState<{ token: string; error?: string }>();
  const [draft, setDraft] = useState<{ token: string; value: string }>();
  const inFlight = useRef(false);
  const composing = useRef(false);
  const root = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusIntent = useRef<{token:string; page:string; edit?:number; origin:HTMLElement} | undefined>(undefined);
  const pending = result?.token === q.token && !result.error;
  const blocked = busy || pending || !!unconfirmed;
  const input = q.input?.focused ? q.input : undefined;
  const notes = input?.kind === 'notes';
  const value = draft?.token === q.token ? draft.value : input?.value ?? '';
  const dirty = !!input && value !== input.value;
  const choices = q.options.filter(row => row.kind === 'choice' || row.kind === 'other');
  const actions = q.options.filter(row => row.kind !== 'choice' && row.kind !== 'other');
  const active = q.options.find(row => row.focused);
  const hasPreview = q.input?.kind === 'notes' || q.preview !== undefined || q.canAmend;
  const hasReview = q.kind === 'review' || q.tabs.length > 1 || !!q.multiSelect;
  const incomplete = q.kind === 'review' && q.tabs.some(tab => !tab.answered);
  const submitLabel = t(incomplete ? q.review?.length ? 'cards.submitAnswered' : 'cards.submitEmpty' : 'cards.submit');
  const editingLabel = t(notes ? 'cards.optionNotes' : 'cards.customAnswer');
  const valid = isQuestionText(value);
  const pageKey = JSON.stringify([q.kind, q.activeTab, q.question]);
  useLayoutEffect(() => {
    const intent = focusIntent.current;
    if (!intent || blocked || intent.token === q.token) return;
    focusIntent.current = undefined;
    if (root.current?.closest('.desk-pane')?.getAttribute('data-active') !== 'true' ||
        (document.activeElement !== document.body && document.activeElement !== intent.origin)) return;
    // Disabled native buttons lose focus in Chromium. Restore only the user's
    // own interaction, never steal focus on a poll or from another split pane.
    if (intent.edit !== undefined && input?.number === intent.edit) field.current?.focus();
    else if (intent.page !== pageKey || !intent.origin.isConnected || intent.origin.matches(':disabled')) heading.current?.focus();
    else intent.origin.focus({preventScroll:true});
  }, [q.token, pageKey, blocked, input?.number]);

  async function act(action: QuestionAction) {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    const origin = document.activeElement;
    const edit = action.kind === 'amend' || (action.kind === 'focus' && choices.some(o => o.number === action.number && o.kind === 'other')) ? action.number : undefined;
    focusIntent.current = origin instanceof HTMLElement && root.current?.contains(origin) ? {token:q.token, page:pageKey, origin, edit} : undefined;
    setResult({ token: q.token });
    try {
      await onAction(action);
      // Do not re-enable a successful action on the old frame. Only a new
      // observed token (or disappearance of this card) can confirm the change.
    } catch (failure) {
      focusIntent.current = undefined;
      reportActionError(failure, '操作原生问答失败');
      const error = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(failure);
      setResult({ token: q.token, error: error || t('cards.unconfirmedResult') });
    } finally { inFlight.current = false; }
  }

  function choose(row: Row) {
    if (row.kind === 'other') {
      // Focusing the native Other field is not an answer. In particular never
      // press Enter to open an empty inline text field.
      if (input?.number === row.number) field.current?.focus();
      else void act({kind:'focus', number:row.number});
    } else void act({kind:'activate', number:row.number});
  }
  const editor = input && <div className="question-editor">
    <label><span>{editingLabel}</span><textarea ref={field} rows={1} value={value} disabled={blocked} autoComplete="off" spellCheck={false} aria-invalid={!valid}
      onChange={e => setDraft({ token:q.token, value:e.target.value })}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={e => {
        if (!isEnterKey(e) || e.repeat || imeOwnsKey(e.nativeEvent, composing.current)) return;
        e.preventDefault(); if (dirty && valid) void act({kind:'text', text:value});
      }} /></label>
    <div className="question-editor-actions">
      {dirty ? <><button type="button" className="secondary-button" disabled={blocked || !valid} onClick={() => void act({kind:'text',text:value})}>{t('cards.writeToScreen')}</button>
        <button type="button" className="question-link" disabled={blocked} onClick={() => setDraft(undefined)}>{t('cards.undoEdit')}</button>
        <small>{t(valid ? 'cards.writeNoSubmit' : 'cards.answerLimit')}</small></> : !q.multiSelect && (notes || !!input.value) ?
        <button type="button" className="primary-button" disabled={blocked} onClick={() => void act({kind:'activate',number:input.number})}>
          {t(notes ? 'cards.useWithNotes' : 'cards.useCustom')}</button> : q.multiSelect && !!input.value ?
        <button type="button" className="secondary-button" disabled={blocked} onClick={() => void act({kind:'activate',number:input.number})}>
          {t(active?.checked ? 'cards.uncheckCustom' : 'cards.checkCustom')}</button> : null}
    </div>
  </div>;

  return <section ref={root} className="question-card" aria-label={t('cards.question')} aria-busy={blocked} data-question-token={q.token} data-question-call={q.toolUseId}
    onKeyDownCapture={e => { if (e.repeat && (e.key === 'Enter' || (e.key === ' ' && e.target instanceof HTMLButtonElement))) e.preventDefault(); }}
    onClickCapture={e => { if (e.detail > 1 && e.target instanceof Element && e.target.closest('button')) { e.preventDefault(); e.stopPropagation(); } }}>
    <header className="question-header">
      <span><ListChecks size={16} aria-hidden="true" />{t(q.kind === 'review' ? 'cards.reviewAnswers' : q.multiSelect ? 'cards.multiSelect' : 'cards.singleSelect')}</span>
      <button type="button" onClick={onViewTerminal} title={t('cards.viewQuestionScreen')}><Terminal size={14} aria-hidden="true" />{t('cards.viewScreen')}</button>
    </header>
    {hasReview && q.tabs.length > 0 && <nav className="question-nav" aria-label={t('cards.pages')}>
      <button type="button" aria-label={t('cards.previousPage')} disabled={blocked || q.activeTab === 0 || !!input} onClick={() => void act({kind:'previous'})}><ChevronLeft size={16}/></button>
      <ol>{q.tabs.map((tab,i) => <li key={i} aria-current={i === q.activeTab ? 'step' : undefined}>
        {tab.answered && <Check size={12} aria-label={t('cards.answered')}/>}{tab.label}</li>)}
        <li aria-current={q.kind === 'review' ? 'step' : undefined}>{t('cards.review')}</li></ol>
      <button type="button" aria-label={t('cards.nextPage')} disabled={blocked || q.kind === 'review' || !!input} onClick={() => void act({kind:'next'})}><ChevronRight size={16}/></button>
    </nav>}
    <h3 ref={heading} tabIndex={-1}>{q.question || t(q.kind === 'review' ? 'cards.reviewBeforeSubmit' : 'cards.choose')}</h3>
    {!hasReview && <p className="question-guidance">{t(notes ? 'cards.notesGuidance' : 'cards.chooseGuidance')}</p>}
    {incomplete && <p className="question-guidance">{t('cards.unansweredLeft', { rest: t(q.review?.length ? 'cards.goBackOrSubmit' : 'cards.skipAll') })}</p>}
    {q.kind === 'review' && q.review && <dl className="question-review">{q.review.map((row,i) =>
      <div key={i}><dt>{row.question}</dt><dd>{row.answer}</dd></div>)}</dl>}
    {choices.length > 0 && <ul className="question-options">{choices.map(row => <li key={row.number}>
      <div className="question-option-row"><button className="question-option" type="button" disabled={blocked || dirty || (notes && row.number !== input.number)}
        aria-pressed={q.multiSelect || hasReview ? !!row.checked : undefined} data-question-number={row.number}
        title={row.kind !== 'other' && !hasReview ? t('cards.submitsDirectly') : undefined}
        onClick={() => choose(row)}>
        <span className={'question-mark' + (q.multiSelect ? ' multiple' : '')} aria-hidden="true">{row.checked ? <Check size={13}/> : row.number}</span>
        <span className="question-option-copy"><strong>{row.kind === 'other' ? t('cards.customAnswer') : row.label}</strong>{row.description && <small>{row.description}</small>}
          {row.kind === 'other' && !input && q.input?.value && <small>{q.input.value}</small>}</span>
      </button>
      {row.kind === 'choice' && hasPreview && !notes && <div className="question-option-tools">
        {hasPreview && <button type="button" disabled={blocked || notes || row.focused} aria-label={t('cards.previewOption', { label: row.label })} title={t('cards.previewOption', { label: row.label })}
          onClick={() => void act({kind:'focus', number:row.number})}><Eye size={15}/></button>}
        {q.canAmend && <button type="button" disabled={blocked || notes} aria-label={t('cards.noteOption', { label: row.label })} title={t('cards.noteOption', { label: row.label })}
          onClick={() => void act({kind:'amend', number:row.number})}><PencilLine size={15}/></button>}
      </div>}</div>
      {input?.number === row.number && editor}
    </li>)}</ul>}
    {q.input?.kind === 'notes' && !notes && q.input.value && <p className="question-guidance">{t('cards.currentNotes', { notes: q.input.value })}</p>}
    {hasPreview && !q.preview && active?.kind === 'choice' && <p className="question-guidance">{t('cards.noPreview')}</p>}
    {q.preview && <figure className="question-preview"><figcaption><Eye size={14} aria-hidden="true"/>{active?.label ? t('cards.previewOf', { label: active.label }) : t('cards.preview')}</figcaption><pre>{q.preview}</pre></figure>}
    {unconfirmed && <p className="question-error" role="alert">{t('cards.resultUnconfirmed')}</p>}
    {!unconfirmed && result?.token === q.token && result.error && <p className="question-error" role="alert">{result.error}</p>}
    <footer className="question-actions">
      {actions.map(row => <button key={row.number} type="button" className={row.kind === 'submit' || row.kind === 'next' ? 'primary-button' : 'question-link'}
        disabled={blocked || dirty || notes} data-question-number={row.number} title={row.label}
        onClick={() => void act({kind:'activate',number:row.number})}>
        {row.kind === 'chat' && <MessageSquare size={14} aria-hidden="true"/>}
        {row.kind === 'chat' ? t('cards.discuss') : row.kind === 'cancel' ? t('cards.cancelQuestion') : q.kind === 'review' ? submitLabel : row.kind === 'submit' ? t('cards.reviewAnswers') : t('cards.continue')}</button>)}
      {!actions.some(row => row.kind === 'cancel') && <button className="question-link" type="button" disabled={blocked}
        onClick={() => void act({kind:'cancel'})}>{t(notes ? 'cards.endNotes' : 'cards.cancelQuestion')}</button>}
      {pending && !unconfirmed && <span role="status">{t('cards.confirmingScreen')}</span>}
    </footer>
  </section>;
}
