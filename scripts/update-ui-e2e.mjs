// npm run build && node scripts/update-ui-e2e.mjs [packaged-executable]
// The update check against a loopback fake GitHub API: the automatic check's
// prompt, "稍后", the menu's manual check, download with progress and SHA-256
// verification into a private Downloads folder, a checksum mismatch, "跳过此版本",
// the settings page (automatic checks off, up to date) and the skipped version
// staying quiet at the next start. Nothing reaches the network.
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'lectern-update-e2e-'));
const privateServer = createPrivateTmux(root);
const profile = path.join(root, 'profile'), downloads = path.join(root, 'Downloads');
const results = path.resolve('test-results');
await mkdir(results, { recursive: true });
const repository = 'test-owner/lectern';
const assetName = version => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `lectern-${version}-mac-${arch}.dmg`;
  if (process.platform === 'win32') return `lectern-${version}-win-x64.exe`;
  return `lectern-${version}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`;
};
const installer = version => Buffer.alloc(3 * 1024 * 1024 + 123, `installer ${version} `);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The fake GitHub: /repos/<repo>/releases/latest and its assets. `release` decides the answer.
let release = { tag: 'v99.0.0', goodChecksum: true };
const requests = [];
const server = createServer(async (req, res) => {
  requests.push(req.url);
  const base = `http://127.0.0.1:${server.address().port}`;
  const version = release.tag.replace(/^v/, '');
  if (req.url === `/repos/${repository}/releases/latest`) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      tag_name: release.tag, name: `Lectern ${version}`, html_url: `https://github.com/${repository}/releases/tag/${release.tag}`,
      body: `## 新功能\n\n1. 假的更新说明 ${version}。\n\n## 问题修复\n\n1. 修好了一个问题。`,
      assets: [
        { name: assetName(version), size: installer(version).length, browser_download_url: `${base}/download/${release.tag}/${assetName(version)}` },
        { name: 'SHA256SUMS', size: 200, browser_download_url: `${base}/download/${release.tag}/SHA256SUMS` },
      ],
    }));
    return;
  }
  const match = /^\/download\/v([^/]+)\/(.+)$/.exec(req.url);
  if (match && match[2] === 'SHA256SUMS') {
    const digest = release.goodChecksum ? sha256(installer(match[1])) : '0'.repeat(64);
    res.writeHead(200).end(`${digest}  ${assetName(match[1])}\n`);
  } else if (match && match[2] === assetName(match[1])) {
    // Slow enough for the progress bar to show.
    const bytes = installer(match[1]);
    res.writeHead(200, { 'content-length': bytes.length, 'content-type': 'application/octet-stream' });
    for (let at = 0; at < bytes.length; at += 256 * 1024) {
      res.write(bytes.subarray(at, at + 256 * 1024));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    res.end();
  } else res.writeHead(404).end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const latestRequests = () => requests.filter(url => url.endsWith('/releases/latest')).length;

const exe = process.argv[2];
async function launch(extra) {
  const env = { ...privateServer.env, LECTERN_USER_DATA: profile, LECTERN_DIAGNOSTIC_CONTENT: '0', ...extra };
  delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
  const app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { app, page, errors };
}
const fake = {
  LECTERN_UPDATE_API: `http://127.0.0.1:${server.address().port}`, LECTERN_UPDATE_REPOSITORY: repository,
  LECTERN_UPDATE_DELAY_MS: '400', LECTERN_DOWNLOADS_DIR: downloads, LECTERN_UPDATE_NO_REVEAL: '1',
};
const menuCheck = app => app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? [])
  .find(item => item.label === '检查更新…').click());
