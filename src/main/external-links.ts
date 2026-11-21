// Web links in messages open in the system browser. The app window itself never
// opens another window and never navigates away from the app.
import type { WebContents } from 'electron';

/** The URL to give the system browser: plain http(s) links only, anything else is dropped. */
export function externalLinkUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
}

const origin = (raw: string) => { try { return new URL(raw).origin; } catch { return undefined; } };

type LinkContents = Pick<WebContents, 'setWindowOpenHandler' | 'getURL'> & {
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
};

/**
 * `<a target="_blank">` and plain link clicks both end up in `open` with the
 * link's URL; the window stays where it is. A navigation inside the app's own
 * origin (the dev server's page) is blocked without opening a browser.
 */
export function routeExternalLinks(contents: LinkContents, open: (url: string) => void): void {
  contents.setWindowOpenHandler(({ url }) => {
    const target = externalLinkUrl(url);
    if (target) open(target);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    const target = externalLinkUrl(url);
    if (target && origin(target) !== origin(contents.getURL())) open(target);
  });
}
