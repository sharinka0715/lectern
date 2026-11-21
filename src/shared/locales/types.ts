/** One message: Simplified Chinese first, then English. Both are required. */
export type Entry = readonly [zh: string, en: string];
export type Namespace = Record<string, Entry>;
