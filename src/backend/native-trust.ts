import { isIdleEmptyComposer } from '../core/settings-screen';
import { randomUUID } from 'node:crypto';
import { stripTerminalEscapes } from '../core/screen';
import { parseDirectoryTrust, type DirectoryTrustDialog } from '../core/trust-screen';
import { diagnostic, summarize } from '../diagnostics';
import type { DirectoryTrustDecision, DirectoryTrustResult, DirectoryTrustSnapshot } from '../shared/types';
import { t } from '../shared/i18n';

export interface TrustObservation { paneId?: string; active: boolean; viewport: string; cwdAliases: readonly string[] }
export interface TrustContext { workspaceId: string; sessionId: string; targetKey: string }
export interface TrustDriver {
  inspect(): Promise<TrustObservation>;
  key(key: 'Up' | 'Down' | 'Enter', paneId: string): Promise<void>;
}
interface Ticket { context: TrustContext; snapshot: DirectoryTrustSnapshot; dialog: DirectoryTrustDialog; expires: number }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sameContext = (a: TrustContext, b: TrustContext) => a.targetKey === b.targetKey && a.sessionId === b.sessionId;
export class DirectoryTrustError extends Error {
  constructor(message: string) { super(message); this.name = 'DirectoryTrustError'; }
}
/** A driver's proof that this key never reached the pane, even for Enter. */
export class TrustKeyNotSent extends DirectoryTrustError {}

/** A visible trust dialog is only an observation. No method sends input until
 * respond is called with an explicit user decision and a valid observed token. */
