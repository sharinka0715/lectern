// The quit dialog: every conversation still running when Lectern quits, by machine, with
// what it is doing. The main process decides and closes (src/main/quit-guard.ts); this
// shows its state and sends the answer back.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Laptop, LoaderCircle, Server, TriangleAlert, X } from 'lucide-react';
import { defaultQuitPreferences, quitActivityText, quitGroups, quitTitle, type QuitAnswer, type QuitPrompt, type QuitSession, type QuitWhenRunning } from '../shared/quit';
import { joinList, t } from '../shared/i18n';
import { useLocale } from './i18n';
import { useDesktopState } from './desktop-state';
import { machineName } from './workspace-machines';
import { reportActionError } from './diagnostics';
import './quit-dialog.css';

/** Mount once in the main window. */
export function QuitPromptHost({ platform }: { platform: string }) {
  const [prompt, setPrompt] = useState<QuitPrompt | null>(null);
  useEffect(() => {
    // A window opened for the dialog (macOS) asks for it; later changes are pushed.
    let live = true, pushed = false;
    const off = window.desktop.onQuitPrompt(next => { pushed = true; setPrompt(next); });
    void window.desktop.quitPrompt().then(initial => { if (live && !pushed) setPrompt(initial); }).catch(() => {});
    return () => { live = false; off(); };
  }, []);
  return prompt ? <QuitDialog prompt={prompt} platform={platform} /> : null;
}

function CloseState({ session }: { session: QuitSession }) {
  switch (session.close) {
    case 'closing': return <span className="quit-close" data-close="closing"><LoaderCircle size={14} className="rotating" />{t('quit.stateClosing')}</span>;
    case 'closed': return <span className="quit-close" data-close="closed"><Check size={14} />{t('quit.stateClosed')}</span>;
    case 'failed': return <span className="quit-close" data-close="failed"><X size={14} />{t('quit.stateFailed')}</span>;
    case 'pending': return <span className="quit-close" data-close="pending">{t('quit.statePending')}</span>;
    default: return null;
  }
}

function SessionRow({ session }: { session: QuitSession }) {
  const busy = session.activity === 'working', background = !!session.background || !!session.backgroundUnknown;
  const dot = busy ? 'working' : session.activity === 'waiting' ? 'waiting' : background ? 'background' : session.activity;
  return <li className="quit-session" data-session-id={session.sessionId} data-pane-id={session.paneId} data-workspace-id={session.workspaceId}
    data-activity={session.activity} data-background={background ? 'true' : undefined} data-close={session.close} data-unconfirmed={session.unconfirmed ? 'true' : undefined}>
    <span className={`quit-dot state-${dot}`} aria-hidden="true" />
    <span className="quit-session-text">
      <span className="quit-session-title">{quitTitle(session)}</span>
      <span className="quit-session-meta">
        <span className="quit-session-folder">{session.folder}</span>
        <span className="quit-session-state" data-activity={session.activity}>{quitActivityText(session)}</span>
        {session.unconfirmed && <span className="quit-session-unconfirmed">{t('quit.unconfirmed')}</span>}
      </span>
      {session.error && <span className="quit-session-error">{session.error}</span>}
    </span>
    <CloseState session={session} />
  </li>;
}

