import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../shared/types';
import { validateWorkspace } from '../backend/transport';
import { t } from '../shared/i18n';

/** Only connection/directory preferences. Transcripts never go in this store. */
export class WorkspaceStore {
  private items: Workspace[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    try {
      const content = JSON.parse(await readFile(path.join(this.directory, 'workspaces.json'), 'utf8'));
      if (!Array.isArray(content)) throw new Error(t('main.workspaceConfigInvalid'));
      this.items = content.map(item => {
        const { id, name, kind, cwd, host, port, historyScan } = validateWorkspace(item);
        return { id, name, kind, cwd, host, port, ...(historyScan === false && { historyScan }) };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  list(): Workspace[] { return structuredClone(this.items); }
  get(id: string): Workspace {
    const item = this.items.find(item => item.id === id);
    if (!item) throw new Error(t('main.workspaceMissing'));
    return structuredClone(item);
  }
  async save(workspace: Workspace): Promise<Workspace> {
    const at = this.items.findIndex(item => item.id === workspace.id);
    if (at < 0) this.items.push(structuredClone(workspace));
    else this.items[at] = structuredClone(workspace);
    await this.persist();
    return structuredClone(workspace);
  }
  async remove(id: string): Promise<void> {
    this.items = this.items.filter(item => item.id !== id);
    await this.persist();
  }
  private persist(): Promise<void> {
    const contents = JSON.stringify(this.items, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, 'workspaces.json');
      await writeFile(`${file}.tmp`, contents, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return this.writes;
  }
}
