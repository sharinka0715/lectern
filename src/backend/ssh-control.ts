import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { diagnostic } from '../diagnostics';

export const ownerFile = 'owner.pid';
export interface SshControlDirectory { path: string; persistent: boolean }

export async function privateSshDirectory(root: string, userData?: string): Promise<SshControlDirectory> {
  if (userData) {
    const uid = process.getuid?.();
    const profile = createHash('sha256').update(resolve(userData)).digest('hex').slice(0, 16);
    const path = join(root, `lssh-${uid}-${profile}`);
    try {
      // OpenSSH adds a dot and 16 random bytes to the 40-byte %C while binding.
      if (Buffer.byteLength(join(path, 'x'.repeat(57))) >= 104) throw new Error('socket path too long');
      await mkdir(path, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(path);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) throw new Error('unsafe directory');
      return { path, persistent: true };
    } catch (error) {
      diagnostic.event('transport.ssh.persistence_unavailable', { reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message }, 'warn');
    }
  }
  const path = await mkdtemp(join(root, 'lectern-ssh-'));
  await writeFile(join(path, ownerFile), String(process.pid), { mode: 0o600 });
  return { path, persistent: false };
}

export async function sshControlSockets(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isSocket() && /^[0-9a-f]{40}$/.test(entry.name))
    .map(entry => join(directory, entry.name));
}
