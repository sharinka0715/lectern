import { app, BrowserWindow } from 'electron';

/**
 * Automated runs (Playwright drives the app over the DevTools protocol) must not take
 * the screen, keyboard or mouse from the person at the machine. Input arrives through
 * the protocol, so the windows can be invisible, click-through and never activated.
 * LECTERN_SHOW_TEST_WINDOWS=1 shows them again for debugging a test.
 */
export function silentWindowsRequested(): boolean {
  if (process.env.LECTERN_SHOW_TEST_WINDOWS === '1') return false;
  if (process.env.LECTERN_SILENT_WINDOWS === '1') return true;
  return app.commandLine.hasSwitch('remote-debugging-port');
}

/** Window focus is kept inside the app: focus() and blur() change it and emit the
 * usual events, isFocused() reports it, and the OS focus is never touched. */
export function installSilentWindows(): void {
  // An occluded or transparent window must still count as visible to the page.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  let focused: BrowserWindow | null = null;
  const release = (win: BrowserWindow) => { if (focused === win) focused = null; };
  const quiet = (win: BrowserWindow) => {
    if (win.isDestroyed()) return;
    // On Linux (X11, also under Xvfb) Chromium stops producing frames for a fully
    // transparent window: animation frames and scroll events stall, and pages
    // behave as if never painted. One percent is still invisible on a desktop.
    win.setOpacity(process.platform === 'linux' ? 0.01 : 0);
    win.setIgnoreMouseEvents(true);
  };
  const proto = BrowserWindow.prototype;
  proto.show = function (this: BrowserWindow) { quiet(this); this.showInactive(); };
  proto.focus = function (this: BrowserWindow) {
    if (this.isDestroyed()) return;
    if (!this.isVisible()) this.show();
    if (focused === this) return;
    const previous = focused;
    focused = this;
    if (previous && !previous.isDestroyed()) previous.emit('blur');
    this.emit('focus');
  };
  proto.blur = function (this: BrowserWindow) {
    if (focused !== this) return;
    focused = null;
    this.emit('blur');
  };
  proto.isFocused = function (this: BrowserWindow) {
    return focused === this && !this.isDestroyed() && this.isVisible() && !this.isMinimized();
  };
  BrowserWindow.getFocusedWindow = () => focused && !focused.isDestroyed() ? focused : null;
  app.on('browser-window-created', (_event, win) => {
    quiet(win);
    win.on('hide', () => release(win)).on('minimize', () => release(win)).on('closed', () => release(win));
  });
  // No Dock icon and no menu bar: the app never becomes the active one.
  void app.whenReady().then(() => { if (process.platform === 'darwin') app.setActivationPolicy('accessory'); });
}
