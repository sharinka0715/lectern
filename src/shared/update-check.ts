// Pure helpers for the update check: version order, the release's repository,
// which installer fits this machine, and SHA256SUMS parsing. No Electron or
// network here, so tests/update-check.test.ts covers all of it directly.

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  page: string;
  publishedAt?: string;
  assets: ReleaseAsset[];
}

export type UpdateErrorCode =
  | 'network' | 'rate-limited' | 'bad-response' | 'no-asset' | 'no-checksums'
  | 'checksum-mismatch' | 'download-failed' | 'save-failed' | 'not-configured';

/** What the renderer shows. `manual` marks results of a check the user asked for. */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking'; manual: boolean }
  | { kind: 'up-to-date'; manual: boolean; checkedAt: number }
  | { kind: 'available'; manual: boolean; release: ReleaseInfo; asset?: ReleaseAsset }
  | { kind: 'downloading'; release: ReleaseInfo; asset: ReleaseAsset; received: number; total: number }
  | { kind: 'downloaded'; release: ReleaseInfo; asset: ReleaseAsset; file: string }
  | { kind: 'error'; manual: boolean; code: UpdateErrorCode; detail?: string; release?: ReleaseInfo };

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  /** False while package.json still has the placeholder repository: checks are off. */
  configured: boolean;
  repository?: string;
  autoCheck: boolean;
  skippedVersion?: string;
  lastCheckedAt?: number;
  /** "linux-x64" and the like: which installer the check looks for. */
  platform: string;
  /** UI language for the update texts ('zh-CN' or 'en'), from LECTERN_LOCALE. */
  locale: string;
}

const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v1.2.3", "1.2.3-beta.1" → parts, or undefined for anything else. */
export function parseVersion(text: string): { core: [number, number, number]; pre: string[] } | undefined {
  const match = versionPattern.exec(text.trim());
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/** Semantic-version order: negative when a < b. Unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  // A pre-release sorts before the release itself.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export const isNewerVersion = (candidate: string, current: string) =>
  !!parseVersion(candidate) && compareVersions(candidate, current) > 0;

/**
 * "owner/repo" from package.json's `repository` (string or { url }), or undefined
 * when it is missing, not on GitHub, or an OWNER/… placeholder (tests use one to turn checks off).
 */
export function githubRepository(repository: unknown): string | undefined {
  const raw = typeof repository === 'string' ? repository
    : repository && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string'
      ? (repository as { url: string }).url : '';
  const match = /^(?:github:|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(raw.trim());
  if (!match) return undefined;
  const [owner, repo] = [match[1], match[2]];
  if (/^owner$/i.test(owner) || /^repo$/i.test(repo)) return undefined;
  return `${owner}/${repo}`;
}

/** The fields of GitHub's "latest release" response that the check uses. */
export function releaseFromGitHub(body: unknown): ReleaseInfo | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = body as Record<string, unknown>;
  const tag = typeof value.tag_name === 'string' ? value.tag_name : '';
  if (!parseVersion(tag) || value.draft === true) return undefined;
  const assets = Array.isArray(value.assets) ? value.assets.flatMap(item => {
    const asset = item as Record<string, unknown>;
    return typeof asset?.name === 'string' && typeof asset.browser_download_url === 'string'
      ? [{ name: asset.name, url: asset.browser_download_url, size: typeof asset.size === 'number' ? asset.size : 0 }] : [];
  }) : [];
  return {
    version: tag.replace(/^v/, ''), tag,
    name: typeof value.name === 'string' && value.name ? value.name : tag,
    notes: typeof value.body === 'string' ? value.body.slice(0, 20_000) : '',
    page: typeof value.html_url === 'string' ? value.html_url : '',
    publishedAt: typeof value.published_at === 'string' ? value.published_at : undefined,
    assets,
  };
}

const archAliases: Record<string, string[]> = {
  x64: ['x64', 'x86_64', 'amd64'],
  arm64: ['arm64', 'aarch64'],
};
const archOf = (name: string) => {
  const lower = name.toLowerCase();
  for (const [arch, aliases] of Object.entries(archAliases)) {
    if (aliases.some(alias => new RegExp(`(?:^|[-_. ])${alias}(?:[-_. ]|$)`).test(lower))) return arch;
  }
  return undefined;
};

/**
 * The installer for this machine. macOS prefers the DMG (then the ZIP) of the
 * same architecture; Windows takes the NSIS setup .exe (x64 also runs on arm64);
 * Linux takes the format it was installed from: the AppImage when running as one,
 * otherwise the .deb, falling back to the other. Release assets always name their
 * architecture (build.artifactName); one without it is never chosen.
 */
export function selectAsset(assets: ReleaseAsset[], platform: string, arch: string, linuxFormat: 'appimage' | 'deb' = 'appimage'): ReleaseAsset | undefined {
  const fits = (asset: ReleaseAsset, wanted: string) => archOf(asset.name) === wanted;
  const byExtension = (extensions: string[], wanted: string) => {
    for (const extension of extensions) {
      const found = assets.find(asset => asset.name.toLowerCase().endsWith(extension) && fits(asset, wanted));
      if (found) return found;
    }
    return undefined;
  };
  if (platform === 'darwin') return byExtension(['.dmg', '.zip'], arch === 'arm64' ? 'arm64' : 'x64');
  if (platform === 'win32') {
    return (arch === 'arm64' ? byExtension(['.exe'], 'arm64') : undefined) ?? byExtension(['.exe'], 'x64');
  }
  if (platform === 'linux') {
    const order = linuxFormat === 'deb' ? ['.deb', '.appimage'] : ['.appimage', '.deb'];
    return byExtension(order, arch === 'arm64' ? 'arm64' : 'x64');
  }
  return undefined;
}

/** `sha256sum`/`shasum -a 256` output → file name → lowercase hex digest. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
    if (!match) continue;
    // Release assets are flat; SHA256SUMS may list them with a directory.
    const name = match[2].trim().split('/').pop()!;
    sums.set(name, match[1].toLowerCase());
  }
  return sums;
}

/** A file name that does not overwrite anything already in the folder. */
export function availableName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.toLowerCase().endsWith('.tar.gz') ? name.length - 7 : name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${extension}`;
    if (!taken(candidate)) return candidate;
  }
}
