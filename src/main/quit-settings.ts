// "设置 → 会话 → 退出时仍有对话在运行", kept in userData/quit-settings.json. The main
// process reads it when quitting, also when no window is open (macOS).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultQuitPreferences, type QuitPreferences } from '../shared/quit';

export function validQuitPreferences(value: unknown): QuitPreferences {
  const whenRunning = (value as QuitPreferences | undefined)?.whenRunning;
  if (whenRunning !== 'ask' && whenRunning !== 'leave') throw new Error('Invalid quit preference');
  return { whenRunning };
}

export class QuitSettings {
  private value?: QuitPreferences;
  private write: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async get(): Promise<QuitPreferences> {
    if (!this.value) {
      try { this.value = validQuitPreferences(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch { this.value ??= { ...defaultQuitPreferences }; }
    }
    return { ...this.value };
  }

  async set(next: unknown): Promise<QuitPreferences> {
    const value = validQuitPreferences(next);
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
