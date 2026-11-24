import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isLaterVersion, releaseItemText, releaseNotes } from '../src/shared/release-notes';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** One short Chinese sentence ending in 。. */
function assertChinese(item: string) {
  assert.match(item, /^[^\n]{6,80}。$/u, `one short sentence: ${item}`);
  assert.equal((item.match(/。/gu) ?? []).length, 1, `exactly one sentence: ${item}`);
}

/** One English sentence ending in a period, without CJK text. */
function assertEnglish(item: string) {
  assert.match(item, /^[^\n]{6,200}\.$/u, `one short English sentence: ${item}`);
  assert.doesNotMatch(item, /[.!?]\s+[A-Z“]/u, `exactly one English sentence: ${item}`);
  assert.doesNotMatch(item, /[　-〿一-鿿＀-￯]/u, `no Chinese in the English text: ${item}`);
}

test('the current version has release notes: features and fixes listed separately, one sentence each, newest first', () => {
  // One pending entry for the next release may sit above the current version.
  const current = releaseNotes[0] && isLaterVersion(releaseNotes[0].version, version) ? 1 : 0;
  assert.equal(releaseNotes[current]?.version, version, `add an entry for ${version} at the top of src/shared/release-notes.ts`);
  const versions = releaseNotes.map(note => note.version);
  assert.equal(new Set(versions).size, versions.length, 'one entry per version');
  const order = (v: string) => v.split('.').map(Number);
  for (let i = 1; i < versions.length; i++) {
    const [a, b] = [order(versions[i - 1]), order(versions[i])];
    assert.ok(a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2]), `${versions[i - 1]} before ${versions[i]}`);
  }
  for (const note of releaseNotes) {
    assert.ok(note.features.length + (note.changes?.length ?? 0) + note.fixes.length > 0, `${note.version} lists something`);
    for (const item of [...note.features, ...(note.changes ?? []), ...note.fixes]) assertChinese(typeof item === 'string' ? item : item[0]);
  }
});

test('released versions are in both languages; only the pending entry may have Chinese-only items', () => {
  for (const note of releaseNotes) {
    const pending = isLaterVersion(note.version, version);
    for (const item of [...note.features, ...(note.changes ?? []), ...note.fixes]) {
      if (typeof item === 'string') {
        assert.ok(pending, `${note.version} is released: translate “${item}” into an ['中文', 'English'] pair`);
        continue;
      }
      assertEnglish(item[1]);
    }
  }
});

test('the dialog text follows the language and falls back to Chinese', () => {
  assert.equal(releaseItemText(['中文。', 'English.'], 'en'), 'English.');
  assert.equal(releaseItemText(['中文。', 'English.'], 'zh-CN'), '中文。');
  assert.equal(releaseItemText('只有中文。', 'en'), '只有中文。');
});

test('version order helper compares numerically', () => {
  assert.equal(isLaterVersion('0.1.17', '0.1.16'), true);
  assert.equal(isLaterVersion('0.1.10', '0.1.9'), true);
  assert.equal(isLaterVersion('0.2.0', '0.1.99'), true);
  assert.equal(isLaterVersion('0.1.16', '0.1.16'), false);
  assert.equal(isLaterVersion('0.1.15', '0.1.16'), false);
});
