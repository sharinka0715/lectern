/** Plain text with its http(s) addresses as links (Claude Code's dialogs name help pages).
 * The main process opens them in the system browser (main/external-links.ts). */
export type LinkSegment = { text: string; href?: string };

// Up to whitespace or a closing quote or bracket; sentence punctuation at the end stays text.
const address = /https?:\/\/[^\s"'<>()\[\]{}（）「」]+/gu;

export function linkSegments(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(address)) {
    const href = match[0].replace(/[.,;:!?。，；：！？]+$/u, '');
    if (!href.replace(/^https?:\/\//u, '')) continue;
    if (match.index! > at) segments.push({ text: text.slice(at, match.index) });
    segments.push({ text: href, href });
    at = match.index! + href.length;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
}

export function LinkedText({ text }: { text: string }) {
  return <>{linkSegments(text).map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a>
    : <span key={index}>{part.text}</span>)}</>;
}
