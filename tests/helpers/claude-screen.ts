// Synthetic Claude Code rows with the look the preview reads (src/core/reply-rows.ts): only rows
// whose colours confirm Claude's reply count, so a plain "⏺ text" confirms nothing. Colours as
// Claude Code 2.1.300–2.1.331 writes them at 16 colours (tests/fixtures/preview-<version>/).

/** A reply's bullet: the theme's text colour (bright white in the dark theme). */
export const REPLY = '\x1b[97m⏺\x1b[39m';
/** A tool call still running: dim (its blinking frame is a dim blank, CALL_BLINK). */
export const CALL = '\x1b[2m\x1b[37m⏺\x1b[0m';
export const CALL_BLINK = '\x1b[2m\x1b[37m \x1b[0m';
/** A finished tool call or a notification: green. */
export const DONE = '\x1b[32m⏺\x1b[39m';

/** A reply block: the bullet, then the text with its further rows two columns in. */
export const said = (text: string) => `${REPLY} ${text.replace(/\n/g, '\n  ')}`;

/** Paint a plain capture's bullets (one taken without -e): the replies named by `reply` (from
 * their first row) get the reply's look, every other bullet a finished call's. */
export const paintBullets = (screen: string, reply: (text: string) => boolean) =>
  screen.replace(/^[●⏺] (.*)$/gmu, (row, text: string) => `${reply(text) ? REPLY : DONE} ${text}`);
