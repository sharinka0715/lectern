import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function waitUntil(predicate, message, timeout = 18000) {
  const end = Date.now() + timeout;
  do {
    const result = await predicate();
    if (result) return result;
    await delay(120);
  } while (Date.now() < end);
  throw new Error(message);
}

export async function startLoopback({ root, env, alias, aliases = [] }) {
  const account = userInfo().username;
  for (const name of ['host', 'client']) {
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(root, name)]);
  }
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await writeFile(path.join(root, 'known_hosts'), alias + ' ' + await readFile(path.join(root, 'host.pub'), 'utf8'));
  const server = path.join(root, 'sshd_config'), client = path.join(root, 'ssh_config');
  await writeFile(server, [
    'ListenAddress 127.0.0.1', 'Port ' + port, 'HostKey ' + path.join(root, 'host'), 'PidFile ' + path.join(root, 'sshd.pid'),
    'AuthorizedKeysFile ' + path.join(root, 'client.pub'), 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'AllowUsers ' + account, 'LogLevel ERROR',
    'SetEnv ' + Object.entries(env).filter(([key]) => key !== 'PATH').map(([key, value]) => key + '=' + value).join(' '),
  ].join('\n') + '\n', { mode: 0o600 });
  await writeFile(client, [
    'Host ' + [alias, ...aliases].join(' '), '  HostName 127.0.0.1', '  Port ' + port, '  User ' + account, '  HostKeyAlias ' + alias,
    '  IdentityFile ' + path.join(root, 'client'), '  IdentitiesOnly yes', '  UserKnownHostsFile ' + path.join(root, 'known_hosts'),
  ].join('\n') + '\n', { mode: 0o600 });
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', server], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  daemon.stderr.on('data', data => { errors += data.toString(); });
  try {
    await waitUntil(async () => {
      if (daemon.exitCode !== null) throw new Error('Fixture sshd stopped. ' + errors);
      try {
        await exec('ssh', ['-F', client, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', alias, 'true']);
        return true;
      } catch { return false; }
    }, 'Could not authenticate to the disposable loopback sshd');
  } catch (error) {
    daemon.kill();
    throw error;
  }
  return { configPath: client, stop() { daemon.kill(); daemon.stderr.destroy(); } };
}
