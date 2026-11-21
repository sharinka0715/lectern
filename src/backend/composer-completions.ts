import type { ChatView, CompletionItem, CompletionQuery, Workspace } from '../shared/types';
import { readCommandCatalog } from './completion-catalog';
import { matchingCommands } from '../shared/completion-commands';
import type { WorkspaceArtifacts } from './artifacts';
import { validateWorkspace, type Transport } from './transport';
import { t } from '../shared/i18n';
import type { FileIndex } from './file-index';

/** Only two live requests (one per split). File names come from a bounded in-memory
 * index per workspace folder (file-index.ts), built when a conversation opens. */
export class ComposerCompletions {
  private active = new Map<ChatView, { request: string; controller: AbortController; workspace: string }>();
  private catalogs = new Map<string, { key: string; items: CompletionItem[]; until: number }>();
  constructor(private transport: Transport, private files: Pick<WorkspaceArtifacts, 'complete'> & { fileIndex?: Pick<FileIndex, 'prefetch' | 'reset' | 'subscribe'> }) {}

  /** A conversation in this workspace was opened: index its working directory in the background. */
  prefetchFiles(ws: Workspace) { validateWorkspace(ws); this.files.fileIndex?.prefetch(ws); }
  /** Called with the workspace ID whenever a scan lands, so an open `@` list can refresh. */
  onFilesUpdated(listener: (workspaceId: string) => void): () => void { return this.files.fileIndex?.subscribe(listener) ?? (() => {}); }

  cancel(view: ChatView, request: string) {
    const slot = this.active.get(view);
    if (slot?.request === request) { this.active.delete(view); slot.controller.abort(); }
  }
  reset(id?: string) {
    for (const [view, slot] of this.active) if (!id || id === slot.workspace) this.cancel(view, slot.request);
    if (id) this.catalogs.delete(id); else this.catalogs.clear();
    this.files.fileIndex?.reset(id);
  }
  /** Whether a slash name is one of the machine's installed skills or custom commands. */
  async isInstalled(ws: Workspace, name: string, isolated = false): Promise<boolean> {
    validateWorkspace(ws);
    const key = JSON.stringify([ws, isolated]);
    let cached = this.catalogs.get(ws.id);
    if (!cached || cached.until < Date.now() || cached.key !== key) {
      const items = await readCommandCatalog(this.transport, ws, new AbortController().signal, isolated);
      cached = { key, items, until: Date.now() + 20_000 };
      if (this.catalogs.size >= 32) this.catalogs.delete(this.catalogs.keys().next().value!);
      this.catalogs.set(ws.id, cached);
    }
    const wanted = name.toLowerCase();
    return cached.items.some(item => item.value.toLowerCase() === wanted);
  }
  async query(ws: Workspace, view: ChatView, request: string, query: CompletionQuery, isolated = false): Promise<CompletionItem[]> {
    validateWorkspace(ws);
    if (!(view === 'primary' || view === 'secondary') || typeof request !== 'string' || !/^[\w-]{1,80}$/.test(request) ||
      !query || (query.kind !== 'slash' && query.kind !== 'mention') || typeof query.prefix !== 'string' || query.prefix.length > 1024 || /[\x00-\x1f\x7f]/.test(query.prefix)) throw new Error(t('backend.invalidCompletion'));
    const old = this.active.get(view);
    if (old) this.cancel(view, old.request);
    const controller = new AbortController(), { signal } = controller;
    this.active.set(view, { request, workspace: ws.id, controller });
    try {
      if (query.kind === 'mention') {
        const results = await this.files.complete(ws, query.prefix, signal);
        return signal.aborted ? [] : results;
      }
      const key = JSON.stringify([ws, isolated]);
      let cached = this.catalogs.get(ws.id);
      if (!cached || cached.until < Date.now() || cached.key !== key) {
        const catalog = await readCommandCatalog(this.transport, ws, signal, isolated);
        if (signal.aborted) return [];
        cached = { key, items: catalog, until: Date.now() + 20_000 };
        if (this.catalogs.size >= 32) this.catalogs.delete(this.catalogs.keys().next().value!);
        this.catalogs.set(ws.id, cached);
      }
      return matchingCommands(query.prefix, cached.items);
    } catch (error) {
      if (signal.aborted) return [];
      if (query.kind === 'slash') return matchingCommands(query.prefix);
      throw error;
    }
    finally { if (this.active.get(view)?.controller === controller) this.active.delete(view); }
  }
}
