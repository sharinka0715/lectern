import { diagnostic } from '../diagnostics';

/**
 * How Lectern reaches an SSH host: over a master the user's own ssh_config runs
 * (shared with their terminals and editors), or over a connection of its own.
 */
export type ConnectionMode = 'shared' | 'exclusive';
/** What an SSH session is open for. */
export type SessionUse = 'channel' | 'terminal' | 'command';

/**
 * Sessions Lectern opens at once per host, and how many of them may be command
 * channels. Each sshd connection allows MaxSessions sessions (default 10).
 * - shared: the user's terminals and VS Code Remote use the same connection,
 *   so Lectern keeps to 4 of the 10 and leaves 6 to them.
 * - exclusive: the connection is Lectern's own; 8 leaves room for the sessions
 *   sshd still counts while a cancelled command winds down.
 * Channels never take every place: terminal takeovers and one-off sessions
 * (cancellable scans, downloads, commands while every channel is busy) cannot
 * run on a channel. With 2 of 4 (shared) or 3 of 8 (exclusive), at least half
 * the places stay for them; a channel also opens only when a place stays free
 * afterwards, and an idle one is closed when something waits for a place.
 */
export const defaultSessionLimits: Record<ConnectionMode, { sessions: number; channels: number }> = {
  shared: { sessions: 4, channels: 2 },
  exclusive: { sessions: 8, channels: 3 },
};

/** A place held on the host; `release` frees it once (later calls do nothing). */
export interface SessionPlace { readonly use: SessionUse; release(): void; yielding?: boolean }
export type SessionGrant<C> = { place: SessionPlace; channel?: undefined } | { channel: C; place?: undefined };

interface Waiter<C> {
  use: SessionUse;
  /** The request can run on a command channel instead of its own session. */
  channelOk: boolean;
  since: number;
  grant(grant: SessionGrant<C>): void;
}

export interface HostSessionHooks<C> {
  /** An idle channel, claimed for the caller (nobody else may take it meanwhile). */
  takeIdleChannel(): C | undefined;
  /** Close one idle channel to free its place; returns that place, or undefined when none is idle. */
  closeIdleChannel(): SessionPlace | undefined;
}

/**
 * The SSH sessions Lectern has open on one host and the requests waiting for one.
 * Every session counts until its client has exited (see hang-up.ts), so the count
 * follows what sshd sees, not what Lectern has stopped waiting for.
 * Waiting requests are served in order; one that can run on a command channel
 * takes the first channel that becomes idle instead of waiting for a place, and
 * when every place is taken an idle channel is closed to make room.
 */
export class HostSessions<C> {
  mode: ConnectionMode = 'shared';
  limit: number;
  channelLimit: number;
  readonly active: Record<SessionUse, number> = { channel: 0, terminal: 0, command: 0 };
  private yielding = 0;
  private readonly waiting: Waiter<C>[] = [];

  constructor(private readonly where: { host?: string; port?: number }, private readonly hooks: HostSessionHooks<C>,
    private readonly limits = defaultSessionLimits) {
    this.limit = limits.shared.sessions;
    this.channelLimit = limits.shared.channels;
  }

  get used(): number { return this.active.channel + this.active.terminal + this.active.command; }
  get queued(): number { return this.waiting.length; }

  /** The connection the next session uses; its limits apply from now on. */
  setMode(mode: ConnectionMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.limit = this.limits[mode].sessions;
    this.channelLimit = this.limits[mode].channels;
    this.pump();
  }

  /** A place right now, only when nobody waits and `spare` places stay free afterwards. */
  tryReserve(use: SessionUse, spare = 0): SessionPlace | undefined {
    if (this.waiting.length || this.used + 1 + spare > this.limit) return undefined;
    return this.take(use);
  }

  /**
   * A place, or for a request that can run on a channel (`channelOk`), an idle
   * channel if one turns up first. Rejects when `signal` aborts while waiting.
   */
  acquire(use: SessionUse, options: { channelOk?: boolean; signal?: AbortSignal } = {}): Promise<SessionGrant<C>> {
    const { signal } = options;
    signal?.throwIfAborted();
    if (!this.waiting.length && this.used < this.limit) return Promise.resolve({ place: this.take(use) });
    return new Promise<SessionGrant<C>>((resolve, reject) => {
      const waiter: Waiter<C> = {
        use, channelOk: !!options.channelOk, since: performance.now(),
        grant: grant => { signal?.removeEventListener('abort', abort); this.log(waiter, grant.channel ? 'channel' : 'place'); resolve(grant); },
      };
      const abort = () => {
        const at = this.waiting.indexOf(waiter);
        if (at < 0) return;
        this.waiting.splice(at, 1);
        this.log(waiter, 'aborted');
        reject(signal!.reason ?? new Error('Aborted'));
        // Leaving the line may let the next one through (a channel it could not use).
        this.pump();
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  }

  /** Serve the line: a channel became idle, a place was freed, or a limit changed. */
  pump(): void {
    while (this.waiting.length) {
      const index = this.waiting.findIndex(waiter => waiter.channelOk);
      const channel = index >= 0 ? this.hooks.takeIdleChannel() : undefined;
      if (channel) { this.waiting.splice(index, 1)[0].grant({ channel }); continue; }
      if (this.used < this.limit) {
        const waiter = this.waiting.shift()!;
        waiter.grant({ place: this.take(waiter.use) });
        continue;
      }
      // Full: an idle channel gives its place up (it reopens once places are free).
      if (this.waiting.length > this.yielding) {
        const place = this.hooks.closeIdleChannel();
        if (place && !place.yielding) {
          place.yielding = true;
          this.yielding++;
          diagnostic.event('transport.session.channel_yielded', { ...this.where, mode: this.mode, limit: this.limit, ...this.active, waiting: this.waiting.length });
          continue;
        }
      }
      return;
    }
  }

  /** Wake every waiter with a place regardless of the limit (shutting down). */
  drain(): void {
    for (const waiter of this.waiting.splice(0)) waiter.grant({ place: this.take(waiter.use) });
  }

  private take(use: SessionUse): SessionPlace {
    this.active[use]++;
    let released = false;
    const place: SessionPlace = {
      use,
      release: () => {
        if (released) return;
        released = true;
        this.active[use]--;
        if (place.yielding) this.yielding--;
        this.pump();
      },
    };
    return place;
  }

  /** One record per wait longer than a second: what held the places, and for how long. */
  private log(waiter: Waiter<C>, outcome: 'place' | 'channel' | 'aborted'): void {
    const waitedMs = Math.round(performance.now() - waiter.since);
    if (waitedMs < 1000) return;
    diagnostic.event('transport.session.queued', {
      ...this.where, mode: this.mode, limit: this.limit, use: waiter.use, outcome, waitedMs,
      channels: this.active.channel, terminals: this.active.terminal, commands: this.active.command, waiting: this.waiting.length,
    }, waitedMs >= 10_000 ? 'warn' : 'info');
  }
}
