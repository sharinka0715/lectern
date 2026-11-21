export interface PathReference { start: number; end: number; path: string }

const drive = /^[a-z]:[\\/]/i;
const scheme = /^[a-z][a-z\d+.-]*:/i;
const invalid = /[\u0000-\u001f\u007f]/;
const citation = /(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+)?)$/i;
// Without an explicit path prefix or native @mention, require a filename signal.
// A slash between two ordinary words/numbers and a dotted property are not paths.
const explicitPath = /^(?:\.{1,2}[\\/]|~[\\/]|\/|[a-z]:[\\/])/i;
const fileName = /(?:^|[\\/])(?:README|LICENSE|NOTICE|Makefile|Dockerfile|Gemfile|Rakefile|Procfile|Jenkinsfile|CMakeLists\.txt|\.gitignore)$|\.(?:[cm]?[jt]sx?|css|scss|less|html?|vue|svelte|astro|wasm|c|cc|cpp|cxx|h|hh|hpp|m|mm|cs|fs|go|rs|rb|pyi?|java|kt|kts|swift|scala|php|pl|lua|r|dart|zig|exs?|sh|fish|zsh|bash|ps1|bat|cmd|sql|proto|graphql|md|mdx|markdown|mdown|txt|rst|tex|bib|jsonc?|jsonl|ya?ml|toml|xml|ini|conf|cfg|properties|lock|csv|tsv|log|diff|patch|ipynb|pdf|docx?|xlsx?|pptx?|odt|rtf|svg|png|jpe?g|gif|webp|avif|ico|bmp|mp[34]|m4[av]|wav|flac|ogg|opus|aac|mov|mkv|webm|avi|srt|vtt|ass|heic|tiff?|ttf|otf|woff2?|npy|npz|pt|pth|ckpt|safetensors|onnx|h5|hdf5|parquet|pkl|zip|tar|gz|tgz|bz2|xz|7z|bin)$/i;

/** URL decoding belongs only to Markdown destinations. Literal paths may contain percent signs. */
export function artifactPath(value: string, fromUrl = false): string | undefined {
  if (!value || invalid.test(value) || value.startsWith('#') || value.startsWith('?') || /^[\\/]{2}/.test(value)) return;
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return;
      value = url.pathname.replace(/^\/(?=[A-Za-z]:\/)/, '');
      fromUrl = true;
    } catch { return; }
  }
  if (fromUrl) {
    value = value.split('#', 1)[0].replace(citation, '');
    try { value = decodeURIComponent(value); } catch { return; }
  }
  if (!value || invalid.test(value) || /^[\\/]{2}/.test(value) || scheme.test(value) && !drive.test(value)) return;
  return value;
}

export function pathBasename(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

export function parentPath(path: string): string | undefined {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!clean || clean === '.' || /^[a-z]:$/i.test(clean)) return;
  const i = clean.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  if (/^[a-z]:$/i.test(clean.slice(0, i))) return clean.slice(0, i + 1);
  return clean.slice(0, i);
}

export function relativeToFile(file: string, path: string): string {
  if (/^(?:[~/\\]|[a-z]:[\\/])/i.test(path)) return path;
  const parent = parentPath(file);
  return (parent && parent !== '.' ? parent.replace(/\/$/, '') : '.') + '/' + path;
}

// Chinese prose need not put spaces around filenames. These are fallback spans,
// never substitutes for a real (or ambiguous) mixed-language filename.
export function adjacentFileNames(text: string): PathReference[] {
  if (!/\p{Script=Han}/u.test(text) || /[\\/@:\s]/.test(text)) return [];
  const out: PathReference[] = [];
  for (const m of text.matchAll(/[\w-]+(?:\.[\w-]+)+/g)) {
    if (fileName.test(m[0])) out.push({ start: m.index, end: m.index + m[0].length, path: m[0] });
  }
  return out;
}

// Consume whole tokens (including web URLs) so fragments of a URL never become file buttons.
const tokens = /"((?:\\[^\n]|[^"\n\\])*)"|'([^'\n]*)'|\x60([^\x60\n]*)\x60|[^\s\x60"'<>()[\]{},;，。！？、；：“”‘’《》【】（）]+/gu;
export function findPathReferences(text: string, literal = false): PathReference[] {
  const out: PathReference[] = [];
  function add(start: number, raw: string, quoted: boolean) {
    const clean = raw.replace(/^@/, '').replace(/[.!?:]+$/g, '');
    const path = artifactPath(clean.replace(citation, ''));
    if (!path || path.length > 4096 || (!explicitPath.test(path) && !fileName.test(path) && !raw.startsWith('@') && !adjacentFileNames(path).length) || path === '.' || path === '..' ||
      /[*|<>=]/.test(path) || (!quoted && /\s/.test(path)) || /^[^@\s]+@[^/\s]+\.[a-z]+$/i.test(path) || /^(?:www\.|--?[^/]*=)/i.test(path)) return false;
    const leading = raw.startsWith('@') ? 1 : 0;
    out.push({ start: start + leading, end: start + leading + clean.length, path });
    return true;
  }
  if (literal && (!/\s/.test(text) || /[\\/]/.test(text)) && !/[\n\r=;`'"]/.test(text) && !/^(?:\S+\s+)(?:[-/]|\.\/)/.test(text) &&
    !/^(?:cat|cd|ls|cp|mv|rm|open|node|python\d*|npm|git|bash|sh)\s/.test(text) && add(0, text, true)) return out;
  for (const m of text.matchAll(tokens)) {
    const quoted = m[1] ?? m[2] ?? m[3];
    if (quoted !== undefined) {
      if (!add(m.index + 1, quoted, true) && /\s/.test(quoted)) {
        for (const ref of findPathReferences(quoted)) out.push({ ...ref, start: m.index + 1 + ref.start, end: m.index + 1 + ref.end });
      }
    } else add(m.index, m[0], false);
  }
  return out;
}
