import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocale } from './i18n';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent, Root } from 'hast';
import { Check, Copy, Image as ImageIcon } from 'lucide-react';
import { reportActionError } from './diagnostics';
import { adjacentFileNames, artifactPath, findPathReferences, pathBasename, type PathReference } from './artifact-paths';

import { useArtifactResolution } from './ArtifactReferenceScope';
import { WorkspaceImage } from './ChatImage';
import { t } from '../shared/i18n';

type OpenPath = (path: string) => void;

export function FileLink({ path, onOpen, children, prose = false }: { path: string; onOpen: OpenPath; children: ReactNode; explicit?: boolean; prose?: boolean }) {
  const { ref, match } = useArtifactResolution(path);
  // Links need a verified target, inside the folder or outside it. 'outside' is an explicit
  // path in a macOS privacy folder: not checked in the background, opened on request.
  if (match === 'missing' && prose && typeof children === 'string') {
    return split<ReactNode>(children, adjacentFileNames(children), value => value, (r, value) =>
      <FileLink key={r.start} path={r.path} onOpen={onOpen}>{value}</FileLink>);
  }
  const target = match === 'outside' ? ref : match && typeof match === 'object' ? match.path : undefined;
  if (!target) return <>{children}</>;
  return <button type="button" className="artifact-link" title={t('files.open', { name: target })} data-file-path={target}
    onClick={() => onOpen(target)}>{children}</button>;
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
          (ref, value) => ({ type: 'element', tagName: 'a', properties: { dataArtifactPath: ref.path }, children: [{ type: 'text', value }] }));
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

const markdownPlugins = [remarkGfm];
const filePlugins = [linkFileText];

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
        const link = typeof path === 'string' && path ? <FileLink path={path} onOpen={onOpen} prose={!!node?.properties.dataArtifactPath}>{children}</FileLink>
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
    const path = artifactPath(match[1] ?? match[2], true);
    if (path) refs.push({ start: match.index, end, path });
  }
  plain(text.length);
  return split<ReactNode>(text, refs, value => value, (ref, value) => value.startsWith('![')
    ? <WorkspaceImage key={ref.start} path={ref.path} name={value.slice(2, value.indexOf(']')) || pathBasename(ref.path)} fallback={value} onOpen={onOpen} />
    : <FileLink key={ref.start} path={ref.path} onOpen={onOpen} prose={value === ref.path}>{value}</FileLink>);
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
    <Fragment key={ref.start}><FileLink path={ref.path} onOpen={onOpen} prose={!input && value === ref.path}>{value}</FileLink></Fragment>)}</pre>;
}
