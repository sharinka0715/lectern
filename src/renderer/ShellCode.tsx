import { Fragment, useMemo, type ReactNode } from "react";
import { findPathReferences } from "./artifact-paths";
import { FileLink } from "./ArtifactLinks";
import { shellTokens } from "./shell-tokens";

/**
 * A shell command with its parts coloured (command, flags, variables, strings,
 * operators). With `onOpen`, file paths in it stay links, as in other tool text.
 */
export function ShellCode({ text, onOpen, className }: { text: string; onOpen?: (path: string) => void; className?: string }) {
  const nodes = useMemo(() => {
    const refs = onOpen ? findPathReferences(text) : [];
    // Cut tokens at link edges so a link may span several coloured pieces.
    const cuts = refs.flatMap(ref => [ref.start, ref.end]);
    const pieces: { start: number; text: string; kind?: string }[] = [];
    let position = 0;
    for (const token of shellTokens(text)) {
      let start = position;
      const end = position + token.text.length;
      for (const cut of cuts) if (cut > start && cut < end) { pieces.push({ start, text: text.slice(start, cut), kind: token.kind }); start = cut; }
      pieces.push({ start, text: text.slice(start, end), kind: token.kind });
      position = end;
    }
    const piece = (p: (typeof pieces)[number]) => p.kind
      ? <span key={p.start} className={`sh-${p.kind}`}>{p.text}</span> : <Fragment key={p.start}>{p.text}</Fragment>;
    const out: ReactNode[] = [];
    let index = 0;
    for (const ref of refs) {
      while (index < pieces.length && pieces[index].start < ref.start) out.push(piece(pieces[index++]));
      const inside: ReactNode[] = [];
      while (index < pieces.length && pieces[index].start < ref.end) inside.push(piece(pieces[index++]));
      out.push(<FileLink key={`link-${ref.start}`} path={ref.path} onOpen={onOpen!}>{inside}</FileLink>);
    }
    while (index < pieces.length) out.push(piece(pieces[index++]));
    return out;
  }, [text, onOpen]);
  return <pre className={`shell-code${className ? ` ${className}` : ""}`}>{nodes}</pre>;
}
