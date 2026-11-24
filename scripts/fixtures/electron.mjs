// Desktop e2e scripts launch Lectern through this module instead of Playwright's own
// `_electron`, so every window they get takes screenshots the same guarded way.
//
// Chromium answers Page.captureScreenshot with "Unable to capture screenshot" when copying
// the page's compositor surface comes back empty six times in a row; it retries at once,
// without waiting for another frame. On the Linux CI runner this happened to the first
// screenshot of the first Electron launch of a run (scripts/e2e.mjs, about a second after
// launch), in most runs, and a screenshot taken a moment later in the same app succeeded:
// the GPU process went away for Chromium's software fallback while the capture was pending.
// Test runs no longer start that process (src/main/silent-windows.ts); as a last resort a
// screenshot that still meets exactly that error waits for the page to draw two frames (at
// most 2 s) plus a short pause and tries again, at most RETRIES times. Each retry is
// reported on stderr together with the app's own recent stderr (Chromium's GPU and
// compositor errors land there), so a run that needed it says why. A screenshot that
// works the first time is taken exactly as before.
import { _electron as playwrightElectron } from 'playwright';

export const RETRIES = 3;
const NO_FRAME = /Unable to capture screenshot/;
const guarded = new WeakSet();
/** Page → the last lines its app wrote to stderr, with milliseconds since launch. */
const appLogs = new WeakMap();

/** Resolves after the page has drawn two more frames, or after `ms` if it does not. */
function nextFrames(page, ms = 2000) {
  const frames = page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  let timer;
  return Promise.race([frames.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, ms); })])
    .finally(() => clearTimeout(timer));
}

/** Wraps `screenshot` on a Page or Locator prototype; `pageOf` finds the page to wait on. */
function guard(prototype, pageOf) {
  if (guarded.has(prototype)) return;
  guarded.add(prototype);
  const screenshot = prototype.screenshot;
  prototype.screenshot = async function (...args) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await screenshot.apply(this, args);
      } catch (error) {
        if (attempt > RETRIES || !NO_FRAME.test(String(error?.message))) throw error;
        const page = pageOf(this);
        const log = appLogs.get(page);
        console.error(`[screenshot] ${String(error.message).split('\n')[0]}; retry ${attempt}/${RETRIES} after the next frames`
          + (log ? ` (${Date.now() - log.started} ms after launch)` : '')
          + (log && attempt === 1 ? `; the app's recent stderr:\n${log.lines.join('\n') || '  (nothing)'}` : ''));
        await nextFrames(page);
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      }
    }
  };
}

/** Guards screenshots of this window and, through the shared prototypes, of every other. */
export function guardScreenshots(page) {
  guard(Object.getPrototypeOf(page), p => p);
  guard(Object.getPrototypeOf(page.locator('html')), locator => locator.page());
  return page;
}

/** Playwright's `_electron`, with screenshots guarded in every window of the launched app. */
export const _electron = {
  async launch(options) {
    const started = Date.now();
    const app = await playwrightElectron.launch(options);
    const log = { started, lines: [] };
    app.process().stderr?.on('data', chunk => {
      for (const line of String(chunk).split('\n')) if (line.trim()) log.lines.push(`  +${Date.now() - started}ms ${line.slice(0, 300)}`);
      log.lines.splice(0, log.lines.length - 30);
    });
    const watch = page => { appLogs.set(page, log); guardScreenshots(page); };
    for (const page of app.windows()) watch(page);
    app.on('window', watch);
    return app;
  },
};
