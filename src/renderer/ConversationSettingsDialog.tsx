import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { SettingsFileValidation, SettingsOverrideSource } from '../shared/conversation-settings';
import type { ModelCatalog } from '../shared/model-catalog';
import { t } from '../shared/i18n';
import { imeOwnsKey, isEnterKey } from './enter-key';

type Mode = 'draft' | 'resume' | 'edit';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

interface EditorProps {
  workspaceId: string;
  initial: string | null;
  mode: Mode;
  running?: boolean;
  onApply(file: string | null, catalog?: ModelCatalog): void | Promise<void>;
  onClose?(): void;
}

export function SettingsFileEditor({ workspaceId, initial, mode, running, onApply, onClose }: EditorProps) {
  const [value, setValue] = useState(initial ?? '');
  const [validation, setValidation] = useState<SettingsFileValidation>();
  const [working, setWorking] = useState(false);
  const [checking, setChecking] = useState(false);
  const request = useRef(0);
  const composing = useRef(false);
  const active = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    active.current = true;
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => { active.current = false; element?.close(); };
  }, []);

  useEffect(() => {
    if (!value.trim()) { setChecking(false); return; }
    const generation = ++request.current;
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const result = await window.desktop.inspectConversationSettings(workspaceId, value);
        if (request.current === generation) setValidation(result);
      } catch (error) {
        if (request.current === generation) setValidation({ settingsFile: null, overrides: [], error: errorText(error) });
      } finally {
        if (request.current === generation) setChecking(false);
      }
    }, 250);
    return () => { clearTimeout(timer); ++request.current; };
  }, [workspaceId, value]);

  async function apply(event?: FormEvent) {
    event?.preventDefault();
    if (working || composing.current) return;
    ++request.current;
    setChecking(false);
    setWorking(true);
    try {
      const result = await window.desktop.validateConversationSettings(workspaceId, value);
      if (!active.current) return;
      setValidation(result);
      if (result.error || result.issues?.length) return;
      await onApply(result.settingsFile, result.catalog);
      onClose?.();
    } catch (error) {
      setValidation({ settingsFile: null, overrides: [], error: errorText(error) });
    } finally { setWorking(false); }
  }

  const draft = mode === 'draft';
  const form = <div className="settings-file-form" aria-busy={working} onKeyDown={event => {
    if (draft && isEnterKey(event) && event.target === input.current && !event.defaultPrevented && !imeOwnsKey(event.nativeEvent, composing.current)) {
      event.preventDefault();
      event.stopPropagation();
      void apply();
    }
    if (event.key === 'Escape' && (working || imeOwnsKey(event.nativeEvent, composing.current))) {
      event.preventDefault();
      event.stopPropagation();
    }
  }}>
    {!draft && <div className="modal-header"><h2>{t(mode === 'resume' ? 'conversationSettings.resumeTitle' : 'conversationSettings.title')}</h2></div>}
    {mode === 'resume' && <p className="field-hint">{t('conversationSettings.resumeHint')}</p>}
    <div className="settings-file-content">
      <label className="field-label">
        {!draft && mode === 'resume' && t('conversationSettings.title')}
        <input ref={input} value={value} readOnly={working} aria-label={t('conversationSettings.title')}
          autoComplete="off" spellCheck={false} placeholder={t('conversationSettings.placeholder')}
          onChange={event => { ++request.current; setValue(event.currentTarget.value); setValidation(undefined); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if ((isEnterKey(event) || event.key === 'Escape') && imeOwnsKey(event.nativeEvent, composing.current)) event.preventDefault();
            else if (event.code === 'NumpadEnter' && event.nativeEvent.keyCode === 229) {
              event.preventDefault();
              if (draft) void apply(); else event.currentTarget.form?.requestSubmit();
            }
          }} />
      </label>
      <p className="field-hint">{t('conversationSettings.help')}</p>
      <p className="field-hint">{t('conversationSettings.authorization')}</p>
      {running && <p className="field-hint">{t('conversationSettings.runningHint')}</p>}
      <div className="settings-file-result" aria-live="polite">
        {(working || checking) && <p role="status">{t(working ? 'conversationSettings.checkingCli' : 'conversationSettings.checking')}</p>}
        {!working && validation?.error && <p className="form-error" role="alert">{validation.error}</p>}
        {!working && !!validation?.issues?.length && <ul className="form-error" role="alert">
          {validation.issues.map((issue, index) => <li key={index}>
            <code>{issue.file}</code> <code>{issue.path}</code> <span>{issue.message}</span>
          </li>)}
        </ul>}
        {!working && !checking && validation && !validation.error && !validation.issues?.length && validation.settingsFile &&
          <p role="status">{t('conversationSettings.valid')}</p>}
        {!working && !!validation?.overrides.length && <>
          <p>{t('conversationSettings.preview')}</p>
          <ul>{validation.overrides.flatMap(source => source.items.map(item => <li key={source.file + item.key}><code>{item.key}</code></li>))}</ul>
        </>}
      </div>
    </div>
    <div className="modal-footer">
      <div className="spacer" />
      <button type="button" className="secondary-button" disabled={working} onClick={draft
        ? () => { ++request.current; setValue(''); setValidation(undefined); void onApply(null); } : onClose}>
        {t(draft ? 'conversationSettings.clear' : 'dialogs.cancel')}
      </button>
      <button type={draft ? "button" : "submit"} className="primary-button" disabled={working} onClick={draft ? () => void apply() : undefined}>
        {working && <Loader2 className="rotating" size={15} />}
        {t(draft ? 'conversationSettings.apply' : mode === 'resume' ? 'conversationSettings.resume' : 'dialogs.save')}
      </button>
    </div>
  </div>;

  return draft ? form : <dialog ref={dialog} className="modal settings-file-dialog" aria-label={t(mode === 'resume' ? 'conversationSettings.resumeTitle' : 'conversationSettings.title')}
    onCancel={event => { event.preventDefault(); if (!working && !composing.current) onClose?.(); }}><form onSubmit={apply}>{form}</form></dialog>;
}

