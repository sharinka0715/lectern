import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, Server, ShieldAlert, X } from 'lucide-react';
import type { SshLoginPrompt } from '../shared/types';
import { closeSshLogin, useSshLoginRequest, type SshLoginRequest } from './ssh-login';
import './ssh-login.css';
import { t } from '../shared/i18n';

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/** Mounted once per window. Shows the current login request, if any. */
export function SshLoginHost() {
  const request = useSshLoginRequest();
  return request ? <SshLoginDialog key={request.id} request={request} /> : null;
}

type Phase = 'connecting' | 'prompt' | 'done' | 'failed';

function SshLoginDialog({ request }: { request: SshLoginRequest }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [prompt, setPrompt] = useState<SshLoginPrompt>();
  const [notices, setNotices] = useState<string[]>([]);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<'existing' | 'connected'>();
  const loginId = useRef('');
  const { host, port } = request.target;
  const address = `${host}${port ? `:${port}` : ''}`;
  const close = () => {
    if (phase === 'connecting' || phase === 'prompt') void window.desktop.cancelSshLogin(loginId.current).catch(() => {});
    closeSshLogin(request.id);
  };

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    const id = crypto.randomUUID();
    loginId.current = id;
    let live = true;
    setPhase('connecting'); setPrompt(undefined); setNotices([]); setError(''); setValue('');
    const unsubscribe = window.desktop.onSshLoginPrompt(next => {
      if (!live || next.loginId !== id) return;
      if (next.kind === 'info') { setNotices(list => [...list, next.text].slice(-4)); return; }
      setValue('');
      setPrompt(next);
      setPhase('prompt');
    });
    window.desktop.sshLogin(id, request.target).then(outcome => {
      if (!live) return;
      setResult(outcome);
      setPhase('done');
      request.onDone?.();
    }, failure => {
      if (!live) return;
      setError(errorText(failure));
      setPhase('failed');
    });
    return () => {
      live = false;
      unsubscribe();
      void window.desktop.cancelSshLogin(id).catch(() => {});
    };
  }, [attempt, request]);
  useEffect(() => { if (phase === 'prompt') input.current?.focus(); }, [phase, prompt]);
  useEffect(() => {
    if (phase !== 'done') return;
    const timer = window.setTimeout(() => closeSshLogin(request.id), result === 'existing' ? 900 : 1300);
    return () => window.clearTimeout(timer);
  }, [phase, result, request.id]);

  async function reply(answer: string | null) {
    const current = prompt;
    if (!current) return;
    setPrompt(undefined);
    setPhase('connecting');
    setValue('');
    try { await window.desktop.answerSshLogin(current.loginId, current.promptId, answer); }
    catch (failure) { setError(errorText(failure)); setPhase('failed'); }
  }

  const title = request.label && request.label !== host ? t('dialogs.labelWithAddress', { label: request.label, address }) : address;
  return <dialog ref={dialog} className="modal ssh-login" aria-labelledby="ssh-login-title" data-ssh-login-phase={phase}
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className="modal-header">
      <div><h2 id="ssh-login-title">{t('dialogs.sshLoginTitle')}</h2>
        <div className="ssh-login-host"><Server size={14} aria-hidden="true" />{title}</div>
      </div>
      <button type="button" className="icon-button" aria-label={t('dialogs.closeSshLogin')} onClick={close}><X size={18} /></button>
    </div>
    <div className="ssh-login-body">
      {prompt?.context && phase === 'prompt' && <pre className="ssh-login-context" aria-label={t('dialogs.serverMessage')}>{prompt.context}</pre>}
      {notices.map((notice, index) => <p key={index} className="ssh-login-notice" role="status">{notice}</p>)}
      {phase === 'connecting' && <p className="ssh-login-status" role="status"><Loader2 size={16} className="rotating" />{t('dialogs.connectingTo', { address })}</p>}
      {phase === 'done' && <p className="ssh-login-status ssh-login-success" role="status"><CheckCircle2 size={17} />
        {t(result === 'existing' ? 'dialogs.existingConnection' : 'dialogs.signedIn')}</p>}
      {phase === 'failed' && <p className="ssh-login-error" role="alert">{error || t('dialogs.loginFailed')}</p>}
      {phase === 'prompt' && prompt && (prompt.kind === 'hostkey' || prompt.kind === 'confirm' ? <div className="ssh-login-question">
        {prompt.kind === 'hostkey' && <p className="ssh-login-warning"><ShieldAlert size={16} />{t('dialogs.firstConnection')}</p>}
        <pre className="ssh-login-prompt-text">{prompt.text.trim()}</pre>
      </div> : <form id="ssh-login-form" className="ssh-login-form" onSubmit={event => { event.preventDefault(); void reply(value); }}>
        <label htmlFor="ssh-login-input">{prompt.text.trim() || t('dialogs.enter')}</label>
        <div className="ssh-login-field"><KeyRound size={15} aria-hidden="true" />
          <input id="ssh-login-input" ref={input} type={prompt.kind === 'secret' ? 'password' : 'text'} value={value}
            autoComplete={prompt.kind === 'secret' ? 'current-password' : 'one-time-code'} spellCheck={false} autoCapitalize="off"
            onChange={event => setValue(event.target.value.replace(/[\r\n]/g, ''))} />
        </div>
        <p className="ssh-login-hint">{t(prompt.kind === 'secret' ? 'dialogs.secretHint' : 'dialogs.plainHint')}</p>
      </form>)}
    </div>
    <div className="modal-footer"><div className="spacer" />
      {phase === 'failed' ? <>
        <button type="button" className="secondary-button" onClick={close}>{t('dialogs.close')}</button>
        <button type="button" className="primary-button" onClick={() => setAttempt(n => n + 1)}>{t('dialogs.signInAgain')}</button>
      </> : phase === 'done' ? <button type="button" className="primary-button" onClick={close}>{t('dialogs.done')}</button>
      : phase === 'prompt' && prompt?.kind === 'hostkey' ? <>
        <button type="button" className="secondary-button" onClick={() => void reply(null)}>{t('dialogs.cancel')}</button>
        <button type="button" className="primary-button" onClick={() => void reply('yes')}>{t('dialogs.trustContinue')}</button>
      </> : phase === 'prompt' && prompt?.kind === 'confirm' ? <>
        <button type="button" className="secondary-button" onClick={() => void reply(null)}>{t('dialogs.no')}</button>
        <button type="button" className="primary-button" onClick={() => void reply('yes')}>{t('dialogs.yes')}</button>
      </> : <>
        <button type="button" className="secondary-button" onClick={close}>{t('dialogs.cancel')}</button>
        {phase === 'prompt' && <button type="submit" form="ssh-login-form" className="primary-button">{t('dialogs.continue')}</button>}
      </>}
    </div>
  </dialog>;
}
