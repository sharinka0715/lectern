import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocale } from './i18n';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { PluggableList } from 'unified';
import { isKatex, katexOptions } from './markdown-math';
import { replySyntax } from './markdown-syntax';
import type { Element, ElementContent, Root } from 'hast';
import { Check, Copy, Image as ImageIcon } from 'lucide-react';
import { reportActionError } from './diagnostics';
import { adjacentFileNames, artifactPath, citedLines, findPathReferences, pathBasename, type LineRange, type OpenPath, type PathReference } from './artifact-paths';

import { useArtifactResolution } from './ArtifactReferenceScope';
import { WorkspaceImage } from './ChatImage';
import { t } from '../shared/i18n';

export function FileLink({ path, lines, onOpen, children, prose = false, inline = false }: { path: string; lines?: LineRange; onOpen: OpenPath; children: ReactNode; explicit?: boolean; prose?: boolean; inline?: boolean }) {
  const { ref, match } = useArtifactResolution(path);
  const spacePressed = useRef(false);
  // Links need a verified target, inside the folder or outside it. 'outside' is an explicit
  // path in a macOS privacy folder: not checked in the background, opened on request.
  if (match === 'missing' && prose && typeof children === 'string') {
    return split<ReactNode>(children, adjacentFileNames(children), value => value, (r, value) =>
      <FileLink key={r.start} path={r.path} onOpen={onOpen} inline={inline}>{value}</FileLink>);
  }
  const target = match === 'outside' ? ref : match && typeof match === 'object' ? match.path : undefined;
  if (!target) return <>{children}</>;
  const cited = lines && (lines.end > lines.start ? `${lines.start}-${lines.end}` : String(lines.start));
  const props = { className: 'artifact-link', title: t('files.open', { name: cited ? `${target}:${cited}` : target }), 'data-file-path': target,
    'data-file-lines': cited, onClick: () => onOpen(target, lines) };
  // Chromium lays out native buttons as atomic boxes even with display: inline.
  // A non-atomic inline lets code around or inside the link paint on every line.
  if (inline) return <span {...props} role="button" tabIndex={0}
    onKeyDown={event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.currentTarget.click();
      } else if (event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) spacePressed.current = true;
      }
    }}
    onKeyUp={event => {
      if (event.key !== ' ' || !spacePressed.current) return;
      event.preventDefault();
      spacePressed.current = false;
      event.currentTarget.click();
    }}
    onBlur={() => { spacePressed.current = false; }}>{children}</span>;
  return <button type="button" {...props}>{children}</button>;
}

function split<T>(text: string, refs: PathReference[], plain: (value: string) => T, link: (ref: PathReference, value: string) => T): T[] {
  let end = 0;
  const nodes: T[] = [];
  for (const ref of refs) {
    if (end < ref.start) nodes.push(plain(text.slice(end, ref.start)));
    nodes.push(link(ref, text.slice(ref.start, ref.end)));
    end = ref.end;
  }
  if (end < text.length) nodes.push(plain(text.slice(end)));
  return nodes;
}

/** Work on the parsed tree so code blocks, existing links and Markdown punctuation stay intact. */
function linkFileText() {
  return (root: Root) => {
    function walk(parent: Root | Element) {
      // A formula's text is TeX output, not prose that names files.
      if (parent.type === 'element' && isKatex(parent)) return;
      if (parent.type === 'element' && parent.tagName === 'a') {
        for (const child of parent.children) {
          if (child.type === 'element' && child.tagName === 'img') child.properties.dataLinkImage = true;
        }
        return;
      }
      parent.children = parent.children.flatMap((child): typeof parent.children => {
        if (child.type === 'element') walk(child);
        if (child.type !== 'text') return [child];
        return split<ElementContent>(child.value, findPathReferences(child.value, parent.type === 'element' && parent.tagName === 'code'),
          value => ({ type: 'text', value }),
          (ref, value) => ({ type: 'element', tagName: 'a', properties: { dataArtifactPath: ref.path, dataLineStart: ref.lines?.start, dataLineEnd: ref.lines?.end },
            children: [{ type: 'text', value }] }));
      }) as typeof parent.children;
    }
    walk(root);
  };
}

