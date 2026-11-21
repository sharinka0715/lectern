import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdateService } from '../src/main/update-service';
import type { UpdateState } from '../src/shared/update-check';

// A loopback stand-in for GitHub's "latest release" API and its asset downloads.
async function fakeGitHub(options: { tag: string; installer?: Buffer; checksum?: string; status?: number; sums?: boolean }) {
  const installer = options.installer ?? Buffer.from('installer bytes '.repeat(4096));
  const name = 'lectern-9.0.0-linux-x86_64.AppImage';
  const digest = options.checksum ?? createHash('sha256').update(installer).digest('hex');
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url!);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.url === '/repos/someone/lectern/releases/latest') {
      if (options.status) return res.writeHead(options.status, { 'x-ratelimit-remaining': '0' }).end('{}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        tag_name: options.tag, name: options.tag, body: '## 新功能\n1. 测试版本。', html_url: `https://github.com/someone/lectern/releases/tag/${options.tag}`,
        assets: [
          { name, size: installer.length, browser_download_url: `${base}/download/${name}` },
          ...(options.sums === false ? [] : [{ name: 'SHA256SUMS', size: 100, browser_download_url: `${base}/download/SHA256SUMS` }]),
        ],
      }));
    } else if (req.url === `/download/${name}`) {
      res.writeHead(200, { 'content-length': installer.length }).end(installer);
    } else if (req.url === '/download/SHA256SUMS') {
      res.writeHead(200).end(`${digest}  ${name}\n${'0'.repeat(64)}  other.dmg\n`);
    } else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, installer, name, api: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function withService(github: Awaited<ReturnType<typeof fakeGitHub>>, run: (service: UpdateService, seen: UpdateState[], dir: string, revealed: string[]) => Promise<void>, repository: string | null = 'someone/lectern') {
  const dir = await mkdtemp(path.join(tmpdir(), 'lectern-update-'));
  const seen: UpdateState[] = [], revealed: string[] = [];
  const make = () => new UpdateService({
    currentVersion: '0.2.0', repository: repository ?? undefined, apiBase: github.api, fetch, allowInsecure: true,
    settingsFile: path.join(dir, 'profile', 'update-settings.json'), downloadsDirectory: () => path.join(dir, 'Downloads'),
    platform: 'linux', arch: 'x64', locale: 'zh-CN', publish: state => seen.push(state),
    reveal: file => revealed.push(file), open: async () => '', openExternal: () => {},
  });
  const service = make();
  await service.load();
  try { await run(service, seen, dir, revealed); }
  finally { service.stop(); await service.flush(); github.server.close(); await rm(dir, { recursive: true, force: true }); }
}

test('a newer release is offered with its notes and installer; downloading verifies SHA-256 and reveals the file', async () => {
  const github = await fakeGitHub({ tag: 'v9.0.0' });
  await withService(github, async (service, seen, dir, revealed) => {
    const state = await service.check(true);
    assert.equal(state.status.kind, 'available');
    if (state.status.kind !== 'available') return;
    assert.equal(state.status.release.version, '9.0.0');
    assert.match(state.status.release.notes, /测试版本/);
    assert.equal(state.status.asset?.name, github.name);
    const done = await service.download();
    assert.equal(done.status.kind, 'downloaded');
    const file = path.join(dir, 'Downloads', github.name);
    assert.deepEqual(await readFile(file), github.installer);
    assert.deepEqual(revealed, [file]);
    assert.ok(seen.some(s => s.status.kind === 'downloading'), 'progress is published');
    assert.deepEqual(await readdir(path.join(dir, 'Downloads')), [github.name], 'no partial file is left');
    // A second download keeps the first file.
    await service.check(true);
    await service.download();
    assert.deepEqual((await readdir(path.join(dir, 'Downloads'))).sort(), [`lectern-9.0.0-linux-x86_64 (1).AppImage`, github.name].sort());
  });
});

test('a checksum mismatch or a missing SHA256SUMS deletes the download and reports why', async () => {
  for (const [options, code] of [[{ checksum: 'f'.repeat(64) }, 'checksum-mismatch'], [{ sums: false }, 'no-checksums']] as const) {
    const github = await fakeGitHub({ tag: 'v9.0.0', ...options });
    await withService(github, async (service, _seen, dir) => {
      await service.check(true);
      const state = await service.download();
      assert.equal(state.status.kind, 'error');
      if (state.status.kind === 'error') assert.equal(state.status.code, code);
      assert.deepEqual(await readdir(path.join(dir, 'Downloads')).catch(() => []), []);
      // The prompt can retry: the release stays attached to the error.
      assert.equal(state.status.kind === 'error' && state.status.release?.version, '9.0.0');
    });
  }
});

test('skipping a version mutes automatic checks only; settings survive a restart', async () => {
  const github = await fakeGitHub({ tag: 'v9.0.0' });
  await withService(github, async (service, seen, dir) => {
    await service.check(false);
    assert.equal(service.state().status.kind, 'available');
    service.dismiss('skip');
    await service.flush();
    assert.equal(service.state().skippedVersion, '9.0.0');
    assert.equal((await service.check(false)).status.kind, 'idle', 'an automatic check stays quiet');
    assert.equal((await service.check(true)).status.kind, 'available', 'a manual check still shows it');
    service.dismiss('later');
    assert.equal(service.state().status.kind, 'idle');
    await service.setAutoCheck(false);
    const stored = JSON.parse(await readFile(path.join(dir, 'profile', 'update-settings.json'), 'utf8'));
    assert.deepEqual([stored.autoCheck, stored.skippedVersion, typeof stored.lastCheckedAt], [false, '9.0.0', 'number']);
    // Automatic checks are off: start() fires nothing.
    const before = github.requests.length;
    service.start(5, 10);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(github.requests.length, before);
    assert.ok(seen.length > 0);
  });
});

test('up to date, rate limits and the placeholder repository', async () => {
  let github = await fakeGitHub({ tag: 'v0.2.0' });
  await withService(github, async service => {
    const state = await service.check(true);
    assert.equal(state.status.kind, 'up-to-date');
  });
  github = await fakeGitHub({ tag: 'v9.0.0', status: 403 });
  await withService(github, async service => {
    const state = await service.check(true);
    assert.equal(state.status.kind === 'error' && state.status.code, 'rate-limited');
  });
  github = await fakeGitHub({ tag: 'v9.0.0' });
  await withService(github, async service => {
    assert.equal(service.configured, false);
    service.start(1, 5);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(github.requests.length, 0, 'no request while the repository is a placeholder');
    const state = await service.check(true);
    assert.equal(state.status.kind === 'error' && state.status.code, 'not-configured');
  }, null);
});

test('only https URLs unless a loopback test server is configured', async () => {
  const github = await fakeGitHub({ tag: 'v9.0.0' });
  const service = new UpdateService({
    currentVersion: '0.2.0', repository: 'someone/lectern', apiBase: github.api, fetch, settingsFile: path.join(tmpdir(), 'unused-update-settings.json'),
    downloadsDirectory: () => tmpdir(), platform: 'linux', arch: 'x64', locale: 'en', publish: () => {}, reveal: () => {}, open: async () => '', openExternal: () => {},
  });
  const state = await service.check(true);
  github.server.close();
  assert.equal(state.status.kind === 'error' && state.status.code, 'bad-response');
  assert.equal(github.requests.length, 0);
});
