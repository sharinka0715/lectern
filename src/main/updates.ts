// Electron wiring for the update check (logic in update-service.ts). The GitHub
// repository is package.json's `repository` (sharinka0715/lectern), so releases
// come from https://github.com/sharinka0715/lectern/releases. Test overrides:
// LECTERN_UPDATE_REPOSITORY (an OWNER/… placeholder there turns checks off),
// LECTERN_UPDATE_API (loopback fake GitHub), LECTERN_UPDATE_DELAY_MS,
// LECTERN_DOWNLOADS_DIR and LECTERN_UPDATE_NO_REVEAL=1.
import { app, session, shell, type BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { githubRepository } from '../shared/update-check';
import { defaultCheckDelayMs, UpdateService } from './update-service';

const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

export function packageRepository(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    return githubRepository(manifest.repository);
  } catch { return undefined; }
}

export function createUpdates(options: { window(): BrowserWindow | undefined; automated: boolean; demo: boolean }) {
  const apiOverride = process.env.LECTERN_UPDATE_API;
  const insecure = !!apiOverride && loopback.test(apiOverride);
  const updates = new UpdateService({
    currentVersion: app.getVersion(),
    repository: process.env.LECTERN_UPDATE_REPOSITORY !== undefined
      ? githubRepository(process.env.LECTERN_UPDATE_REPOSITORY) : packageRepository(),
    apiBase: apiOverride || 'https://api.github.com',
    allowInsecure: insecure,
    // A separate session: system proxy settings apply, the renderer's request filter does not.
    fetch: (input, init) => session.fromPartition('lectern-updates').fetch(input as string, init as RequestInit),
    settingsFile: path.join(app.getPath('userData'), 'update-settings.json'),
    downloadsDirectory: () => process.env.LECTERN_DOWNLOADS_DIR || app.getPath('downloads'),
    platform: process.platform, arch: process.arch,
    linuxFormat: process.env.APPIMAGE || !app.isPackaged ? 'appimage' : 'deb',
    locale: process.env.LECTERN_LOCALE || 'zh-CN',
    publish: state => options.window()?.webContents.send('lectern:update-state', state),
    reveal: file => { if (process.env.LECTERN_UPDATE_NO_REVEAL !== '1') shell.showItemInFolder(file); },
    open: file => (process.env.LECTERN_UPDATE_NO_REVEAL === '1' ? Promise.resolve('') : shell.openPath(file)),
    openExternal: url => { if (process.env.LECTERN_UPDATE_NO_REVEAL !== '1') void shell.openExternal(url); },
  });
  // Automatic checks run in packaged apps; development and automated test runs
  // (Playwright) stay offline unless a test points the check at a fake server.
  const automatic = !options.demo && (apiOverride ? true : app.isPackaged && !options.automated);
  const delay = Number(process.env.LECTERN_UPDATE_DELAY_MS) || defaultCheckDelayMs;
  const ready = updates.load().then(() => { if (automatic) updates.start(delay); });
  const methods: Record<string, (...args: any[]) => unknown> = {
    updateState: async () => { await ready; return updates.state(); },
    checkForUpdates: async () => { await ready; return updates.check(true); },
    downloadUpdate: () => updates.download(),
    cancelUpdateDownload: () => updates.cancelDownload(),
    dismissUpdate: mode => updates.dismiss(mode),
    setUpdatePreferences: async preferences => { await ready; await updates.setAutoCheck(preferences?.autoCheck); return updates.state(); },
    openDownloadedUpdate: () => updates.openDownloaded(),
    revealDownloadedUpdate: () => updates.revealDownloaded(),
    openUpdatePage: () => updates.openReleasePage(),
  };
  return { updates, methods, stop: () => { updates.stop(); return updates.flush(); } };
}