function QuitDialog({ prompt, platform }: { prompt: QuitPrompt; platform: string }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const { connections } = useDesktopState();
  const [remember, setRemember] = useState(false);
  // The prompt this window answered: its buttons stay disabled until the next phase.
  const [answered, setAnswered] = useState<{ id: number; value: QuitAnswer }>();
  useLayoutEffect(() => {
    const element = dialog.current!;
    if (!element.open) element.showModal();
    return () => element.close();
  }, []);
  // Each phase starts on Cancel (Esc too); then the main process knows it is on screen.
  useEffect(() => {
    cancel.current?.focus();
    void window.desktop.quitPromptShown(prompt.id).catch(() => {});
  }, [prompt.id]);
  const answer = (value: QuitAnswer) => {
    if (answered?.id === prompt.id) return;
    setAnswered({ id: prompt.id, value });
    void window.desktop.answerQuit(prompt.id, value, value === 'leave' && remember).catch(error => {
      setAnswered(undefined);
      reportActionError(error, 'quit dialog answer');
    });
  };
  const groups = quitGroups(prompt, endpoint => machineName(endpoint, platform, connections));
  const listed = groups.filter(group => group.sessions.length), unreachable = groups.filter(group => !group.sessions.length && group.unchecked.length);
  const failed = prompt.sessions.filter(session => session.close === 'failed').length;
  const done = prompt.sessions.filter(session => session.close === 'closed' || session.close === 'failed').length;
  const closing = prompt.phase === 'closing', waiting = answered?.id === prompt.id;
  const quitting = waiting && (answered.value === 'leave' || answered.value === 'quit-anyway');
  const title = prompt.phase === 'confirm' ? t('quit.title', { count: prompt.sessions.length })
    : closing ? t('quit.closingTitle') : t('quit.failedTitle', { count: failed });
  return <dialog ref={dialog} className="modal quit-dialog" aria-labelledby="quit-dialog-title" data-phase={prompt.phase}
    onCancel={event => { event.preventDefault(); if (!closing) answer('cancel'); }}>
    <h2 id="quit-dialog-title">{title}</h2>
    <p className="modal-description">{prompt.phase === 'failed' ? t('quit.failedMessage') : closing ? t('quit.closingNote') : t('quit.message')}</p>
    <div className="quit-list" role="region" aria-label={t('quit.listLabel')} tabIndex={0}>
      {listed.map(group => <section key={group.key} className="quit-machine" data-machine={group.key} data-unchecked={group.unchecked.length ? 'true' : undefined}>
        <h3>
          {group.endpoint.kind === 'ssh' ? <Server size={14} /> : <Laptop size={14} />}
          <span className="quit-machine-name">{group.name}</span>
          <span className="quit-machine-count">{t('quit.machineCount', { count: group.sessions.length })}</span>
          {group.unchecked.length > 0 && <span className="quit-badge"><TriangleAlert size={12} />{t('quit.uncheckedBadge')}</span>}
        </h3>
        {group.unchecked.length > 0 && <p className="quit-machine-error">
          {joinList(group.unchecked.map(folder => t('quit.uncheckedFolder', { folder: folder.folder, error: folder.error })))}</p>}
        <ul>{group.sessions.map(session => <SessionRow key={`${session.workspaceId}:${session.paneId}`} session={session} />)}</ul>
      </section>)}
    </div>
    {unreachable.length > 0 && <div className="quit-unreachable" role="note">
      <TriangleAlert size={14} />
      <div>
        <span>{t('quit.uncheckedTitle')}</span>
        <ul>{unreachable.map(group => <li key={group.key} data-machine={group.key}>
          <strong>{group.name}</strong>
          <span>{joinList(group.unchecked.map(folder => t('quit.uncheckedFolder', { folder: folder.folder, error: folder.error })))}</span>
        </li>)}</ul>
      </div>
    </div>}
    {prompt.phase === 'confirm' && <label className="quit-remember">
      <input type="checkbox" checked={remember} disabled={waiting} onChange={event => setRemember(event.currentTarget.checked)} />
      <span>{t('quit.remember')}<small>{t('quit.rememberHint')}</small></span>
    </label>}
    {closing ? <div className="quit-progress" role="status">
      <span>{t('quit.closingProgress', { done, total: prompt.sessions.length })}</span>
      <progress max={prompt.sessions.length} value={done} />
    </div> : <div className="modal-footer">
      {quitting && <span className="quit-waiting" role="status"><LoaderCircle size={14} className="rotating" />{t('quit.quitting')}</span>}
      <div className="spacer" />
      <button ref={cancel} type="button" className="secondary-button" disabled={waiting} onClick={() => answer('cancel')}>{t('misc.cancel')}</button>
      {prompt.phase === 'confirm' ? <>
        <button type="button" className="primary-button quit-leave" disabled={waiting} onClick={() => answer('leave')}>
          <span>{t('quit.leave')}</span><small>{t('quit.leaveHint')}</small>
        </button>
        <button type="button" className="danger-button" disabled={waiting} onClick={() => answer('close')}>{t('quit.closeAll')}</button>
      </> : <button type="button" className="primary-button" disabled={waiting} onClick={() => answer('quit-anyway')}>{t('quit.quitAnyway')}</button>}
    </div>}
  </dialog>;
}

/** Settings → Session: what quitting does while conversations run. Kept by the main process,
 * which reads it also without a window. `resetKey` changes after "恢复默认" reset it. */
export function QuitPreferenceSetting({ resetKey }: { resetKey: number }) {
  const [value, setValue] = useState<QuitWhenRunning>();
  useEffect(() => {
    let live = true;
    void window.desktop.quitPreferences().then(preferences => { if (live) setValue(preferences.whenRunning); }).catch(() => {});
    return () => { live = false; };
  }, [resetKey]);
  const change = (whenRunning: QuitWhenRunning) => {
    setValue(whenRunning);
    void window.desktop.setQuitPreferences({ whenRunning }).then(saved => setValue(saved.whenRunning))
      .catch(error => reportActionError(error, 'quit preference'));
  };
  return <>
    <label>{t('quit.settingLabel')}
      <select aria-label={t('quit.settingLabel')} value={value ?? defaultQuitPreferences.whenRunning} disabled={!value}
        onChange={event => change(event.target.value === 'leave' ? 'leave' : 'ask')}>
        <option value="ask">{t('quit.settingAsk')}</option>
        <option value="leave">{t('quit.settingLeave')}</option>
      </select>
    </label>
    <p>{t('quit.settingHelp')}</p>
  </>;
}