const reason = (key: string) => {
  if (key.startsWith('statusLine.')) return 'conversationSettings.statusLine';
  if (key === 'enableWorkflows') return 'conversationSettings.workflows';
  if (key === 'permissions.defaultMode') return 'conversationSettings.defaultMode';
  if (key === 'env.CLAUDE_CODE_PROMPT_CACHE_TTL' || key === 'env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL') return 'conversationSettings.cacheTtl';
};

export type OverrideDecision = 'accept' | 'cancel' | 'acceptAlways';

export function SettingsOverrideDialog({ sources, decide }: { sources: SettingsOverrideSource[]; decide(value: OverrideDecision): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="modal confirm-action settings-override-dialog" aria-label={t('conversationSettings.overrideTitle')}
    onCancel={event => { event.preventDefault(); decide('cancel'); }}>
    <form onSubmit={event => { event.preventDefault(); decide('accept'); }}>
      <div className="modal-header"><h2>{t('conversationSettings.overrideTitle')}</h2></div>
      <p className="modal-description">{t('conversationSettings.overrideIntro')}</p>
      <div className="settings-override-list">
        {sources.map(({ file, items }, index) => <section key={index}>
          <h3><code>{file}</code></h3>
          <ul>{items.map(({ key, userValue, lecternValue }) => {
            const help = reason(key);
            return <li key={key}><strong><code>{key}</code></strong>
              <dl><dt>{t('conversationSettings.userValue')}</dt><dd><code>{userValue}</code></dd>
                <dt>{t('conversationSettings.lecternValue')}</dt><dd><code>{lecternValue}</code></dd></dl>
              {help && <p className="field-hint">{t(help)}</p>}
            </li>;
          })}</ul>
        </section>)}
      </div>
      <div className="modal-footer">
        <button type="button" className="secondary-button" onClick={() => decide('acceptAlways')}>{t('conversationSettings.acceptAlways')}</button>
        <div className="spacer" />
        <button type="button" className="secondary-button" onClick={() => decide('cancel')}>{t('dialogs.cancel')}</button>
        <button type="submit" className="primary-button" autoFocus>{t('conversationSettings.accept')}</button>
      </div>
    </form>
  </dialog>;
}
