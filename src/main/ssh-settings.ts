// The main process reads userData/ssh-settings.json before opening any SSH connection.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultSshConnectionPreferences, sshKeepAliveChoices, type SshConnectionPreferences } from '../shared/ssh-connections';

export function validSshConnectionPreferences(value: unknown): SshConnectionPreferences {
  const { reuseConnections, keepAliveSeconds = defaultSshConnectionPreferences.keepAliveSeconds } =
    (value ?? {}) as Partial<SshConnectionPreferences>;
  if (typeof reuseConnections !== 'boolean') throw new Error('Invalid SSH connection preference');
  if (!sshKeepAliveChoices.includes(keepAliveSeconds)) throw new Error('Invalid SSH persistence duration');
  return { reuseConnections, keepAliveSeconds };
}

export class SshSettings {
  private value?: SshConnectionPreferences;
  private write: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async get(): Promise<SshConnectionPreferences> {
    if (!this.value) {
      try { this.value = validSshConnectionPreferences(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch { this.value ??= { ...defaultSshConnectionPreferences }; }
    }
    return { ...this.value };
  }

  async set(next: unknown): Promise<SshConnectionPreferences> {
    const value = validSshConnectionPreferences(next);
    const content = JSON.stringify(value, null, 2);
    this.write = this.write.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file + '.tmp', content, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
      this.value = value;
    });
    await this.write;
    return { ...value };
  }

  /** Pending writes are on disk (shutdown). */
  flush(): Promise<void> { return this.write.catch(() => {}); }
}
