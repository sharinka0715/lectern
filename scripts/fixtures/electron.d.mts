import type { ElectronApplication } from 'playwright';

export const RETRIES: number;
/** Guards `screenshot` of this page and of its locators (through their shared prototypes). */
export function guardScreenshots<P extends object>(page: P): P;
export const _electron: { launch(options?: Parameters<typeof import('playwright')._electron.launch>[0]): Promise<ElectronApplication> };
