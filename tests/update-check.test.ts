import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  availableName, compareVersions, githubRepository, isNewerVersion, parseChecksums, parseVersion, releaseFromGitHub, selectAsset,
} from '../src/shared/update-check';
import { updateLanguage, updateStrings, updateText } from '../src/shared/update-strings';

test('versions compare numerically, with pre-releases before their release', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { core: [1, 2, 3], pre: [] });
  assert.equal(parseVersion('1.2'), undefined);
  assert.equal(parseVersion('latest'), undefined);
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.ok(compareVersions('v0.2.0', '0.1.99') > 0);
  assert.equal(compareVersions('v0.1.20', '0.1.20'), 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0, 'numeric identifiers sort before alphanumeric ones');
  assert.equal(isNewerVersion('v0.2.0', '0.1.20'), true);
  assert.equal(isNewerVersion('0.1.20', '0.1.20'), false);
  assert.equal(isNewerVersion('0.1.19', '0.1.20'), false);
  assert.equal(isNewerVersion('nightly', '0.1.20'), false);
});

test('the repository comes from package.json (sharinka0715/lectern); an OWNER/… placeholder turns checks off', () => {
  assert.equal(githubRepository({ type: 'git', url: 'https://github.com/OWNER/lectern.git' }), undefined);
  assert.equal(githubRepository({ type: 'git', url: 'https://github.com/OWNER/REPO.git' }), undefined);
  // The published app checks the public repository's releases.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(githubRepository(manifest.repository), 'sharinka0715/lectern');
  assert.equal(githubRepository('github:owner/repo'), undefined);
  assert.equal(githubRepository(undefined), undefined);
  assert.equal(githubRepository({ url: 'https://gitlab.com/a/b.git' }), undefined);
  assert.equal(githubRepository({ type: 'git', url: 'git+https://github.com/someone/lectern.git' }), 'someone/lectern');
  assert.equal(githubRepository('github:someone/lectern'), 'someone/lectern');
  assert.equal(githubRepository('git@github.com:someone/code.lectern.git'), 'someone/code.lectern');
  assert.equal(githubRepository('someone/lectern'), 'someone/lectern');
});

test("GitHub's latest-release response becomes the prompt's release; drafts and odd tags are ignored", () => {
  const release = releaseFromGitHub({
    tag_name: 'v0.2.0', name: 'Lectern 0.2.0', body: '## 新功能\n1. 更新检查。', html_url: 'https://github.com/a/b/releases/tag/v0.2.0',
    assets: [{ name: 'SHA256SUMS', browser_download_url: 'https://github.com/a/b/releases/download/v0.2.0/SHA256SUMS', size: 300 }, { name: 'broken' }],
  });
  assert.equal(release?.version, '0.2.0');
  assert.equal(release?.notes, '## 新功能\n1. 更新检查。');
  assert.deepEqual(release?.assets.map(a => a.name), ['SHA256SUMS']);
  assert.equal(releaseFromGitHub({ tag_name: 'v0.2.0', draft: true }), undefined);
  assert.equal(releaseFromGitHub({ tag_name: 'nightly' }), undefined);
  assert.equal(releaseFromGitHub(null), undefined);
});

test('each platform and architecture gets its own installer', () => {
  const names = [
    'lectern-0.2.0-mac-arm64.dmg', 'lectern-0.2.0-mac-arm64.zip', 'lectern-0.2.0-mac-x64.dmg', 'lectern-0.2.0-mac-x64.zip',
    'lectern-0.2.0-win-x64.exe', 'lectern-0.2.0-win-x64.exe.blockmap',
    'lectern-0.2.0-linux-x86_64.AppImage', 'lectern-0.2.0-linux-amd64.deb', 'lectern-0.2.0-linux-arm64.AppImage', 'SHA256SUMS',
  ];
  const assets = names.map(name => ({ name, url: `https://example.com/${name}`, size: 1 }));
  const pick = (platform: string, arch: string, format?: 'appimage' | 'deb') => selectAsset(assets, platform, arch, format)?.name;
  assert.equal(pick('darwin', 'arm64'), 'lectern-0.2.0-mac-arm64.dmg');
  assert.equal(pick('darwin', 'x64'), 'lectern-0.2.0-mac-x64.dmg');
  assert.equal(pick('win32', 'x64'), 'lectern-0.2.0-win-x64.exe');
  assert.equal(pick('win32', 'arm64'), 'lectern-0.2.0-win-x64.exe', 'x64 runs on Windows on Arm');
  assert.equal(pick('linux', 'x64'), 'lectern-0.2.0-linux-x86_64.AppImage');
  assert.equal(pick('linux', 'x64', 'deb'), 'lectern-0.2.0-linux-amd64.deb');
  assert.equal(pick('linux', 'arm64', 'deb'), 'lectern-0.2.0-linux-arm64.AppImage', 'falls back to the other format');
  assert.equal(pick('freebsd', 'x64'), undefined);
  const only = (name: string) => [{ name, url: name, size: 1 }];
  assert.equal(selectAsset(only('lectern-0.2.0-mac-arm64.dmg'), 'darwin', 'x64'), undefined, 'never an installer for another architecture');
  assert.equal(selectAsset(only('lectern-0.2.0-mac-arm64.zip'), 'darwin', 'arm64')?.name, 'lectern-0.2.0-mac-arm64.zip', 'the ZIP when there is no DMG');
  assert.equal(selectAsset(only('lectern-0.2.0.dmg'), 'darwin', 'x64'), undefined, 'an asset without an architecture is never chosen');
});

test('SHA256SUMS lines from sha256sum and shasum, with or without directories', () => {
  const a = 'a'.repeat(64), b = 'B'.repeat(64);
  const sums = parseChecksums(`${a}  mac/lectern-0.2.0-mac-arm64.dmg\r\n${b} *lectern setup.exe\nnot a checksum line\n\n`);
  assert.equal(sums.get('lectern-0.2.0-mac-arm64.dmg'), a);
  assert.equal(sums.get('lectern setup.exe'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('a download never overwrites a file already in Downloads', () => {
  const taken = new Set(['a.dmg', 'a (1).dmg', 'b.tar.gz']);
  assert.equal(availableName('new.exe', name => taken.has(name)), 'new.exe');
  assert.equal(availableName('a.dmg', name => taken.has(name)), 'a (2).dmg');
  assert.equal(availableName('b.tar.gz', name => taken.has(name)), 'b (1).tar.gz');
});

test('update texts exist in both languages with the same placeholders', () => {
  assert.equal(updateLanguage(undefined), 'zh');
  assert.equal(updateLanguage('zh-CN'), 'zh');
  assert.equal(updateLanguage('en'), 'en');
  assert.equal(updateLanguage('en-US'), 'en');
  for (const key of Object.keys(updateStrings.zh) as (keyof typeof updateStrings.zh)[]) {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(holes(updateStrings.en[key]), holes(updateStrings.zh[key]), key);
  }
  assert.equal(updateText('zh-CN', 'upToDate', { version: '0.2.0' }), '已是最新版本（0.2.0）。');
  assert.equal(updateText('en', 'upToDate', { version: '0.2.0' }), 'You are up to date (0.2.0).');
});