/** A fenced block keeps its own text for copying; file links inside it copy as their visible text. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);
  async function copy() {
    const text = pre.current?.textContent?.replace(/\n$/, '') ?? '';
    try {
      await window.desktop.copyText(text);
      setCopied(true);
    } catch (error) { reportActionError(error, '复制代码失败'); }
  }
  return <div className="code-block">
    <pre ref={pre}>{children}</pre>
    <button type="button" className="code-copy" aria-label={t(copied ? 'files.copiedCode' : 'files.copyCode')} title={t(copied ? 'files.copied' : 'files.copyCode')}
      data-copied={copied || undefined} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
  </div>;
}

// GFM and formulas (`$…$`, `$$…$$`), then the reply's own fix-ups (replySyntax); KaTeX sets formulas before files are linked.
const markdownPlugins: PluggableList = [remarkGfm, remarkMath, replySyntax];
const filePlugins: PluggableList = [[rehypeKatex, katexOptions], linkFileText];

export const ArtifactMarkdown = memo(function ArtifactMarkdown({ text, onOpen, inlineImages = false }: { text: string; onOpen: OpenPath; inlineImages?: boolean }) {
  // Memoized: re-render on a language switch for its image and copy labels.
  const locale = useLocale();
  // 末尾正文持续写入时，已经展示的图片沿用同一组件和同一次读取。
  const components = useMemo<Components>(() => ({
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      img: ({ src, alt, node }) => {
        if (node?.properties.dataLinkImage) return <span><ImageIcon size={13} /> {alt || t('files.image')}</span>;
        const path = typeof src === 'string' && artifactPath(src, true);
        if (path && inlineImages) return <WorkspaceImage path={path} name={alt || pathBasename(path)} onOpen={onOpen} />;
        return path ? <FileLink path={path} onOpen={onOpen}><ImageIcon size={13} />{alt || pathBasename(path)}</FileLink>
          : <span className="image-placeholder">{t('files.imagePlaceholder', { alt: alt || t('files.imageAttachment') })}</span>;
      },
      a: ({ node, href, children }) => {
        const path = node?.properties.dataArtifactPath ?? (href && artifactPath(href, true));
        const start = node?.properties.dataLineStart, end = node?.properties.dataLineEnd;
        const lines = typeof start === 'number' && typeof end === 'number' ? { start, end } : !node?.properties.dataArtifactPath && href ? citedLines(href) : undefined;
        const link = typeof path === 'string' && path ? <FileLink path={path} lines={lines} onOpen={onOpen} prose={!!node?.properties.dataArtifactPath} inline>{children}</FileLink>
          : href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>;
        if (!inlineImages || !node) return link;
        // 图片本身可放大，包裹图片的 Markdown 链接仍使用自己的目的地址。
        const images = node.children.filter((child): child is Element => child.type === 'element' && child.tagName === 'img');
        if (!images.length) return link;
        return <>{images.map((child, index) => {
          const src = typeof child.properties.src === 'string' && artifactPath(child.properties.src, true);
          return src && <WorkspaceImage key={index} path={src} name={String(child.properties.alt || pathBasename(src))} onOpen={onOpen} />;
        })}{link}</>;
      },
    }), [inlineImages, onOpen, locale]);
  return <Markdown remarkPlugins={markdownPlugins} rehypePlugins={filePlugins} components={components}
    urlTransform={url => artifactPath(url, true) ? url : defaultUrlTransform(url)}>{text}</Markdown>;
});

/** The user's prompt stays selectable verbatim, including angle brackets, commands and Markdown syntax.
 * `chips` replace the attachment mentions they cover (positions in `text`). */
export function LinkedUserText({ text, onOpen, chips = [] }: { text: string; onOpen: OpenPath; chips?: { start: number; end: number; node: ReactNode }[] }) {
  if (!chips.length) return linkedPrompt(text, onOpen);
  const nodes: ReactNode[] = [];
  let end = 0;
  for (const chip of chips) {
    if (chip.start < end) continue;
    if (end < chip.start) nodes.push(<Fragment key={`text:${end}`}>{linkedPrompt(text.slice(end, chip.start), onOpen)}</Fragment>);
    nodes.push(<Fragment key={`chip:${chip.start}`}>{chip.node}</Fragment>);
    end = chip.end;
  }
  if (end < text.length) nodes.push(<Fragment key={`text:${end}`}>{linkedPrompt(text.slice(end), onOpen)}</Fragment>);
  return nodes;
}

function linkedPrompt(text: string, onOpen: OpenPath) {
  const refs: PathReference[] = [];
  let end = 0;
  function plain(until: number) {
    for (const ref of findPathReferences(text.slice(end, until))) refs.push({ ...ref, start: end + ref.start, end: end + ref.end });
  }
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^()\s]+))\)/g)) {
    plain(match.index);
    end = match.index + match[0].length;
    const path = artifactPath(match[1] ?? match[2], true), lines = citedLines(match[1] ?? match[2]);
    if (path) refs.push({ start: match.index, end, path, ...lines && { lines } });
  }
  plain(text.length);
  return split<ReactNode>(text, refs, value => value, (ref, value) => value.startsWith('![')
    ? <WorkspaceImage key={ref.start} path={ref.path} name={value.slice(2, value.indexOf(']')) || pathBasename(ref.path)} fallback={value} onOpen={onOpen} />
    : <FileLink key={ref.start} path={ref.path} lines={ref.lines} onOpen={onOpen} prose={value === ref.path}>{value}</FileLink>);
}

export function LinkedToolText({ text, onOpen, input = false }: { text: string; onOpen: OpenPath; input?: boolean }) {
  // Native tool arguments are pretty-printed JSON. Parse the string value once so escaped
  // backslashes, quotes, spaces and extensionless files refer to the original path.
  const fields = /"(?:file_path|filePath|path|dir_path|directory|cwd|notebook_path|filename|output_path)"\s*:\s*("(?:[^"\\]|\\.)*")/g;
  const refs: PathReference[] = [];
  let last = 0;
  function plain(until: number) {
    for (const ref of findPathReferences(text.slice(last, until))) refs.push({ ...ref, start: last + ref.start, end: last + ref.end });
  }
  if (input) for (const m of text.matchAll(fields)) {
    const start = m.index + m[0].length - m[1].length + 1;
    let path: string | undefined;
    try { path = artifactPath(JSON.parse(m[1])); } catch { continue; }
    if (!path) continue;
    plain(m.index);
    last = start + m[1].length - 2;
    refs.push({ start, end: last, path });
    last++;
  }
  plain(text.length);
  return <pre>{split<ReactNode>(text, refs, value => value, (ref, value) =>
    <Fragment key={ref.start}><FileLink path={ref.path} lines={ref.lines} onOpen={onOpen} prose={!input && value === ref.path}>{value}</FileLink></Fragment>)}</pre>;
}
