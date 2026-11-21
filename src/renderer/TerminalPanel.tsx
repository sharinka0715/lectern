import type React from 'react';
import { forwardRef, lazy, Suspense, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Copy, Eye, Keyboard, Loader2, Terminal, TextSelect, X } from 'lucide-react';
import { copyWithToast, showContextMenu } from './ContextMenu';
import { selectionWithin } from './message-menus';
import type { NavigationSessionStatus, SessionStatus, TerminalControl, TerminalFrame, TerminalInput } from '../shared/types';
import { reportActionError } from './diagnostics';
import { mergeTyping, TerminalInputQueue, type LeasedInput } from './terminal-input';
import { localeTag, t, type MessageKey } from '../shared/i18n';

const TerminalViewport = lazy(() => import('./TerminalViewport'));
// The screen height is the user's choice, shared by every conversation.
const heightKey = 'lectern.terminal.height', defaultHeight = 380, minHeight = 140;
const maxHeight = () => Math.max(minHeight, Math.round(window.innerHeight * 0.75));
function savedHeight() {
  try {
    const value = Number(localStorage.getItem(heightKey));
    if (Number.isInteger(value) && value >= minHeight && value <= 4000) return value;
  } catch { /* A read-only profile still resizes for this window. */ }
  return defaultHeight;
}
const labels: Record<SessionStatus, MessageKey> = {
  connecting: 'activity.termConnecting', idle: 'activity.termIdle', working: 'activity.termWorking', waiting: 'activity.termWaiting',
  offline: 'activity.termOffline', error: 'activity.termError',
};
export interface TerminalPanelHandle { close(): void }
interface Props {
  workspaceId: string; sessionId: string; screen: string; frame?: TerminalFrame; paneId?: string;
  status: SessionStatus; capturedAt?: string; observationStatus?: NavigationSessionStatus;
  control?: TerminalControl; automatedBusy?: boolean;
  onBusyChange(busy: boolean): void; onClose(): void;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, Props>(function TerminalPanel(props, ref) {
  const { workspaceId, sessionId, screen, frame, paneId, status, capturedAt, observationStatus, control, automatedBusy, onClose } = props;
  const connected = !!paneId && status !== 'offline' && status !== 'connecting';
  const lease = connected && control?.paneId === paneId ? control : undefined;
  const manual = !!lease;
  const leaseRef = useRef(lease);
  leaseRef.current = lease;
  const busyCallback = useRef(props.onBusyChange);
  busyCallback.current = props.onBusyChange;
  const viewport = useRef<HTMLPreElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusOrigin = useRef<Element | null>(null);
  const alive = useRef(true);
  const queue = useRef<TerminalInputQueue<LeasedInput> | undefined>(undefined);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState('');
  const [transition, setTransition] = useState<'take' | 'release'>();
  const transitioning = useRef(false);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const hint = useId();
  // Takeover frames arrive between snapshots from the fast link; use whichever is newer.
  const [liveFrame, setLiveFrame] = useState<TerminalFrame>();
  useEffect(() => {
    setLiveFrame(undefined);
    if (!lease) return;
    return window.desktop.onTerminalFrame(event => {
      if (event.workspaceId === workspaceId && event.sessionId === sessionId && event.frame.paneId === lease.paneId) setLiveFrame(event.frame);
    });
  }, [workspaceId, sessionId, lease?.token, lease?.paneId]);
  const shownFrame = liveFrame && (!frame?.seq || (liveFrame.seq ?? 0) >= frame.seq) && (!frame || frame.paneId === liveFrame.paneId) ? liveFrame : frame;
  const [height, setHeight] = useState(savedHeight);
  const drag = useRef<{ id: number; startY: number; startHeight: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clampHeight = (value: number) => Math.max(minHeight, Math.min(maxHeight(), Math.round(value)));
  function rememberHeight(value: number) {
    setHeight(value);
    try { localStorage.setItem(heightKey, String(value)); } catch { /* Keep the in-memory size. */ }
  }

  useLayoutEffect(() => {
    alive.current = true;
    const next = new TerminalInputQueue<LeasedInput>(async ({ token, input }) => {
      if (!alive.current || leaseRef.current?.token !== token) throw new Error(t('activity.takeoverChanged'));
      await window.desktop.sendTerminalInput(workspaceId, sessionId, token, input);
    }, count => { if (alive.current) setQueued(count); }, (failure, discarded) => {
      reportActionError(failure, '手动终端输入失败');
      if (alive.current) setError(t('activity.inputFailed', { message: errorMessage(failure), discarded: discarded ? t('activity.discarded', { count: discarded }) : '' }));
    }, 64, mergeTyping);
    queue.current = next;
    return () => { alive.current = false; next.dispose(); busyCallback.current(false); };
  }, [workspaceId, sessionId]);
  useLayoutEffect(() => { queue.current?.cancelPending(); }, [lease?.token, paneId]);
  useEffect(() => { busyCallback.current(manual || !!transition); }, [manual, transition]);
  useEffect(() => {
    if (viewport.current && follow.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [screen, paneId, manual]);

  async function ownership(enable: boolean, close = false) {
    if (transitioning.current) return;
    const token = leaseRef.current?.token;
    if (!enable && !token) { if (close) onClose(); return; }
    if (enable && (token || !connected || automatedBusy)) return;
    transitioning.current = true;
    setTransition(enable ? 'take' : 'release');
    setError(''); busyCallback.current(true);
    focusOrigin.current = enable ? toggle.current : null;
    try {
      if (!enable) {
        queue.current?.cancelPending();
        await queue.current?.whenIdle();
        if (!alive.current) return;
      }
      if (enable || leaseRef.current?.token === token)
        await window.desktop.setTerminalControl(workspaceId, sessionId, enable, token);
      if (alive.current && close) onClose();
    } catch (failure) {
      reportActionError(failure, enable ? '接管终端失败' : '结束终端接管失败');
      if (alive.current) {
        focusOrigin.current = null;
        if (!leaseRef.current && close) onClose(); else setError(errorMessage(failure));
      }
    } finally {
      transitioning.current = false;
      if (alive.current) setTransition(undefined);
    }
  }
  useImperativeHandle(ref, () => ({ close: () => { void ownership(false, true); } }));
  function send(input: TerminalInput) {
    const token = leaseRef.current?.token;
    if (!token || transitioning.current) return;
    setError(''); void queue.current?.enqueue({ token, input });
  }
  const stamp = capturedAt ? new Date(capturedAt) : undefined;
  const time = stamp && Number.isFinite(+stamp) ? stamp.toLocaleTimeString(localeTag(), { hour12: false }) : undefined;
  const label = t(status === 'offline' || status === 'connecting' || status === 'error' ? labels[status] :
    observationStatus === 'error' ? 'activity.termError' : observationStatus === 'unknown' && status === 'idle' ? 'activity.termUnconfirmed' : !paneId ? 'activity.termNoPane' : labels[status]);
  const plain = <pre ref={viewport} tabIndex={0} aria-label={t('activity.readOnlyScreen')} onScroll={event => {
    const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; setFollowing(follow.current);
  }}>{screen ? screen.replace(/\n[ \t\n]*$/, '\n') : t(paneId ? 'activity.waitingScreen' : 'activity.noTerminal')}</pre>;

  function terminalMenu(event: React.MouseEvent<HTMLElement>) {
    // While typing into the native screen the xterm view keeps its own clipboard keys.
    if (manual && (event.target as Element).closest('.xterm')) return;
    const selected = selectionWithin(event.currentTarget).trim(), text = screen.replace(/\s+$/, '');
    showContextMenu(event, [
      !!selected && { label: t('activity.copySelection'), icon: <TextSelect size={14} />, onSelect: () => copyWithToast(selected) },
      !!text && { label: t('activity.copyScreen'), icon: <Copy size={14} />, onSelect: () => copyWithToast(text) },
      'separator',
      { label: t(manual ? 'activity.endTakeover' : 'activity.takeOver'), icon: <Keyboard size={14} />, disabled: !!transition || (!manual && (!connected || !!automatedBusy)), onSelect: () => ownership(!manual) },
      !manual && !following && { label: t('activity.followOutput'), icon: <ArrowDown size={14} />, onSelect: () => { follow.current = true; setFollowing(true); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; } },
      { label: t('activity.closeTerminal'), icon: <X size={14} />, disabled: !!transition, onSelect: () => ownership(false, true) },
    ], t('activity.terminal'));
  }
  return <section className={`terminal-panel${manual ? ' terminal-panel-manual' : ''}`} aria-label={t('activity.panelLabel', { manual: String(manual) })} data-readonly={!manual} data-terminal-control={manual}
    style={{ '--terminal-height': `${clampHeight(height)}px` } as React.CSSProperties} onContextMenu={terminalMenu}>
    <div className="terminal-resize" role="separator" aria-label={t('activity.resizeTerminal')} aria-orientation="horizontal" tabIndex={0}
      aria-valuemin={minHeight} aria-valuemax={maxHeight()} aria-valuenow={clampHeight(height)} aria-valuetext={t('activity.pixels', { height: clampHeight(height) })}
      title={t('activity.resizeTitle')} data-dragging={dragging || undefined}
      onDoubleClick={() => rememberHeight(defaultHeight)}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, startY: event.clientY, startHeight: clampHeight(height) };
        setDragging(true);
      }}
      onPointerMove={event => {
        const start = drag.current;
        // Dragging the top edge up makes the screen taller.
        if (start?.id === event.pointerId) setHeight(clampHeight(start.startHeight + start.startY - event.clientY));
      }}
      onPointerUp={event => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        rememberHeight(clampHeight(start.startHeight + start.startY - event.clientY));
        drag.current = null; setDragging(false);
      }}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) { drag.current = null; setDragging(false); } }}
      onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) { drag.current = null; setDragging(false); rememberHeight(clampHeight(height)); } }}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const step = event.key === 'ArrowUp' ? 24 : event.key === 'ArrowDown' ? -24 : 0;
        if (!step) return;
        event.preventDefault();
        rememberHeight(clampHeight(height + step));
      }} />
    <div className="terminal-heading">
      <span><Terminal size={15} />{t('activity.nativeTerminal')}{paneId && <code>{paneId}</code>}
        <span className="terminal-readonly">{manual ? <Keyboard size={12}/> : <Eye size={12}/>}{t(manual ? 'activity.manual' : 'activity.readOnly')}</span>
      </span>
      <span className={`terminal-observation terminal-observation-${status}`}>{label}{time && <time dateTime={capturedAt}>{t('activity.captured', { time })}</time>}</span>
      <button ref={toggle} type="button" className="terminal-control-toggle" data-terminal-action={manual ? 'release' : 'take'}
        disabled={!!transition || (!manual && (!connected || !!automatedBusy))} onClick={() => void ownership(!manual)}>
        {transition && <Loader2 size={12} className="rotating"/>}{t(transition === 'take' ? 'activity.takingOver' : transition === 'release' ? 'activity.releasing' : manual ? 'activity.endTakeover' : 'activity.takeOver')}
      </button>
      <button className="icon-button" type="button" aria-label={t('activity.closeScreen')} disabled={!!transition} onClick={() => void ownership(false, true)}><X size={16}/></button>
    </div>
    {lease && shownFrame && shownFrame.paneId === lease.paneId ? <Suspense fallback={plain}>
      <TerminalViewport key={lease.token} frame={shownFrame} hint={hint} onInput={send} onError={setError} leave={() => toggle.current?.focus()}
        shouldFocus={() => {
          const origin = focusOrigin.current; focusOrigin.current = null;
          return !!origin && (document.activeElement === origin || document.activeElement === document.body);
        }} />
    </Suspense> : plain}
    {error && <div className="terminal-control-error" role="alert">{error}</div>}
    <div className="terminal-readonly-note">
      <span id={hint}>{t(status === 'offline' ? 'activity.offlineNote' : manual && !shownFrame ? 'activity.waitingFrame' : manual ? 'activity.manualHint' : 'activity.readOnlyHint')}</span>
      {manual ? <span role="status" data-terminal-pending={queued}>{queued ? t('activity.pending', { count: queued }) : ''}</span> : !following && <button type="button" onClick={() => {
        follow.current = true; setFollowing(true); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
      }}><ArrowDown size={12}/>{t('activity.followOutput')}</button>}
    </div>
  </section>;
});

function errorMessage(failure: unknown) {
  return failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(failure);
}
