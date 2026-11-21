// node scripts/archive-ui-e2e.mjs [packaged-executable]
// Archive a saved conversation from the sidebar, find it in Settings → 回收站 and restore it.
// Temporary JSONL history only: no Claude process, no remote, no model request.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lectern-archive-')));
const profile = path.join(root, 'profile'), config = path.join(root, 'claude'), cwd = path.join(root, 'work');
const project = path.join(config, 'projects', cwd.replace(/[^a-z0-9-]/gi, '-'));
const kept = randomUUID(), archived = randomUUID();
const history = (sid, prompt) => [
  { type: 'user', uuid: `${sid}-u`, parentUuid: null, message: { role: 'user', content: prompt } },
  { type: 'assistant', uuid: `${sid}-a`, parentUuid: `${sid}-u`, message: { id: `${sid}-m`, role: 'assistant', content: [{ type: 'text', text: '好的。' }], stop_reason: 'end_turn' } },
].map(r => JSON.stringify({ ...r, cwd, sessionId: sid, timestamp: new Date().toISOString() })).join('\n') + '\n';
let app;
try {
  await Promise.all([profile, cwd, project].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(profile, 'workspaces.json'), JSON.stringify([{ id: 'fixture', name: '归档检查', kind: 'local', cwd, claudeDir: config }]));
  await writeFile(path.join(project, `${kept}.jsonl`), history(kept, '保留这条'));
  await writeFile(path.join(project, `${archived}.jsonl`), history(archived, '归档这条'));
  const before = await readFile(path.join(project, `${archived}.jsonl`), 'utf8');
  const env = { ...process.env, LECTERN_LOCALE: 'zh-CN', LECTERN_USER_DATA: profile, CLAUDE_CONFIG_DIR: config, TMUX_TMPDIR: root, LECTERN_DIAGNOSTIC_CONTENT: '0' };
  delete env.LECTERN_DEV_URL; delete env.ELECTRON_RUN_AS_NODE; delete env.TMUX;
  const exe = process.argv[2];
  app = await _electron.launch({ args: exe ? [] : ['.'], ...(exe && { executablePath: path.resolve(exe) }), env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  const row = sid => page.locator(`.session-row[data-session-id="${sid}"]`);
  await row(archived).click();
  await page.locator('.message-assistant').getByText('好的。').waitFor();
  await row(archived).click({ button: 'right' });
  await page.locator('.context-menu:popover-open').getByRole('menuitem', { name: '归档对话' }).click();
  await row(archived).waitFor({ state: 'detached' });
  await row(kept).waitFor();
  await page.locator('.context-toast').getByText(/已归档/).waitFor();
  assert.equal(await readFile(path.join(project, `${archived}.jsonl`), 'utf8'), before, 'the conversation file is untouched');
  // Survives a reload, then comes back from Settings → 回收站.
  await page.reload();
  await row(kept).waitFor();
  assert.equal(await row(archived).count(), 0);
  await page.getByRole('button', { name: '界面与连接设置' }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '回收站' }).click();
  const entry = settings.locator(`[data-archived-session="${archived}"]`);
  assert.match(await entry.innerText(), /归档这条|新对话|对话/);
  await entry.getByRole('button', { name: /^恢复/ }).click();
  await settings.locator('[data-trash-empty]').waitFor();
  await settings.getByRole('button', { name: '关闭设置' }).click();
  await row(archived).waitFor();
  console.log(JSON.stringify({ ok: true, archived, fileUntouched: true, restored: true }));
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
