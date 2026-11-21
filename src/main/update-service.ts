// Checks GitHub for a newer release and, only when the user asks, downloads the
// installer for this machine, verifies it against the release's SHA256SUMS and
// leaves it in the Downloads folder. Nothing is installed automatically.
// Electron-free: index.ts supplies fetch, folders and shell actions, so
// tests/update-service.test.ts runs it against a fake GitHub in plain Node.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  availableName, isNewerVersion, parseChecksums, releaseFromGitHub, selectAsset,
  type ReleaseAsset, type ReleaseInfo, type UpdateErrorCode, type UpdateState, type UpdateStatus,
} from '../shared/update-check';

export interface UpdateServiceOptions {
  currentVersion: string;
  /** "owner/repo"; undefined while the repository is a placeholder (checks stay off). */
  repository?: string;
  /** GitHub's REST API, or a loopback fake in tests (LECTERN_UPDATE_API). */
  apiBase: string;
  fetch: typeof fetch;
  settingsFile: string;
  downloadsDirectory(): string;
  platform: string;
  arch: string;
  linuxFormat?: 'appimage' | 'deb';
  locale: string;
  publish(state: UpdateState): void;
  reveal(file: string): void;
  open(file: string): Promise<string>;
  openExternal(url: string): void;
  /** Accept http:// URLs (loopback test servers only). */
  allowInsecure?: boolean;
  now?(): number;
}

interface StoredSettings { autoCheck: boolean; skippedVersion?: string; lastCheckedAt?: number }

export const defaultCheckDelayMs = 20_000;
export const defaultCheckIntervalMs = 4 * 60 * 60 * 1000;
const userAgent = 'Lectern-Update-Check';

class UpdateError extends Error {
  constructor(readonly code: UpdateErrorCode, detail?: string) { super(detail ?? code); }
}

export class UpdateService {
  private settings: StoredSettings = { autoCheck: true };
  private status: UpdateStatus = { kind: 'idle' };
  private timers: NodeJS.Timeout[] = [];
  private download$?: AbortController;
  private settingsWrite: Promise<void> = Promise.resolve();
  private lastProgress = 0;

  constructor(private readonly options: UpdateServiceOptions) {}

  get configured() { return !!this.options.repository; }

