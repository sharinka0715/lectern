import { randomUUID } from 'node:crypto';
import type { NativeStatusLineObservation, SessionSettingKind, SessionSettingOption, SessionSettingSnapshot, SessionSettingsState } from '../shared/types';
import { settingKinds, type CatalogEntry } from './model-catalogs';
import { EFFORT_LEVELS, type EffortLevel, type ModelCatalog } from '../shared/model-catalog';
import type { SessionSettingsDiskStore, VerifiedSelections } from './session-settings-disk-store';
import { t } from '../shared/i18n';

export interface SessionSettingsHandle {
  readonly targetKey: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly panePid?: number;
  readonly instanceId?: string;
}

type Selection = Pick<SessionSettingOption, 'label' | 'description'>;
interface Entry {
  handle: SessionSettingsHandle;
  observed: VerifiedSelections;
  tokens: Record<SessionSettingKind, string>;
  receipts: Partial<Record<SessionSettingKind, Pick<SessionSettingSnapshot, 'nativeFeedback' | 'detail'>>>;
  /** Session-only and in memory: a new process starts with Ultracode off. */
  ultracode?: boolean;
}

function selected(menu: SessionSettingSnapshot): Selection | undefined {
  if (!menu.complete || !menu.currentOptionId) return;
  const current = menu.options.filter(option => option.current);
  if (current.length !== 1 || current[0].id !== menu.currentOptionId) return;
  const { label, description } = current[0];
  return { label, description };
}

const withoutContext = (model: string) => model.replace(/\[1m\]$/i, '');

/** The model row this session runs: a selection Lectern verified, else the
 * status line's model by exact value, display name, then resolved ID. Ambiguous
 * matches (the default row and its alias resolve alike) mark nothing. */
export function currentModelIndex(catalog: ModelCatalog, selection?: Selection, line?: NativeStatusLineObservation): number | undefined {
  const unique = (matches: number[]) => matches.length === 1 ? matches[0] : undefined;
  const rows = catalog.models.map((row, index) => ({ row, index }));
  if (selection) return unique(rows.filter(({ row }) => row.label === selection.label && row.description === selection.description).map(({ index }) => index));
  if (!line?.modelId && !line?.modelName) return;
  for (const test of [
    ({ row }: typeof rows[number]) => !!line.modelId && row.value === line.modelId,
    ({ row }: typeof rows[number]) => !!line.modelName && row.label === line.modelName,
    ({ row }: typeof rows[number]) => !!line.modelId && row.value !== 'default' && !!row.resolvedModel && withoutContext(row.resolvedModel) === withoutContext(line.modelId),
  ]) {
    const matches = rows.filter(test).map(({ index }) => index);
    if (matches.length) return unique(matches);
  }
}

/** The effort rows for a model row, or every level some model accepts when the
 * session's model is not known (the native receipt still refuses a wrong one). */
export function effortLevels(catalog: ModelCatalog, modelIndex?: number): EffortLevel[] {
  if (modelIndex !== undefined) return catalog.models[modelIndex].efforts;
  return EFFORT_LEVELS.filter(level => catalog.models.some(row => row.efforts.includes(level)));
}

/** Keeps verified business selections and GUI choice handles scoped to the
 * exact target, conversation and pane instance. Candidate rows live elsewhere. */
