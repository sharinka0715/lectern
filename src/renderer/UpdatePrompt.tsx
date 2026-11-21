// The update prompt (new version: download / later / skip, then progress and the
// verified installer) and the "更新" settings page. State lives in the main
// process (src/main/update-service.ts); texts in src/shared/update-strings.ts.
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X } from 'lucide-react';
import type { UpdateState } from '../shared/update-check';
import { updateText, type UpdateTextKey } from '../shared/update-strings';
import { dateTimeText } from '../shared/i18n';
import { useLocale } from './i18n';

const checkEvent = 'lectern-check-updates';

/** The app menu's "检查更新…": check now and show the result even when nothing is new. */
export function checkForUpdatesFromMenu() {
  window.dispatchEvent(new Event(checkEvent));
}

export function useUpdateState() {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    let live = true;
    const off = window.desktop.onUpdateState(next => setState(next));
    void window.desktop.updateState().then(initial => { if (live) setState(previous => previous ?? initial); }).catch(() => {});
    return () => { live = false; off(); };
  }, []);
  return [state, setState] as const;
}

/** Texts in the app's current language; callers re-render through useLocale(). */
const textFor = (_state: UpdateState | undefined) =>
  (key: UpdateTextKey, values?: Record<string, string | number>) => updateText(undefined, key, values);

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** The error sentence for a failed check or download. */
function errorText(state: UpdateState, t: ReturnType<typeof textFor>) {
  if (state.status.kind !== 'error') return '';
  return t(`error.${state.status.code}` as UpdateTextKey, { detail: state.status.detail ?? '' });
}

/** Release notes from the GitHub release body (Markdown), without images or links that navigate. */
function ReleaseNotesText({ notes, empty }: { notes: string; empty: string }) {
  if (!notes.trim()) return <p className="update-notes-empty">{empty}</p>;
  return <div className="update-notes"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}
    components={{ a: ({ children }) => <span>{children}</span> }}>{notes}</ReactMarkdown></div>;
}

export function UpdatePrompt() {
  const [state] = useUpdateState();
  // Results of a check from the app menu are shown even when there is nothing new.
  const [announce, setAnnounce] = useState(false);
  useEffect(() => {
    const check = () => { setAnnounce(true); void window.desktop.checkForUpdates().catch(() => {}); };
    window.addEventListener(checkEvent, check);
    return () => window.removeEventListener(checkEvent, check);
  }, []);
  const status = state?.status;
  const visible = !!status && (['available', 'downloading', 'downloaded'].includes(status.kind)
    || status.kind === 'error' && (!!status.release || announce)
    || announce && (status.kind === 'up-to-date' || status.kind === 'checking'));
  if (!visible || !state) return null;
  return <UpdateDialog state={state} onClosed={() => setAnnounce(false)} />;
}