  state(): UpdateState {
    return {
      status: this.status, currentVersion: this.options.currentVersion, configured: this.configured,
      repository: this.options.repository, autoCheck: this.settings.autoCheck,
      skippedVersion: this.settings.skippedVersion, lastCheckedAt: this.settings.lastCheckedAt, locale: this.options.locale,
      platform: `${this.options.platform}-${this.options.arch}`,
    };
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.options.settingsFile, 'utf8'));
      this.settings = {
        autoCheck: stored?.autoCheck !== false,
        skippedVersion: typeof stored?.skippedVersion === 'string' ? stored.skippedVersion : undefined,
        lastCheckedAt: typeof stored?.lastCheckedAt === 'number' ? stored.lastCheckedAt : undefined,
      };
    } catch { /* first start or unreadable: defaults */ }
  }

  /** Automatic checks: one shortly after startup, then on an interval. */
  start(delayMs = defaultCheckDelayMs, intervalMs = defaultCheckIntervalMs) {
    this.stop();
    if (!this.configured) return;
    this.timers.push(setTimeout(() => void this.automaticCheck(), delayMs));
    this.timers.push(setInterval(() => void this.automaticCheck(), intervalMs));
    for (const timer of this.timers) timer.unref?.();
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.download$?.abort();
  }

  setAutoCheck(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid update preference');
    this.settings.autoCheck = enabled;
    this.changed();
    return this.save();
  }

  private async automaticCheck() {
    // Never replace a prompt, a download or its result with a background check.
    if (!this.settings.autoCheck || !['idle', 'up-to-date', 'error'].includes(this.status.kind)) return;
    await this.check(false);
  }

  /** Ask GitHub for the latest release. A manual check also shows a skipped version. */
  async check(manual = true): Promise<UpdateState> {
    if (!this.configured) {
      if (manual) this.set({ kind: 'error', manual, code: 'not-configured' });
      return this.state();
    }
    if (this.status.kind === 'downloading' || this.status.kind === 'checking') return this.state();
    this.set({ kind: 'checking', manual });
    try {
      const release = await this.latestRelease();
      this.settings.lastCheckedAt = this.now();
      void this.save();
      const current = this.options.currentVersion;
      if (!release || !isNewerVersion(release.version, current)) {
        this.set({ kind: 'up-to-date', manual, checkedAt: this.settings.lastCheckedAt });
      } else if (!manual && release.version === this.settings.skippedVersion) {
        this.set({ kind: 'idle' });
      } else {
        this.set({ kind: 'available', manual, release, asset: this.assetFor(release) });
      }
    } catch (error) {
      const failure = error instanceof UpdateError ? error : new UpdateError('network', message(error));
      this.set({ kind: 'error', manual, code: failure.code, detail: failure.message });
    }
    return this.state();
  }

  /** "Later" hides the prompt until the next check; "skip" also mutes this version for automatic checks. */
  dismiss(mode: 'later' | 'skip') {
    if (mode !== 'later' && mode !== 'skip') throw new Error('Invalid update action');
    const release = 'release' in this.status ? this.status.release : undefined;
    if (this.status.kind === 'downloading') return this.state();
    if (mode === 'skip' && release) { this.settings.skippedVersion = release.version; void this.save(); }
    this.set({ kind: 'idle' });
    return this.state();
  }

  private async latestRelease(): Promise<ReleaseInfo | undefined> {
    const url = `${this.options.apiBase.replace(/\/+$/, '')}/repos/${this.options.repository}/releases/latest`;
    const response = await this.request(url, 'application/vnd.github+json');
    // No published release yet.
    if (response.status === 404) return undefined;
    if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new UpdateError('rate-limited');
    }
    if (!response.ok) throw new UpdateError('network', `HTTP ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new UpdateError('bad-response'); }
    const release = releaseFromGitHub(body);
    if (!release) throw new UpdateError('bad-response');
    return release;
  }

  private assetFor(release: ReleaseInfo) {
    return selectAsset(release.assets, this.options.platform, this.options.arch, this.options.linuxFormat);
  }

  private async request(url: string, accept: string, signal?: AbortSignal) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new UpdateError('bad-response', url); }
    if (parsed.protocol !== 'https:' && !(this.options.allowInsecure && parsed.protocol === 'http:')) {
      throw new UpdateError('bad-response', `refusing ${parsed.protocol} URL`);
    }
    try {
      return await this.options.fetch(url, { headers: { Accept: accept, 'User-Agent': userAgent }, redirect: 'follow', signal, cache: 'no-store' });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new UpdateError('network', message(error));
    }
  }

  cancelDownload() {
    this.download$?.abort();
    return this.state();
  }

  /** Download the installer for this machine, verify it, keep it in Downloads and show it. */
  async download(): Promise<UpdateState> {
    const from = this.status;
    const release = from.kind === 'available' || from.kind === 'error' ? from.release : undefined;
    if (!release || this.download$) return this.state();
    const asset = this.assetFor(release);
    if (!asset) return this.fail('no-asset', release);
    const sums = release.assets.find(item => /^sha256sums(?:\.txt)?$/i.test(item.name));
    if (!sums) return this.fail('no-checksums', release);
    const abort = this.download$ = new AbortController();
    let temp: string | undefined;
    this.set({ kind: 'downloading', release, asset, received: 0, total: asset.size });
    try {
      const listing = await this.request(sums.url, 'application/octet-stream', abort.signal);
      if (!listing.ok) throw new UpdateError('download-failed', `SHA256SUMS: HTTP ${listing.status}`);
      const expected = parseChecksums((await listing.text()).slice(0, 1_000_000)).get(asset.name);
      if (!expected) throw new UpdateError('no-checksums');
      const directory = this.options.downloadsDirectory();
      try { await mkdir(directory, { recursive: true }); }
      catch (error) { throw new UpdateError('save-failed', message(error)); }
      temp = path.join(directory, `.${asset.name}.${randomUUID().slice(0, 8)}.part`);
      const digest = await this.fetchTo(asset, temp, release, abort.signal);
      if (digest !== expected) throw new UpdateError('checksum-mismatch');
      const file = path.join(directory, availableName(asset.name, name => existsSync(path.join(directory, name))));
      try { await rename(temp, file); } catch (error) { throw new UpdateError('save-failed', message(error)); }
      temp = undefined;
      this.set({ kind: 'downloaded', release, asset, file });
      this.options.reveal(file);
    } catch (error) {
      if (abort.signal.aborted) this.set({ kind: 'available', manual: true, release, asset });
      else {
        const failure = error instanceof UpdateError ? error : new UpdateError('download-failed', message(error));
        this.set({ kind: 'error', manual: true, code: failure.code, detail: failure.message, release });
      }
    } finally {
      this.download$ = undefined;
      if (temp) await rm(temp, { force: true }).catch(() => {});
    }
    return this.state();
  }

  private async fetchTo(asset: ReleaseAsset, file: string, release: ReleaseInfo, signal: AbortSignal) {
    const response = await this.request(asset.url, 'application/octet-stream', signal);
    if (!response.ok || !response.body) throw new UpdateError('download-failed', `HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || asset.size;
    const hash = createHash('sha256');
    let handle;
    try { handle = await open(file, 'wx', 0o644); } catch (error) { throw new UpdateError('save-failed', message(error)); }
    let received = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await handle.write(value);
        received += value.byteLength;
        if (this.now() - this.lastProgress > 120) {
          this.lastProgress = this.now();
          this.set({ kind: 'downloading', release, asset, received, total });
        }
      }
    } finally {
      await handle.close();
    }
    this.set({ kind: 'downloading', release, asset, received, total: Math.max(total, received) });
    return hash.digest('hex');
  }

  async openDownloaded() {
    if (this.status.kind !== 'downloaded') throw new Error('No downloaded update');
    const error = await this.options.open(this.status.file);
    if (error) throw new Error(error);
  }

  revealDownloaded() {
    if (this.status.kind !== 'downloaded') throw new Error('No downloaded update');
    this.options.reveal(this.status.file);
  }

  openReleasePage() {
    const release = 'release' in this.status ? this.status.release : undefined;
    const page = release?.page || (this.options.repository ? `https://github.com/${this.options.repository}/releases/latest` : '');
    if (/^https:\/\//.test(page)) this.options.openExternal(page);
  }

  private fail(code: UpdateErrorCode, release: ReleaseInfo) {
    this.set({ kind: 'error', manual: true, code, release });
    return this.state();
  }

  private set(status: UpdateStatus) {
    this.status = status;
    this.changed();
  }

  private changed() { this.options.publish(this.state()); }

  private now() { return this.options.now?.() ?? Date.now(); }

  private save() {
    const content = JSON.stringify(this.settings, null, 2);
    const file = this.options.settingsFile;
    this.settingsWrite = this.settingsWrite.catch(() => {}).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file + '.tmp', content, { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    return this.settingsWrite;
  }

  /** Resolves when pending preference writes are on disk (shutdown, tests). */
  flush() { return this.settingsWrite.catch(() => {}); }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
