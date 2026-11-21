import { memo, useEffect, useState, type CSSProperties } from 'react';
import type { Segment } from './syntax-highlight';

const byExtension: Record<string, string> = {
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cu: 'cpp', cuh: 'cpp', cs: 'csharp',
  css: 'css', less: 'less', scss: 'scss', go: 'go', java: 'java', kt: 'kotlin', scala: 'scala', gradle: 'gradle',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', jsonl: 'json', ipynb: 'json', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  lua: 'lua', m: 'objectivec', php: 'php', pl: 'perl', ps1: 'powershell', py: 'python', rb: 'ruby', rs: 'rust',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', swift: 'swift', toml: 'ini', ini: 'ini', conf: 'ini',
  yaml: 'yaml', yml: 'yaml', diff: 'diff', patch: 'diff', proto: 'protobuf', r: 'r', tex: 'latex',
  graphql: 'graphql', cmake: 'cmake', dart: 'dart', ex: 'elixir', exs: 'elixir', hs: 'haskell', jl: 'julia', nim: 'nim',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown',
};
const byName: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake' };

export function codeLanguage(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (byName[lower]) return byName[lower];
  const dot = lower.lastIndexOf('.');
  return dot > 0 || (dot === 0 && lower.length > 1) ? byExtension[lower.slice(dot + 1)] : undefined;
}

let loader: Promise<typeof import('./syntax-highlight')> | undefined;
const highlighter = () => loader ??= import('./syntax-highlight');

/**
 * Source text with optional highlighting, line numbers and wrapping. The plain lines show at once;
 * highlighted lines replace them when the grammar has loaded. Line numbers are generated
 * content, so selecting and copying returns the file's own text.
 */
export const CodePreview = memo(function CodePreview({ text, name, highlight, lineNumbers, wrap, className = '' }: {
  text: string; name: string; highlight: boolean; lineNumbers: boolean; wrap: boolean; className?: string;
}) {
  const language = highlight ? codeLanguage(name) : undefined;
  const [highlighted, setHighlighted] = useState<{ text: string; language: string; lines: Segment[][] }>();
  useEffect(() => {
    if (!language) return;
    let live = true;
    highlighter().then(module => {
      const lines = module.highlightLines(text, language);
      if (live) setHighlighted({ text, language, lines });
    }).catch(() => { /* Keep the plain text when a grammar cannot load or parse. */ });
    return () => { live = false; };
  }, [text, language]);
  const current = highlighted && highlighted.text === text && highlighted.language === language ? highlighted.lines : undefined;
  const source: (Segment[] | string)[] = current ?? text.split('\n');
  // A final newline ends the last line rather than starting an empty one.
  const last = source.at(-1);
  const lines = source.length > 1 && (typeof last === 'string' ? !last : !last?.length) ? source.slice(0, -1) : source;
  return <pre className={`code-preview ${className}`.trim()} data-wrap={wrap} data-line-numbers={lineNumbers}
    data-language={language} data-highlighted={!!current || undefined}
    style={{ '--line-digits': String(Math.max(2, String(lines.length).length)) } as CSSProperties}>
    <code>{lines.map((line, index) => <span className="code-line" key={index}><span className="code-text">
      {typeof line === 'string' ? line : line.map((segment, at) => segment.className
        ? <span key={at} className={segment.className}>{segment.text}</span> : segment.text)}
      {'\n'}
    </span></span>)}</code>
  </pre>;
});