function UpdateDialog({ state, onClosed }: { state: UpdateState; onClosed(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useLocale();
  const t = textFor(state);
  const { status } = state;
  const act = (action: () => Promise<unknown>) => { setFailure(''); void action().catch(error => setFailure(String(error?.message ?? error))); };
  const close = (mode: 'later' | 'skip' = 'later') => { onClosed(); act(() => window.desktop.dismissUpdate(mode)); };
  const release = 'release' in status ? status.release : undefined;
  const title = status.kind === 'error' ? t('errorTitle') : status.kind === 'available' || release ? t('promptTitle') : t('settingsTitle');
  return <dialog ref={dialog} className="modal update-prompt" aria-labelledby="update-prompt-title" data-status={status.kind}
    onCancel={event => { event.preventDefault(); if (status.kind !== 'downloading') close(); }}>
    <div className="modal-header">
      <h2 id="update-prompt-title">{title}</h2>
      {status.kind !== 'downloading' && <button type="button" className="icon-button" aria-label={t('close')} onClick={() => close()}><X size={18} /></button>}
    </div>
    {release && <p className="modal-description">{t('promptVersion', { version: release.version, current: state.currentVersion })}</p>}
    {status.kind === 'checking' && <p className="modal-description" role="status">{t('checking')}</p>}
    {status.kind === 'up-to-date' && <p className="modal-description" role="status">{t('upToDate', { version: state.currentVersion })}</p>}
    {status.kind === 'error' && <p className="update-error" role="alert">{errorText(state, t)}</p>}
    {status.kind === 'available' && <>
      <h3 className="update-notes-title">{t('promptNotes')}</h3>
      <ReleaseNotesText notes={status.release.notes} empty={t('noNotes')} />
      {!status.asset && <p className="update-error">{t('noAsset', { platform: state.platform })}</p>}
    </>}
    {status.kind === 'downloading' && <div className="update-progress" role="status">
      <span>{t('downloading', { name: status.asset.name })}</span>
      <progress aria-label={t('downloading', { name: status.asset.name })} max={status.total || undefined} value={status.received} />
      <small>{t('progress', { received: formatBytes(status.received), total: formatBytes(status.total) })}</small>
    </div>}
    {status.kind === 'downloaded' && <div className="update-done" role="status">
      <p>{t('downloaded', { file: status.file })}</p>
      <p className="modal-description">{t('downloadedHint')}</p>
    </div>}
    {failure && <p className="update-error" role="alert">{failure}</p>}
    <UpdateActions state={state} t={t} act={act} close={close} />
  </dialog>;
}

function UpdateActions({ state, t, act, close }: {
  state: UpdateState; t: ReturnType<typeof textFor>; act(action: () => Promise<unknown>): void; close(mode?: 'later' | 'skip'): void;
}) {
  const { status } = state;
  const page = <button type="button" className="secondary-button" onClick={() => act(() => window.desktop.openUpdatePage())}>{t('openPage')}</button>;
  if (status.kind === 'available') return <div className="modal-footer">
    <button type="button" className="secondary-button" onClick={() => close('skip')}>{t('skip')}</button>
    <span className="spacer" />
    <button type="button" className="secondary-button" onClick={() => close('later')}>{t('later')}</button>
    {status.asset
      ? <button type="button" className="primary-button" onClick={() => act(() => window.desktop.downloadUpdate())}>{t('download')}</button>
      : page}
  </div>;
  if (status.kind === 'downloading') return <div className="modal-footer">
    <span className="spacer" />
    <button type="button" className="secondary-button" onClick={() => act(() => window.desktop.cancelUpdateDownload())}>{t('cancel')}</button>
  </div>;
  if (status.kind === 'downloaded') return <div className="modal-footer">
    <button type="button" className="secondary-button" onClick={() => act(() => window.desktop.revealDownloadedUpdate())}>{t('showInFolder')}</button>
    <span className="spacer" />
    <button type="button" className="secondary-button" onClick={() => close()}>{t('close')}</button>
    <button type="button" className="primary-button" onClick={() => act(() => window.desktop.openDownloadedUpdate())}>{t('openInstaller')}</button>
  </div>;
  if (status.kind === 'error' && status.release) return <div className="modal-footer">
    {page}
    <span className="spacer" />
    <button type="button" className="secondary-button" onClick={() => close()}>{t('close')}</button>
    <button type="button" className="primary-button" onClick={() => act(() => window.desktop.downloadUpdate())}>{t('retry')}</button>
  </div>;
  return <div className="modal-footer">
    <span className="spacer" />
    <button type="button" className="primary-button" onClick={() => close()}>{t('close')}</button>
  </div>;
}

/** Settings → 更新: automatic checks on/off, a manual check and its result. */
export function UpdateSettings() {
  const [state, setState] = useUpdateState();
  const [failure, setFailure] = useState('');
  useLocale();
  const t = textFor(state);
  if (!state) return <h3>{t('settingsTitle')}</h3>;
  const { status } = state;
  const run = (action: () => Promise<UpdateState>) => {
    setFailure('');
    void action().then(setState).catch(error => setFailure(String(error?.message ?? error)));
  };
  const result = status.kind === 'checking' ? t('checking')
    : status.kind === 'up-to-date' ? t('upToDate', { version: state.currentVersion })
      : status.kind === 'available' ? t('promptVersion', { version: status.release.version, current: state.currentVersion })
        : status.kind === 'error' ? errorText(state, t) : '';
  return <>
    <h3>{t('settingsTitle')}</h3>
    <p>{t('currentVersion', { version: state.currentVersion })}</p>
    {!state.configured ? <p className="update-not-configured">{t('notConfigured')}</p> : <>
      <label>{t('autoCheck')}
        <input type="checkbox" aria-label={t('autoCheck')} checked={state.autoCheck}
          onChange={event => {
            const autoCheck = event.currentTarget.checked;
            // Show the choice at once; the saved state follows from the main process.
            setState(previous => previous && { ...previous, autoCheck });
            run(() => window.desktop.setUpdatePreferences({ autoCheck }));
          }} />
      </label>
      <p>{t('autoCheckHint')}</p>
      <button className="pref-action" disabled={status.kind === 'checking' || status.kind === 'downloading'}
        onClick={() => run(() => window.desktop.checkForUpdates())}>{t('checkNow')}</button>
      {result && <p className="update-result" role="status">{result}</p>}
      {state.lastCheckedAt && <p>{t('lastChecked', { time: dateTimeText(state.lastCheckedAt) })}</p>}
      {state.skippedVersion && <p>{t('skipped', { version: state.skippedVersion })}</p>}
    </>}
    {failure && <p className="update-error" role="alert">{failure}</p>}
  </>;
}