export class SessionSettingsCache {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly disk?: SessionSettingsDiskStore) {}

  private key(targetKey: string, sessionId: string): string {
    return JSON.stringify([targetKey, sessionId]);
  }
  private entry(handle: SessionSettingsHandle): Entry | undefined {
    const entry = this.entries.get(this.key(handle.targetKey, handle.sessionId));
    return entry?.handle === handle ? entry : undefined;
  }

  observe(targetKey: string, sessionId: string, paneId?: string, active = true, panePid?: number, instanceId?: string): SessionSettingsHandle | undefined {
    if (this.disposed) return;
    const key = this.key(targetKey, sessionId);
    const previous = this.entries.get(key);
    if (!active || !paneId) {
      this.disk?.remove(targetKey, sessionId);
      this.entries.delete(key);
      return;
    }
    const samePane = previous?.handle.paneId === paneId && previous.handle.panePid === panePid;
    if (samePane && previous.handle.instanceId === instanceId) return previous.handle;
    // A preliminary poll with no process identity can precede one with exact
    // proof. A provisional selection must never transfer to a proven instance.
    const provisional = samePane && !previous.handle.instanceId && !previous.observed.model && !previous.observed.effort;
    if (previous && !provisional) this.disk?.remove(targetKey, sessionId);
    const handle = Object.freeze({ targetKey, sessionId, paneId, panePid, instanceId });
    this.entries.set(key, { handle, observed: this.disk?.read(handle) ?? {}, receipts: {}, tokens: { model: randomUUID(), effort: randomUUID() } });
    return handle;
  }

  /** Both menus for this session, built from the machine's model list. The option
   * IDs come from the list's entry and stay stable; the token belongs to the session. */
  state(handle: SessionSettingsHandle, source?: CatalogEntry, line?: NativeStatusLineObservation): SessionSettingsState | undefined {
    const entry = this.entry(handle);
    if (!entry) return;
    const catalog = source?.catalog;
    const menus: SessionSettingsState['menus'] = {};
    if (catalog && source) {
      const live = line?.sessionId === handle.sessionId ? line : undefined;
      const reported = (kind: SessionSettingKind) => kind === 'model' ? live?.modelId : live?.effort;
      // Disk observations may predate an external change while Lectern was
      // closed. A just-verified native write, however, can precede its callback.
      const selection = (kind: SessionSettingKind) => entry.receipts[kind] || !reported(kind) ? entry.observed[kind] : undefined;
      const modelIndex = currentModelIndex(catalog, selection('model'), live);
      const modelOptions = catalog.models.map((row, index) => ({ id: source.rowIds[index], label: row.label, description: row.description, current: index === modelIndex }));
      const levels = effortLevels(catalog, modelIndex);
      const effortSelection = selection('effort');
      const effortCurrent = effortSelection ? levels.filter(level => level === effortSelection.label)
        : live?.effort ? levels.filter(level => level === live.effort!.toLowerCase()) : [];
      const effortOptions = levels.map(level => ({ id: source.effortIds[level], label: level, current: effortCurrent.length === 1 && effortCurrent[0] === level }));
      const common = { source: 'catalog' as const, sessionId: handle.sessionId, paneId: handle.paneId, observedAt: catalog.observedAt, complete: true };
      menus.model = { ...common, kind: 'model', token: entry.tokens.model, command: '/model', options: modelOptions,
        currentOptionId: modelOptions.find(option => option.current)?.id, ...entry.receipts.model };
      menus.effort = { ...common, kind: 'effort', token: entry.tokens.effort, command: '/effort', options: effortOptions,
        currentOptionId: effortOptions.find(option => option.current)?.id,
        ...(catalog.defaults.ultracodeAvailable !== undefined && { ultracodeAvailable: catalog.defaults.ultracodeAvailable }),
        ...(!levels.length && { detail: t('main.noEffortLevels') }), ...entry.receipts.effort };
    }
    const error = !catalog ? source?.error : undefined;
    return {
      initialization: source?.loading && !catalog ? 'loading' : error ? 'failed' : catalog ? 'ready' : 'pending',
      menus,
      ...(entry.observed.model || entry.observed.effort ? { observed: { ...entry.observed } } : {}),
      ...(entry.ultracode !== undefined ? { ultracode: entry.ultracode } : {}),
      ...(error ? { error, errors: { model: error, effort: error } } : {}),
      ...(catalog?.version ? { cliVersion: catalog.version } : {}),
    };
  }

  private persist(entry: Entry): void {
    if (!this.disk || !entry.handle.instanceId) return;
    const { model, effort } = entry.observed;
    if (model || effort) this.disk.write(entry.handle, { model, effort });
    else this.disk.remove(entry.handle.targetKey, entry.handle.sessionId);
  }

  rememberApplied(handle: SessionSettingsHandle, menu: SessionSettingSnapshot): boolean {
    const entry = this.entry(handle);
    if (!entry) return false;
    if (!settingKinds.includes(menu.kind) || menu.sessionId !== handle.sessionId || menu.paneId !== handle.paneId)
      throw new Error(t('main.settingResultForeign'));
    entry.observed[menu.kind] = selected(menu);
    entry.receipts[menu.kind] = { detail: menu.detail, nativeFeedback: menu.nativeFeedback };
    if (menu.kind === 'model') delete entry.observed.effort;
    this.persist(entry);
    return true;
  }

  /** A verified switch or an unambiguous composer border. */
  rememberUltracode(handle: SessionSettingsHandle, on: boolean): boolean {
    const entry = this.entry(handle);
    if (!entry) return false;
    const changed = entry.ultracode !== on;
    entry.ultracode = on;
    return changed;
  }

  /** Rotate selection handles before a write, ownership handoff, or external
   * change. The machine's model list survives all three. */
  invalidateSelection(handle: SessionSettingsHandle, kind: SessionSettingKind): void {
    const entry = this.entry(handle);
    if (!entry) return;
    for (const affected of kind === 'model' ? settingKinds : [kind]) {
      delete entry.observed[affected];
      delete entry.receipts[affected];
      entry.tokens[affected] = randomUUID();
    }
    if (handle.instanceId) this.persist(entry);
    else this.disk?.remove(handle.targetKey, handle.sessionId);
  }

  invalidate(handle: SessionSettingsHandle): void {
    if (this.entry(handle)) {
      this.disk?.remove(handle.targetKey, handle.sessionId);
      this.entries.delete(this.key(handle.targetKey, handle.sessionId));
    }
  }
  invalidateTarget(targetKey: string): void {
    this.disk?.removeTarget(targetKey);
    for (const [key, entry] of this.entries) {
      if (entry.handle.targetKey === targetKey) this.entries.delete(key);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }
}
