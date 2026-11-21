import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Backend } from '../backend';
import { diagnostic, errorDetails } from '../diagnostics';
import { EFFORT_LEVELS, type EffortLevel, type ModelCatalog, type ModelCatalogState } from '../shared/model-catalog';
import type { Workspace } from '../shared/types';
import { t } from '../shared/i18n';

export const settingKinds = ['model', 'effort'] as const;

/** A machine's model list plus option IDs that stay the same while the app runs,
 * so a menu the renderer holds still names the same row when it is clicked. */
export interface CatalogEntry {
  catalog?: ModelCatalog;
  error?: string;
  loading?: Promise<ModelCatalog>;
  /** Bumped when launch preferences change, so a read started before is redone. */
  generation: number;
  rowIds: string[];
  effortIds: Record<EffortLevel, string>;
}

/** One configuration of Claude Code on one machine: the endpoint, plus the
 * folder's explicit CLAUDE_CONFIG_DIR (another account or settings). */
export function catalogKey(workspace: Workspace): string {
  return JSON.stringify([workspace.kind, workspace.kind === 'ssh' ? workspace.host : null, workspace.kind === 'ssh' ? workspace.port ?? null : null,
    workspace.claudeDir ?? null]);
}

/** Model and effort lists read once per machine and configuration through the
 * SDK probe (no tmux pane), on startup or the first successful connection, and
 * kept until the app quits. A failed read is retried only when asked again. */
export class ModelCatalogs extends EventEmitter {
  private readonly entries = new Map<string, CatalogEntry>();
  private closed = false;

  constructor(private readonly backend: Pick<Backend, 'probeModelCatalog'>) { super(); }

  private entry(workspace: Workspace): CatalogEntry {
    const key = catalogKey(workspace);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { generation: 0, rowIds: [], effortIds: Object.fromEntries(EFFORT_LEVELS.map(level => [level, randomUUID()])) as Record<EffortLevel, string> };
      this.entries.set(key, entry);
    }
    return entry;
  }

  get(workspace: Workspace): CatalogEntry | undefined {
    return this.entries.get(catalogKey(workspace));
  }

  state(workspace: Workspace): ModelCatalogState {
    const entry = this.get(workspace);
    if (entry?.catalog) return { status: 'ready', catalog: entry.catalog };
    if (entry?.error && !entry.loading) return { status: 'failed', error: entry.error };
    return { status: 'loading' };
  }

  isChangeFor(workspace: Workspace, changed: unknown): boolean {
    return changed === this.get(workspace);
  }

  /** The cached list, or one probe shared by every concurrent caller. */
  read(workspace: Workspace): Promise<ModelCatalog> {
    if (this.closed) return Promise.reject(new Error(t('main.appQuitting')));
    const entry = this.entry(workspace);
    if (entry.catalog) return Promise.resolve(entry.catalog);
    if (entry.loading) return entry.loading;
    const loading = this.probe(workspace, entry).finally(() => {
      entry.loading = undefined;
      if (!this.closed) this.emit('change', entry);
    });
    entry.loading = loading;
    this.emit('change', entry);
    return loading;
  }

  /** One probe; if launch preferences changed while it ran (a list read with
   * the old dynamic-workflows setting), it reads again before anyone sees it. */
  private probe(workspace: Workspace, entry: CatalogEntry): Promise<ModelCatalog> {
    const generation = entry.generation;
    return Promise.resolve().then(() => this.backend.probeModelCatalog(workspace)).then(catalog => {
      if (this.closed) throw new Error(t('main.appQuitting'));
      if (entry.generation !== generation) return this.probe(workspace, entry);
      entry.catalog = catalog;
      entry.error = undefined;
      // Rows keep their IDs if the same list is read again (a configuration change).
      entry.rowIds = catalog.models.map((_, index) => entry.rowIds[index] ?? randomUUID());
      return catalog;
    }, error => {
      if (!this.closed && entry.generation !== generation) return this.probe(workspace, entry);
      entry.error = error instanceof Error ? error.message : String(error);
      diagnostic.event('settings.model_catalog.failed', { workspaceId: workspace.id, error: errorDetails(error) }, 'warn');
      throw error;
    });
  }

  /** Read in the background unless a list is cached, loading, or failed before. */
  warm(workspace: Workspace): void {
    const entry = this.get(workspace);
    if (this.closed || entry?.catalog || entry?.loading || entry?.error) return;
    void this.read(workspace).catch(() => {});
  }

  /** Launch preferences changed (dynamic workflows): read again, keeping row IDs.
   * A read in flight is redone with the new preferences. */
  refreshAll(): void {
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      entry.catalog = undefined;
      entry.error = undefined;
      this.emit('change', entry);
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.removeAllListeners();
    await Promise.allSettled([...this.entries.values()].map(entry => entry.loading));
    this.entries.clear();
  }
}
