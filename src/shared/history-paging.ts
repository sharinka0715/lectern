export const DEFAULT_HISTORY_PAGE_MIB = 3;
export const MIN_HISTORY_PAGE_MIB = 0.125;
export const MAX_HISTORY_PAGE_MIB = 32;

export function historyPageSizeMiB(value?: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_HISTORY_PAGE_MIB && value <= MAX_HISTORY_PAGE_MIB
    ? value : DEFAULT_HISTORY_PAGE_MIB;
}
