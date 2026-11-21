// Prints the GitHub Release body for one version from src/shared/release-notes.ts.
//   npx tsx scripts/release-notes-md.ts            → the version in package.json
//   npx tsx scripts/release-notes-md.ts v0.2.0     → that version (a tag works too)
// Exits non-zero when the version has no entry, so a tag cannot ship without notes.
import { readFileSync } from 'node:fs';
import { releaseItemText, releaseNotes, type ReleaseItem } from '../src/shared/release-notes';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = (process.argv[2] ?? manifest.version).replace(/^v/, '');
const note = releaseNotes.find(entry => entry.version === version);
if (!note) {
  console.error(`No entry for ${version} in src/shared/release-notes.ts`);
  process.exit(1);
}
// Both languages: the Release page and the in-app update prompt show the same body.
// Items without English yet (allowed only before release) repeat the Chinese.
const lines: string[] = [];
const list = (title: string, items: ReleaseItem[], locale: 'zh-CN' | 'en') => {
  if (!items.length) return;
  lines.push(`## ${title}`, '', ...items.map((item, i) => `${i + 1}. ${releaseItemText(item, locale)}`), '');
};
list('新功能', note.features, 'zh-CN');
list('问题修复', note.fixes, 'zh-CN');
list('New features', note.features, 'en');
list('Fixes', note.fixes, 'en');
lines.push('---', '',
  '安装包未经过平台签名时，macOS 需在「系统设置 → 隐私与安全性」中允许打开，Windows SmartScreen 需选择「仍要运行」。', '',
  'Without platform signing, allow the app under System Settings › Privacy & Security on macOS, and choose "Run anyway" in Windows SmartScreen.', '',
  '用 `SHA256SUMS` 校验下载：`shasum -a 256 -c SHA256SUMS --ignore-missing`（Linux 用 `sha256sum`）。', '',
  'Verify downloads with `SHA256SUMS`: `shasum -a 256 -c SHA256SUMS --ignore-missing` (on Linux, `sha256sum`).', '');
process.stdout.write(lines.join('\n'));
