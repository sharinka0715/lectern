// Quitting while Lectern conversations still run in tmux. Electron-free: index.ts
// supplies the running list, the dialog (renderer or native) and the shutdown.
//
// Who is running: what Lectern already knows (the backend's last discovery, launches
// and reads; open readers' snapshots) plus one quick tmux probe per folder, capped by
// a deadline. A folder whose last discovery failed is not probed again: its earlier
// conversations are listed as unconfirmed and the machine is marked.
import { allTranslations, t } from '../shared/i18n';
import type { SessionInfo, SessionSnapshot, Workspace } from '../shared/types';
import { endpointKey, type QuitActivity, type QuitAnswer, type QuitPrompt, type QuitSession, type QuitUnchecked, type QuitWhenRunning } from '../shared/quit';

/** A conversation the backend sees in a pane. */
export type RunningInfo = Pick<SessionInfo, 'id' | 'title' | 'titleSource' | 'paneId' | 'status' | 'background'> & { panePid?: number };
/** What the backend knows of a folder without asking its machine. */
export interface KnownFolder { sessions: RunningInfo[]; okAt?: number; failedAt?: number; error?: string }
/** A fresh check of a folder: its running conversations, or why it could not be checked. */
export type FolderCheck = { sessions: RunningInfo[] } | { error: string };
export type SnapshotView = Pick<SessionSnapshot, 'workspaceId' | 'sessionId' | 'paneId' | 'panePid' | 'status' | 'turnControls' | 'backgroundWork' | 'background' | 'messages'>;
export interface QuitList { sessions: QuitSession[]; unchecked: QuitUnchecked[] }

/** The last discovery failed and nothing succeeded since: asking again would only wait. */
export function knownUnreachable(folder?: KnownFolder): boolean {
  return !!folder?.failedAt && (!folder.okAt || folder.failedAt > folder.okAt);
}

/** Automated runs (Playwright) quit without asking unless LECTERN_QUIT_PROMPT=1; =0 never asks. */
export function quitPromptEnabled(env: Record<string, string | undefined>, automated: boolean): boolean {
  if (env.LECTERN_QUIT_PROMPT === '1') return true;
  if (env.LECTERN_QUIT_PROMPT === '0') return false;
  return !automated;
}

/** Resolves like `work`, or rejects with `message()` after `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message())), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);

/** The busier of what an open reader saw and what the folder check saw: closing must not
 * hide a reply that one of them still sees running. */
function activityOf(info: RunningInfo, snapshot?: SnapshotView): QuitActivity {
  const seen = [snapshot?.turnControls?.running ? 'working' : undefined, snapshot?.status, info.status];
  return (['working', 'waiting', 'idle'] as const).find(state => seen.includes(state)) ?? 'unknown';
}

const hasWork = (counts?: SnapshotView['backgroundWork']) => !!counts && (counts.shells + counts.agents + counts.monitors + counts.workflows > 0 || !!counts.unknownShells);

function firstPrompt(snapshot?: SnapshotView) {
  const text = snapshot?.messages.find(message => message.role === 'user' && message.source === 'jsonl' && message.text.trim())?.text;
  return text?.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
}

/**
 * The running conversations to list, one per machine and pane, with the machines that
 * could not be checked. A checked folder lists exactly what its probe found; a folder
 * that could not be checked lists what Lectern saw earlier, marked unconfirmed.
 */