const settingsFile = path.join(profile, 'update-settings.json');
const storedSettings = async () => JSON.parse(await readFile(settingsFile, 'utf8'));
const waitFor = async (condition, message, timeout = 10000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) if (await condition()) return;
  throw new Error(message);
};
let session;
try {
  // 1. Without an update source (a placeholder repository) the page says so and nothing is requested.
  {
    session = await launch({ LECTERN_UPDATE_API: fake.LECTERN_UPDATE_API, LECTERN_UPDATE_DELAY_MS: '200', LECTERN_UPDATE_REPOSITORY: 'OWNER/lectern' });
    await session.app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? [])
      .find(item => item.label === '设置…').click());
    const settings = session.page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '更新', exact: true }).click();
    await settings.getByText('此版本未配置更新源，无法检查更新。').waitFor();
    assert.equal(await settings.getByRole('button', { name: '检查更新', exact: true }).count(), 0);
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(requests.length, 0, 'the placeholder repository never reaches the API');
    await session.app.close();
    session = undefined;
  }

  // 2. The automatic check shortly after start shows the new version and its notes.
  session = await launch(fake);
  const { app, page } = session;
  const prompt = page.getByRole('dialog', { name: '发现新版本' });
  await prompt.waitFor();
  assert.match(await prompt.innerText(), /Lectern 99\.0\.0 已发布，当前版本 \d+\.\d+\.\d+/);
  await prompt.getByText('假的更新说明 99.0.0。').waitFor();
  await prompt.getByRole('heading', { name: '问题修复' }).waitFor();
  await page.screenshot({ path: path.join(results, 'update-prompt.png') });
  // 稍后 closes it until the next check.
  await prompt.getByRole('button', { name: '稍后', exact: true }).click();
  await prompt.waitFor({ state: 'detached' });

  // 3. 检查更新… in the app menu asks again; 下载 shows progress, verifies SHA-256 and keeps the installer.
  await menuCheck(app);
  await prompt.waitFor();
  await prompt.getByRole('button', { name: '下载', exact: true }).click();
  await page.locator('.update-progress progress').waitFor();
  await page.locator('.update-progress').getByText(`正在下载 ${assetName('99.0.0')}`, { exact: true }).waitFor();
  await prompt.getByText('已下载并通过 SHA-256 校验').waitFor();
  const saved = path.join(downloads, assetName('99.0.0'));
  assert.deepEqual(await readFile(saved), installer('99.0.0'));
  assert.deepEqual(await readdir(downloads), [assetName('99.0.0')], 'no partial file is left behind');
  await prompt.getByRole('button', { name: '打开安装包', exact: true }).waitFor();
  await prompt.getByRole('button', { name: '在文件夹中显示', exact: true }).click();
  await page.screenshot({ path: path.join(results, 'update-downloaded.png') });
  await prompt.getByRole('button', { name: '关闭', exact: true }).last().click();
  await prompt.waitFor({ state: 'detached' });

  // 4. A checksum mismatch is reported and nothing is kept; 跳过此版本 remembers the version.
  release = { tag: 'v99.0.1', goodChecksum: false };
  await menuCheck(app);
  await prompt.getByText('Lectern 99.0.1 已发布', { exact: false }).waitFor();
  await prompt.getByRole('button', { name: '下载', exact: true }).click();
  const failed = page.getByRole('dialog', { name: '更新失败' });
  await failed.getByRole('alert').filter({ hasText: '下载的文件未通过 SHA-256 校验，已删除。' }).waitFor();
  assert.deepEqual(await readdir(downloads), [assetName('99.0.0')], 'the mismatching download is deleted');
  await failed.getByRole('button', { name: '重试', exact: true }).waitFor();
  await failed.getByRole('button', { name: '关闭', exact: true }).last().click();
  await failed.waitFor({ state: 'detached' });
  await menuCheck(app);
  await prompt.getByRole('button', { name: '跳过此版本', exact: true }).click();
  await prompt.waitFor({ state: 'detached' });
  await waitFor(async () => (await storedSettings().catch(() => ({}))).skippedVersion === '99.0.1', 'skipped version is saved');

  // 5. Settings → 更新: the skipped version, automatic checks off, up to date.
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? [])
    .find(item => item.label === '设置…').click());
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '更新', exact: true }).click();
  await settings.getByText('已跳过版本 99.0.1，手动检查时仍会显示。').waitFor();
  const auto = settings.getByRole('checkbox', { name: '自动检查更新' });
  assert.equal(await auto.isChecked(), true);
  await auto.uncheck();
  await waitFor(async () => (await storedSettings()).autoCheck === false, 'automatic checks are turned off');
  release = { tag: `v${manifest.version}`, goodChecksum: true };
  await settings.getByRole('button', { name: '检查更新', exact: true }).click();
  await settings.getByRole('status').filter({ hasText: `已是最新版本（${manifest.version}）。` }).waitFor();
  await settings.getByText(/^上次检查：/).waitFor();
  assert.equal(await prompt.count(), 0, 'nothing new: no prompt over the settings');
  await page.screenshot({ path: path.join(results, 'update-settings.png') });
  assert.deepEqual(session.errors, []);
  await app.close();
  session = undefined;

  // 6. Next start with automatic checks off: no request at all.
  release = { tag: 'v99.0.1', goodChecksum: true };
  let before = latestRequests();
  session = await launch(fake);
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(latestRequests(), before, 'automatic checks stay off');
  await session.app.close();
  session = undefined;

  // 7. Automatic checks on again: the skipped 99.0.1 is checked but not shown; a newer 99.0.2 is.
  await writeFile(settingsFile, JSON.stringify({ ...(await storedSettings()), autoCheck: true }));
  before = latestRequests();
  session = await launch(fake);
  await waitFor(() => latestRequests() > before, 'the automatic check runs');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(await session.page.getByRole('dialog', { name: '发现新版本' }).count(), 0, 'a skipped version stays quiet');
  release = { tag: 'v99.0.2', goodChecksum: true };
  await menuCheck(session.app);
  await session.page.getByRole('dialog', { name: '发现新版本' }).getByText('Lectern 99.0.2 已发布', { exact: false }).waitFor();
  assert.deepEqual(session.errors, []);
  console.log(JSON.stringify({ success: true, platform: `${process.platform}-${process.arch}`, asset: assetName('99.0.0'), requests: requests.length }));
} finally {
  await session?.app.close();
  server.close();
  privateServer.killAll();
  await rm(root, { recursive: true, force: true });
}
