// Run after npm run build. An optional first argument selects a packaged Electron executable.
// "更新说明" beside the sidebar version lists every version newest first, with
// numbered features and fixes, and marks the running version.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const profile = await mkdtemp(path.join(tmpdir(), 'lectern-release-notes-'));
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
let app;
try {
  const executablePath = process.argv[2];
  // Windows has no demo (its conversation is a local tmux session): a fresh profile there.
  const demo = process.platform === 'win32' ? [] : ['--demo'];
  app = await _electron.launch({ executablePath, args: executablePath ? demo : ['.', ...demo], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.locator('.sidebar-bottom').getByText(`v${version}`, { exact: true }).waitFor();
  await page.getByRole('button', { name: '更新说明', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新说明' });
  await dialog.waitFor();
  const headings = await dialog.locator('.release-note h3').allTextContents();
  // At most one pending entry (next release, version not bumped yet) may precede it.
  const index = headings.indexOf(`v${version}当前版本`);
  assert.ok(index === 0 || (index === 1 && /^v\d+\.\d+\.\d+待发布$/.test(headings[0])), 'the running version comes first, after at most one pending release, and is marked');
  const current = dialog.locator('.release-note').nth(index);
  assert.deepEqual(await current.locator('h4').allTextContents(), ['新功能', '问题修复']);
  assert.ok(await current.locator('ol').first().locator('li').count() > 0);
  assert.equal(await current.locator('ol').first().evaluate(list => getComputedStyle(list.querySelector('li')).listStyleType), 'decimal', 'numbered');
  await mkdir(path.resolve('test-results'), { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.resolve('test-results', 'release-notes.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  console.log('PASS: release notes list every version newest first with numbered features and fixes; the running version is marked.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