export function summarizeRunning(input: { workspaces: Workspace[]; known: Map<string, KnownFolder>; checks: Map<string, FolderCheck>; snapshots: SnapshotView[] }): QuitList {
  const sessions: QuitSession[] = [], unchecked: QuitUnchecked[] = [], seen = new Set<string>();
  const placeholder = new Set(allTranslations('backend.newConversation'));
  const machineOf = new Map(input.workspaces.map(workspace => [workspace.id, endpointKey(workspace)]));
  for (const workspace of input.workspaces) {
    const endpoint = { kind: workspace.kind, host: workspace.host, port: workspace.port }, machine = endpointKey(endpoint);
    const known = input.known.get(workspace.id), check = input.checks.get(workspace.id);
    let rows: RunningInfo[], unconfirmed = false;
    if (check && 'sessions' in check) rows = check.sessions;
    else {
      const error = check ? check.error : knownUnreachable(known) ? known!.error || t('quit.uncheckedBadge') : undefined;
      if (error !== undefined) {
        unconfirmed = true;
        unchecked.push({ workspaceId: workspace.id, folder: workspace.name, endpoint, error });
      }
      rows = [...(known?.sessions ?? [])];
      // An open reader may have seen a conversation start after the last discovery.
      for (const snapshot of input.snapshots) {
        if (snapshot.workspaceId === workspace.id && snapshot.paneId && !rows.some(row => row.id === snapshot.sessionId))
          rows.push({ id: snapshot.sessionId, title: '', paneId: snapshot.paneId, panePid: snapshot.panePid });
      }
    }
    for (const row of rows) {
      if (!row.paneId) continue;
      // Two folders can see the same pane (one inside the other): list it once.
      const key = `${machine}|${row.paneId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const snapshot = input.snapshots.find(item => item.sessionId === row.id && item.paneId === row.paneId && machineOf.get(item.workspaceId) === machine);
      const title = row.title && !(placeholder.has(row.title) && !row.titleSource) ? row.title : '';
      const background = hasWork(snapshot?.backgroundWork) ? snapshot!.backgroundWork : undefined;
      sessions.push({
        workspaceId: workspace.id, sessionId: row.id, title, ...(!title && { prompt: firstPrompt(snapshot) }), folder: workspace.name, endpoint,
        paneId: row.paneId, panePid: row.panePid ?? (snapshot?.panePid || undefined), activity: activityOf(row, snapshot),
        ...(background ? { background } : (snapshot?.background || row.background) && { backgroundUnknown: true }),
        ...(unconfirmed && { unconfirmed: true }),
      });
    }
  }
  return { sessions, unchecked };
}

export type QuitReason = 'user' | 'window' | 'installer' | 'system' | 'signal';

export interface QuitFlowOptions {
  /** Running conversations now. Machines that cannot be checked are listed, never thrown. */
  collect(): Promise<QuitList>;
  /** Whether this run asks at all (see quitPromptEnabled). */
  promptEnabled(): boolean;
  preference(): Promise<QuitWhenRunning>;
  /** Saves "leave" as the answer from now on. */
  remember(): Promise<void>;
  /** Shows (or with undefined, hides) the dialog. */
  present(prompt: QuitPrompt | undefined): void;
  /** Closes one listed conversation after checking it again; throws when it cannot. */
  close(session: QuitSession): Promise<void>;
  /** Shuts the app down for real. */
  quit(): void;
  /** A repeated quit while the dialog is up brings it to the front. */
  focus(): void;
  event?(name: string, data?: Record<string, unknown>): void;
  closeTimeoutMs?: number;
  /** Closes at a time on one machine (the sidebar reads each machine two at a time too). */
  perMachine?: number;
}

type State = 'idle' | 'collecting' | 'asking' | 'closing' | 'failed' | 'quitting';

/**
 * One quit at a time. A request while collecting, asking or closing only brings the dialog
 * forward; system shutdown and signals always quit at once, also over an open dialog.
 */
export class QuitFlow {
  private state: State = 'idle';
  private prompt?: QuitPrompt;
  private sequence = 0;
  constructor(private readonly options: QuitFlowOptions) {}

  get current(): QuitPrompt | undefined { return this.prompt; }
  get phase(): State { return this.state; }

  request(reason: QuitReason): void {
    this.options.event?.('app.quit_request', { reason, state: this.state });
    if (this.state === 'quitting') return;
    // Logging out, shutting down or a signal: never wait for an answer.
    if (reason === 'system' || reason === 'signal') return this.finish(reason);
    if (this.state !== 'idle') return this.options.focus();
    // The update installer is about to replace the app: leave conversations running.
    if (reason === 'installer') return this.finish('installer');
    if (!this.options.promptEnabled()) return this.finish('not-asked');
    this.state = 'collecting';
    void this.ask().catch(error => {
      this.options.event?.('app.quit_check_failed', { error: errorText(error) });
      if (this.state === 'collecting') this.finish('check-failed');
    });
  }

  private async ask() {
    const started = Date.now(), list = await this.options.collect();
    if (this.state !== 'collecting') return;
    this.options.event?.('app.quit_running', { count: list.sessions.length, unchecked: list.unchecked.length, ms: Date.now() - started,
      unconfirmed: list.sessions.filter(session => session.unconfirmed).length });
    if (!list.sessions.length) return this.finish('none-running');
    if (await this.options.preference() === 'leave') return this.finish('remembered');
    if (this.state !== 'collecting') return;
    this.state = 'asking';
    this.show('confirm', list.sessions, list.unchecked);
  }

  /** The dialog's answer; a stale id (an earlier phase) is ignored. */
  answer(id: number, answer: QuitAnswer, remember = false): void {
    const prompt = this.prompt;
    if (!prompt || prompt.id !== id || this.state === 'quitting') return;
    this.options.event?.('app.quit_answer', { phase: prompt.phase, answer, remember: remember && answer === 'leave' });
    if (prompt.phase === 'closing') return;
    if (answer === 'cancel') return this.reset();
    if (prompt.phase === 'confirm' && answer === 'leave') {
      // Remembered only for leaving; closing everything is asked every time.
      if (!remember) return this.finish('leave');
      this.prompt = undefined; // answered: later clicks are ignored while the choice is saved
      void this.options.remember().catch(error => this.options.event?.('app.quit_remember_failed', { error: errorText(error) }))
        .finally(() => this.finish('leave'));
      return;
    }
    if (prompt.phase === 'confirm' && answer === 'close') return void this.closeAll(prompt);
    if (prompt.phase === 'failed' && answer === 'quit-anyway') return this.finish('quit-anyway');
  }

  private show(phase: QuitPrompt['phase'], sessions: QuitSession[], unchecked: QuitUnchecked[], sameId = false) {
    if (!sameId) this.sequence++;
    this.prompt = { id: this.sequence, phase, sessions, unchecked };
    this.options.present(this.prompt);
  }

  private reset() {
    this.state = 'idle';
    this.prompt = undefined;
    this.options.present(undefined);
  }

  private finish(why: string) {
    if (this.state === 'quitting') return;
    this.state = 'quitting';
    this.options.event?.('app.quit_proceed', { why });
    this.options.quit();
  }

  private async closeAll(prompt: QuitPrompt) {
    this.state = 'closing';
    const sessions: QuitSession[] = prompt.sessions.map(session => ({ ...session, close: 'pending', error: undefined }));
    this.show('closing', sessions, prompt.unchecked);
    const update = (index: number, patch: Partial<QuitSession>) => {
      sessions[index] = { ...sessions[index], ...patch };
      if (this.state === 'closing') this.show('closing', [...sessions], prompt.unchecked, true);
    };
    const timeout = this.options.closeTimeoutMs ?? 30_000, perMachine = Math.max(1, this.options.perMachine ?? 2);
    const lanes = new Map<string, number[]>();
    sessions.forEach((session, index) => {
      const key = endpointKey(session.endpoint);
      lanes.set(key, [...(lanes.get(key) ?? []), index]);
    });
    // Machines in parallel; on one machine a few at a time, so its connection stays usable.
    await Promise.all([...lanes.values()].map(queue => Promise.all(Array.from({ length: Math.min(perMachine, queue.length) }, async () => {
      for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
        if (this.state !== 'closing') return;
        update(index, { close: 'closing' });
        try {
          await withDeadline(this.options.close(sessions[index]), timeout, () => t('quit.closeTimeout', { seconds: Math.round(timeout / 1000) }));
          update(index, { close: 'closed' });
        } catch (error) {
          update(index, { close: 'failed', error: errorText(error) });
        }
      }
    }))));
    if (this.state !== 'closing') return;
    const failed = sessions.filter(session => session.close === 'failed');
    this.options.event?.('app.quit_closed', { closed: sessions.length - failed.length, failed: failed.length });
    if (!failed.length) return this.finish('closed-all');
    this.state = 'failed';
    this.show('failed', sessions, prompt.unchecked);
  }
}
