// node scripts/cc-matrix/versions.mjs [--from 2.1.300] [--json]
// Which Claude Code versions the compatibility matrix runs, computed from the npm
// registry at run time so a scheduled CI run picks up new releases by itself:
// every published version from `--from` up, one per block of ten patch versions
// (the first published version at or after each multiple of ten), plus the
// `latest` and `stable` dist-tags. CC_MATRIX_VERSIONS or --versions overrides the
// list (comma-separated; `latest`, `stable` and `next` resolve through dist-tags).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
export const PACKAGE = '@anthropic-ai/claude-code';
export const DEFAULT_FROM = '2.1.300';

const parse = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
};
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Pure selection over registry data: stable releases only (no pre-release tags). */
export function selectVersions(published, distTags, { from = DEFAULT_FROM, step = 10 } = {}) {
  const releases = published.filter(version => parse(version) && compareVersions(version, from) >= 0).sort(compareVersions);
  const picked = new Set();
  const blocks = new Map();
  for (const version of releases) {
    const [major, minor, patch] = parse(version);
    const block = `${major}.${minor}.${Math.floor(patch / step)}`;
    if (!blocks.has(block)) { blocks.set(block, version); picked.add(version); }
  }
  for (const tag of ['latest', 'stable']) {
    const version = distTags[tag];
    if (version && parse(version) && published.includes(version)) picked.add(version);
  }
  return [...picked].sort(compareVersions);
}

/** Published versions and dist-tags through npm itself, so the user's registry
 * configuration (mirrors, proxies) applies. */
export async function registryInfo() {
  const { stdout } = await run('npm', ['view', PACKAGE, 'versions', 'dist-tags', '--json'], { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  const info = JSON.parse(stdout);
  return { versions: info.versions ?? [], distTags: info['dist-tags'] ?? {} };
}

/** An explicit list (CLI or CC_MATRIX_VERSIONS) or the computed matrix. */
export async function resolveVersions({ list = process.env.CC_MATRIX_VERSIONS, from = process.env.CC_MATRIX_FROM || DEFAULT_FROM } = {}) {
  const requested = (list ?? '').split(/[\s,]+/).filter(Boolean);
  const info = await registryInfo();
  if (!requested.length) return { versions: selectVersions(info.versions, info.distTags, { from }), distTags: info.distTags, explicit: false };
  const versions = requested.map(entry => {
    const version = info.distTags[entry] ?? entry;
    if (!info.versions.includes(version)) throw new Error(`Claude Code ${entry} is not published on the configured registry`);
    return version;
  });
  return { versions: [...new Set(versions)].sort(compareVersions), distTags: info.distTags, explicit: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const result = await resolveVersions({ list: option('--versions') ?? process.env.CC_MATRIX_VERSIONS, from: option('--from') ?? process.env.CC_MATRIX_FROM ?? DEFAULT_FROM });
  // --json prints a JSON array, e.g. for a GitHub Actions matrix.
  if (args.includes('--json')) console.log(JSON.stringify(result.versions));
  else console.log(`${result.versions.join(' ')}\n(latest ${result.distTags.latest}, stable ${result.distTags.stable})`);
}
