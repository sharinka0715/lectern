export function waitUntil<T>(predicate: () => T | Promise<T>, message: string, timeout?: number): Promise<NonNullable<T>>;
export function startLoopback(options: {
  root: string;
  env: NodeJS.ProcessEnv;
  alias: string;
  aliases?: string[];
  ssh?: string;
}): Promise<{ configPath: string; stop(): void }>;
