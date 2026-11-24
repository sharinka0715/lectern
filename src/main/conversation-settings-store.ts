import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { conversationSettingsKey, type ConversationSettingsRecord } from '../shared/conversation-settings';
import type { WorkspaceEndpoint } from '../shared/types';

export class ConversationSettingsStore {
  private records = new Map<string, ConversationSettingsRecord>();
  private writes = Promise.resolve();
  constructor(private readonly directory: string) {}

  async load() {
    const text = await readFile(path.join(this.directory, 'conversation-settings.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return '{}';
    });
    const entries: Record<string, unknown> = JSON.parse(text);
    for (const [key, value] of Object.entries(entries)) {
      if (!value || typeof value !== 'object' || !('settingsFile' in value)) continue;
      const { settingsFile } = value;
      if (settingsFile === null || typeof settingsFile === 'string') this.records.set(key, { settingsFile });
    }
  }

  get(target: WorkspaceEndpoint, sessionId: string): ConversationSettingsRecord | undefined {
    const record = this.records.get(conversationSettingsKey(target, sessionId));
    return record && { ...record };
  }

  save(target: WorkspaceEndpoint, sessionId: string, settingsFile: string | null, inherit = false): Promise<void> {
    const key = conversationSettingsKey(target, sessionId);
    const save = this.writes.catch(() => {}).then(async () => {
      if (inherit && this.records.has(key)) return;
      const next = new Map(this.records);
      next.set(key, { settingsFile });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, 'conversation-settings.json');
      await writeFile(file + '.tmp', JSON.stringify(Object.fromEntries(next), null, 2), { mode: 0o600 });
      await rename(file + '.tmp', file);
      this.records = next;
    });
    this.writes = save;
    return save;
  }
}
