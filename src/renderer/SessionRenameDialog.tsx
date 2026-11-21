import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { normalizeSessionTitle } from "../shared/session-title";
import type { SessionInfo } from "../shared/types";
import { imeOwnsKey, isEnterKey } from "./enter-key";
import { t } from '../shared/i18n';

export function SessionRenameDialog({ session, onSave, onClose }: {
  session: SessionInfo;
  onSave(title: string): Promise<void>;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    input.current?.select();
    return () => element.close();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || composing.current) return;
    try {
      const title = normalizeSessionTitle(draft);
      setSaving(true);
      setError("");
      await onSave(title);
      onClose();
    } catch (error) {
      setSaving(false);
      setError(error instanceof Error ? error.message : String(error));
      input.current?.focus();
    }
  }

  return (
    <dialog ref={dialog} className="modal session-rename-dialog" aria-labelledby="session-rename-heading"
      onCancel={event => {
        event.preventDefault();
        if (!saving && !composing.current) onClose();
      }}>
      <form onSubmit={save} aria-busy={saving}>
        <div className="modal-header"><h2 id="session-rename-heading">{t('dialogs.renameTitle')}</h2></div>
        <label className="field-label">
          {t('dialogs.sessionName')}
          <input ref={input} value={draft} readOnly={saving} autoFocus
            aria-describedby={error ? "session-rename-error" : undefined}
            onChange={event => { setDraft(event.target.value); setError(""); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if ((isEnterKey(event) || event.key === "Escape") && imeOwnsKey(event.nativeEvent, composing.current)) {
                event.preventDefault();
              } else if (event.code === "NumpadEnter" && event.nativeEvent.keyCode === 229) {
                // An input method kept the keypad Enter to itself: submit as Return would.
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </label>
        {!session.paneId && session.path && (
          <p className="field-hint">{t('dialogs.renameHint')}</p>
        )}
        {error && <p id="session-rename-error" className="form-error" role="alert">{error}</p>}
        <div className="modal-footer">
          <div className="spacer" />
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>{t('dialogs.cancel')}</button>
          <button type="submit" className="primary-button" disabled={saving || !draft.trim()}>
            {saving && <Loader2 className="rotating" size={15} />}
            {t(saving ? 'dialogs.saving' : 'dialogs.save')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
