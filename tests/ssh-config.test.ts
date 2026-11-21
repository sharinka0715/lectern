import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeSshHost, importableSshAlias, parseSshConfig, splitSshArgs, type SshConfigFiles } from '../src/shared/ssh-config';
import { expandSshGlob, readSshConfigHosts } from '../src/main/ssh-config-hosts';
import { filterSshImportRows, importSshConnections, sshImportRows } from '../src/renderer/ssh-config-import';

const memory = (tree: Record<string, string>): SshConfigFiles => ({
  read: file => tree[file],
  expand: pattern => pattern.includes('*') ? Object.keys(tree).filter(file => file.startsWith(pattern.split('*')[0])).sort() : [pattern],
});

test('Host aliases are listed with the first HostName, User, Port and ProxyJump of their block', () => {
  const config = `# personal
Host gpu-box
    HostName 192.0.2.10
    User dev
Host devbox dev-alt
  HostName=dev.example.com
  Port 2222
  Port 2223
  ProxyJump jump
Host *
  User nobody
  ServerAliveInterval 30
Host !blocked *.corp ?ab
Match host foo
  User matched
HOST cloud-gpu
    HostName 203.0.113.88
    user root
    port 2022
`;
  const result = parseSshConfig('/home/u/.ssh/config', '/home/u', memory({ '/home/u/.ssh/config': config }));
  assert.deepEqual(result.hosts.map(h => h.alias), ['gpu-box', 'devbox', 'dev-alt', 'cloud-gpu']);
  assert.deepEqual(result.hosts[0], { alias: 'gpu-box', hostName: '192.0.2.10', user: 'dev', source: '/home/u/.ssh/config', line: 2 });
  assert.equal(result.hosts[1].port, 2222);
  assert.equal(result.hosts[2].proxyJump, 'jump');
  assert.equal(result.hosts[2].hostName, 'dev.example.com');
  assert.equal(result.hosts[1].user, undefined, 'Host * rules are not attributed to earlier aliases');
  assert.deepEqual({ ...result.hosts[3], source: undefined, line: undefined }, { alias: 'cloud-gpu', hostName: '203.0.113.88', user: 'root', port: 2022, source: undefined, line: undefined });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.missing, undefined);
  assert.equal(describeSshHost(result.hosts[3]), 'root@203.0.113.88:2022');
  assert.equal(describeSshHost(result.hosts[1]), 'dev.example.com:2222 · 经 jump');
});

test('Include files are followed relative to ~/.ssh, with globs, cycles and missing files reported', () => {
  const tree = {
    '/h/.ssh/config': 'Include config.d/*\nInclude ~/.ssh/extra "/abs/quoted"\nInclude missing\nHost main\n',
    '/h/.ssh/config.d/a': 'Host a1\n  HostName a.example\nInclude /h/.ssh/config\n',
    '/h/.ssh/config.d/b': 'Host b1 a1\n',
    '/h/.ssh/extra': 'Host extra\n',
    '/abs/quoted': 'Host quoted\n',
  };
  const result = parseSshConfig('/h/.ssh/config', '/h', memory(tree));
  assert.deepEqual(result.hosts.map(h => h.alias), ['a1', 'b1', 'extra', 'quoted', 'main']);
  assert.equal(result.hosts[0].source, '/h/.ssh/config.d/a');
  assert.ok(result.warnings.some(w => w.includes('循环')), result.warnings.join());
  assert.ok(result.warnings.some(w => w.includes('/h/.ssh/missing')), result.warnings.join());
});

test('a missing config is reported, not treated as an error', () => {
  const result = parseSshConfig('/h/.ssh/config', '/h', memory({}));
  assert.deepEqual(result.hosts, []);
  assert.equal(result.missing, true);
});

test('argument splitting honors double quotes', () => {
  assert.deepEqual(splitSshArgs('a "b c"  d'), ['a', 'b c', 'd']);
});

test('the real file reader expands Include globs and skips dotfiles', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'lectern-sshcfg-'));
  try {
    await mkdir(path.join(home, '.ssh', 'conf.d'), { recursive: true });
    await writeFile(path.join(home, '.ssh', 'config'), 'Include conf.d/*.conf\nHost top\n');
    await writeFile(path.join(home, '.ssh', 'conf.d', 'b.conf'), 'Host bee\n');
    await writeFile(path.join(home, '.ssh', 'conf.d', 'a.conf'), 'Host ay\n');
    await writeFile(path.join(home, '.ssh', 'conf.d', '.hidden.conf'), 'Host hidden\n');
    await writeFile(path.join(home, '.ssh', 'conf.d', 'notes.txt'), 'Host txt\n');
    assert.deepEqual(expandSshGlob(path.join(home, '.ssh', 'conf.d', '*.conf')).map(f => path.basename(f)), ['a.conf', 'b.conf']);
    assert.deepEqual(readSshConfigHosts(home).hosts.map(h => h.alias), ['ay', 'bee', 'top']);
    assert.equal(readSshConfigHosts(path.join(home, 'nobody')).missing, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('import rows mark saved and unsupported aliases; import adds only new, chosen, valid aliases', () => {
  const hosts = ['gpu-box', 'devbox', 'bad/alias', 'user@box'].map((alias, line) => ({ alias, source: '/c', line }));
  const existing = [{ id: 'x', name: '开发机', host: 'devbox' }, { id: 'y', name: 'other port', host: 'gpu-box', port: 2200 }];
  const rows = sshImportRows(hosts, existing);
  assert.deepEqual(rows.map(r => r.status), ['available', 'saved', 'unsupported', 'available']);
  assert.equal(importableSshAlias('bad/alias'), false);
  assert.deepEqual(filterSshImportRows(rows, 'GPU').map(r => r.host.alias), ['gpu-box']);
  let id = 0;
  const next = importSshConnections(['gpu-box', 'devbox', 'bad/alias'], rows, existing, () => `n${++id}`);
  assert.deepEqual(next, [...existing, { id: 'n1', name: 'gpu-box', host: 'gpu-box' }]);
  assert.deepEqual(importSshConnections([], rows, existing), existing);
});
