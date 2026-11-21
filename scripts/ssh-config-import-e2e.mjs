// node scripts/ssh-config-import-e2e.mjs [packaged-executable]
// Import Host aliases from a fixture ~/.ssh/config. No SSH connection is made.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'lectern-ssh-import-'));
const home = path.join(root, 'home');
await mkdir(path.join(home, '.ssh', 'conf.d'), { recursive: true });
await writeFile(path.join(home, '.ssh', 'config'), 'Include conf.d/*\nHost alpha\n  HostName a.example\n  User me\n  Port 2200\nHost beta gamma\n  ProxyJump jump\nHost *\n  User nobody\n');
await writeFile(path.join(home, '.ssh', 'conf.d', 'work'), 'Host work-box\n  HostName 192.0.2.9\n');
const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: path.join(root, 'profile'), LECTERN_LOG_DIR: path.join(root, 'logs'), LECTERN_SSH_CONFIG_HOME: home };
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
let app;
try {
  const executablePath = process.argv[2];
  app = await _electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath && { executablePath: path.resolve(executablePath) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: '添加 SSH 机器' }).click();
  await page.getByRole('button', { name: '从 ~/.ssh/config 导入' }).click();
  const list = page.getByRole('dialog', { name: '从 SSH 配置导入' });
  await list.getByText('work-box', { exact: true }).waitFor();
  const aliases = await list.locator('[data-ssh-alias]').evaluateAll(rows => rows.map(row => row.getAttribute('data-ssh-alias')));
  assert.deepEqual(aliases, ['work-box', 'alpha', 'beta', 'gamma'], 'Include first, wildcards are not machines');
  assert.match(await list.locator('[data-ssh-alias="alpha"]').innerText(), /me@a\.example:2200/);
  assert.match(await list.locator('[data-ssh-alias="beta"]').innerText(), /经 jump/);
  const importButton = list.getByRole('button', { name: '导入所选主机' });
  assert.equal(await importButton.isDisabled(), true, 'nothing is selected by default');
  await list.getByRole('searchbox', { name: '筛选主机' }).fill('a');
  await list.getByRole('button', { name: '全选可导入' }).click();
  await list.getByRole('searchbox', { name: '筛选主机' }).fill('');
  await list.getByRole('checkbox', { name: '选择 gamma' }).uncheck();
  await list.getByRole('checkbox', { name: '选择 work-box' }).check();
  assert.equal(await importButton.innerText(), '导入 3 台主机');
  await importButton.click();
  await list.waitFor({ state: 'detached' });
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'detached' });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lectern.desktop.preferences.v1') ?? '{}'));
  const hosts = (stored.connections ?? []).map(c => c.host).sort();
  assert.deepEqual(hosts, ['alpha', 'beta', 'work-box']);
  for (const alias of hosts) await page.locator('.sidebar').getByText(alias, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '添加 SSH 机器' }).click();
  await page.getByRole('button', { name: '从 ~/.ssh/config 导入' }).click();
  await list.locator('[data-ssh-alias="alpha"][data-status="saved"]').waitFor();
  await list.locator('[data-ssh-alias="gamma"][data-status="available"]').waitFor();
  console.log(JSON.stringify({ ok: true, imported: hosts }));
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