export class NativeDirectoryTrust {
  private readonly tickets = new Map<string, Ticket>();
  /** Navigation and closure have separate budgets. Over SSH every observation is
   * a round trip, and after Yes Claude may need seconds to paint its first screen
   * (an animated logo keeps repainting it), so one shared short deadline used to
   * expire right after Enter. */
  constructor(private readonly timeoutMs = 12_000, private readonly tokenLifetimeMs = 120_000,
    private readonly verifyTimeoutMs = 20_000, private readonly resendAfterMs = 1000) {}
  private purge(): void { for (const [token, ticket] of this.tickets) if (ticket.expires <= Date.now()) this.tickets.delete(token); }
  private discard(context: TrustContext): void { for (const [token, ticket] of this.tickets) if (sameContext(ticket.context, context)) this.tickets.delete(token); }
  private dialog(observation: TrustObservation): DirectoryTrustDialog | undefined {
    if (!observation.active || !observation.paneId) return;
    const dialog = parseDirectoryTrust(observation.viewport);
    if (!dialog || !observation.cwdAliases.includes(dialog.cwd)) return;
    return dialog;
  }
  /** Pure: use the already captured readSession viewport, without more SSH I/O. */
  observe(context: TrustContext, observation: TrustObservation): DirectoryTrustSnapshot | undefined {
    this.purge();
    const dialog = this.dialog(observation);
    if (!dialog) { this.discard(context); return; }
    for (const ticket of this.tickets.values()) {
      if (sameContext(ticket.context, context) && ticket.snapshot.paneId === observation.paneId && ticket.dialog.signature === dialog.signature) return ticket.snapshot;
    }
    this.discard(context);
    while (this.tickets.size >= 64) this.tickets.delete(this.tickets.keys().next().value!);
    const snapshot: DirectoryTrustSnapshot = { token: randomUUID(), sessionId: context.sessionId, paneId: observation.paneId!, cwd: dialog.cwd, observedAt: new Date().toISOString(), acceptLabel: dialog.acceptLabel, cancelLabel: dialog.cancelLabel, scope: dialog.scope, cancelDecision: dialog.cancelDecision, warnings: dialog.warnings, disclosure: dialog.disclosure };
    this.tickets.set(snapshot.token, { context, snapshot, dialog, expires: Date.now() + this.tokenLifetimeMs });
    diagnostic.event('directory_trust.observed', { workspaceId: context.workspaceId, sessionId: context.sessionId, paneId: snapshot.paneId, cwd: snapshot.cwd, scope: snapshot.scope, focused: dialog.focused, automaticInput: false });
    return snapshot;
  }
  private async inspect(driver: TrustDriver, context: TrustContext, phase: string): Promise<TrustObservation> {
    const observation = await driver.inspect();
    const captureId = diagnostic.capture('directory_trust.viewport', observation.viewport, { workspaceId: context.workspaceId, sessionId: context.sessionId, paneId: observation.paneId, phase });
    diagnostic.event('directory_trust.checked', { phase, paneId: observation.paneId, active: observation.active, captureId, viewport: summarize(observation.viewport) }, 'debug');
    return observation;
  }
  async get(driver: TrustDriver, context: TrustContext): Promise<DirectoryTrustSnapshot | undefined> {
    return this.observe(context, await this.inspect(driver, context, 'get'));
  }
  async respond(driver: TrustDriver, context: TrustContext, token: string, decision: DirectoryTrustDecision): Promise<DirectoryTrustResult> {
    if (decision !== 'trust' && decision !== 'exit' && decision !== 'continue') throw new DirectoryTrustError(t('native.trustUnsupported'));
    this.purge();
    const ticket = this.tickets.get(token);
    if (!ticket || !sameContext(ticket.context, context)) throw new DirectoryTrustError(t('native.trustExpired'));
    if (decision !== 'trust' && decision !== ticket.dialog.cancelDecision) throw new DirectoryTrustError(t('native.trustCancelMismatch'));
    this.tickets.delete(token); // Never replay an uncertain confirmation.
    return diagnostic.operation('directory_trust.respond', { workspaceId: context.workspaceId, sessionId: context.sessionId, decision }, async () => {
      const deadline = Date.now() + this.timeoutMs, paneId = ticket.snapshot.paneId;
      let submitted = false;
      const currentDialog = async (phase: string) => {
        if (Date.now() >= deadline) throw new DirectoryTrustError(t('native.trustTimeout'));
        const observation = await this.inspect(driver, context, phase), dialog = this.dialog(observation);
        if (observation.paneId !== paneId || !dialog || dialog.cwd !== ticket.dialog.cwd) throw new DirectoryTrustError(t('native.trustContextChanged'));
        return dialog;
      };
      try {
        let dialog = await currentDialog('before-decision');
        if (dialog.signature !== ticket.dialog.signature) throw new DirectoryTrustError(t('native.trustFocusChanged'));
        let sentAt = 0, resent = 0;
        const navigate = async (from: DirectoryTrustDialog) => {
          const target = decision === 'trust' ? from.acceptIndex : from.cancelIndex;
          const current = from.focused === 'trust' ? from.acceptIndex : from.cancelIndex;
          const key = target < current ? 'Up' : 'Down';
          diagnostic.event('directory_trust.navigate', { paneId, decision, cwd: from.cwd, key, repeated: sentAt > 0 });
          await driver.key(key, paneId);
          sentAt = Date.now();
        };
        if (dialog.focused !== decision) await navigate(dialog);
        const initialIdentity = JSON.stringify({ ...ticket.dialog, signature: undefined });
        // Enter needs two consecutive observations of the same dialog with the
        // requested focus. Claude drops keys sent while it is still mounting the
        // chooser, so navigation repeats once, only while the focus never moved.
        for (;;) {
          const fresh = await currentDialog(sentAt ? 'navigation-settle' : 'before-enter');
          if (JSON.stringify({ ...fresh, focused: ticket.dialog.focused, signature: undefined }) !== initialIdentity) throw new DirectoryTrustError(t('native.trustContentChanged'));
          if (fresh.focused === decision && dialog.focused === decision && fresh.signature === dialog.signature) break;
          const stuck = fresh.focused === ticket.dialog.focused && sentAt > 0 && !resent && Date.now() - sentAt >= this.resendAfterMs;
          dialog = fresh;
          if (stuck) { resent++; await navigate(fresh); }
          else if (fresh.focused !== decision) await delay(60);
        }
        submitted = true;
        diagnostic.event('directory_trust.submit', { paneId, decision, cwd: dialog.cwd, scope: dialog.scope, key: 'Enter', automaticRetry: false });
        await driver.key('Enter', paneId);
        // Closure is two consecutive frames without the dialog, not two equal
        // frames: Claude's startup logo animates for about a second after Yes.
        const verifyDeadline = Date.now() + this.verifyTimeoutMs;
        let streak = 0;
        while (Date.now() < verifyDeadline) {
          const observation = await this.inspect(driver, context, 'verify-closed');
          if (observation.paneId && observation.paneId !== paneId) throw new DirectoryTrustError(t('native.trustPaneMoved'));
          const plain = stripTerminalEscapes(observation.viewport);
          const closed = decision === 'exit' ? !observation.active : observation.active
            && observation.paneId === paneId && !!plain.trim()
            && (decision !== 'continue' || isIdleEmptyComposer(observation.viewport))
            && !parseDirectoryTrust(observation.viewport) && !/^\s*Accessing workspace:\s*$/m.test(plain);
          streak = closed ? streak + 1 : 0;
          if (streak >= 2) {
            this.discard(context);
            diagnostic.event('directory_trust.closed', { paneId, decision, cwd: dialog.cwd, active: observation.active, verifyMs: this.verifyTimeoutMs - (verifyDeadline - Date.now()) });
            return { decision, sessionId: context.sessionId, paneId, closed: true };
          }
          await delay(80);
        }
        throw new DirectoryTrustError(t('native.trustNotClosed'));
      } catch (error) {
        // Never Escape or press a second Enter while outcome or dialog is unknown.
        if (submitted && !(error instanceof TrustKeyNotSent)) throw new DirectoryTrustError(t('native.trustMaybeSent', { detail: error instanceof Error ? error.message : '' }).trimEnd());
        throw error;
      }
    });
  }
}
