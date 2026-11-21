import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { isLaterVersion, releaseItemText, releaseNotes } from '../shared/release-notes';

import { getLocale, t } from '../shared/i18n';

/** Every version's changes since the one before it, newest first. */
export function ReleaseNotesDialog({ current, onClose }: { current?: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="modal release-notes" aria-labelledby="release-notes-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="modal-header">
      <h2 id="release-notes-title">{t('misc.releaseNotes')}</h2>
      <button type="button" className="icon-button" aria-label={t('misc.closeReleaseNotes')} onClick={onClose}><X size={18} /></button>
    </div>
    <div className="release-notes-body">
      {releaseNotes.map(note => <section key={note.version} className="release-note" aria-labelledby={`release-${note.version}`}
        data-current={note.version === current || undefined}>
        <h3 id={`release-${note.version}`}>v{note.version}{note.version === current && <span className="release-current">{t('misc.currentVersion')}</span>}
          {current && isLaterVersion(note.version, current) && <span className="release-current release-pending">{t('misc.pending')}</span>}</h3>
        {note.features.length > 0 && <><h4>{t('misc.features')}</h4><ol>{note.features.map((item, i) => <li key={i}>{releaseItemText(item, getLocale())}</li>)}</ol></>}
        {note.fixes.length > 0 && <><h4>{t('misc.fixes')}</h4><ol>{note.fixes.map((item, i) => <li key={i}>{releaseItemText(item, getLocale())}</li>)}</ol></>}
      </section>)}
    </div>
  </dialog>;
}
