// "设置 → SSH 连接 → 复用已有的 SSH 连接", kept in userData/ssh-settings.json. The main
// process reads it before the backend makes its first SSH connection.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultSshConnectionPreferences, type SshConnectionPreferences } from '../shared/ssh-connections';

export function validSshConnectionPreferences(value: unknown): SshConnectionPreferences {
  const reuseConnections = (value as SshConnectionPreferences | undefined)?.reuseConnections;
  if (typeof reuseConnections !== 'boolean') throw new Error('Invalid SSH connection preference');
  return { reuseConnections };
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
    this.value = value;
    const content = JSON.stringify(value, null, 2);
    this.write = this.write.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file + '.tmp', content, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
    });
    await this.write;
    return { ...value };
  }

  /** Pending writes are on disk (shutdown). */
  flush(): Promise<void> { return this.write.catch(() => {}); }
}
