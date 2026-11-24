interface PrivateTmuxOptions {
  name?: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
}

interface PrivateTmux {
  dir: string;
  socket: string;
  env: NodeJS.ProcessEnv;
  exists(): boolean;
  args(...command: string[]): string[];
  tmux(...command: string[]): string;
  kill(): void;
  killAll(): void;
  cleanup(): void;
}

export function privateTmux(directory: string, options?: PrivateTmuxOptions): PrivateTmux;
export function createPrivateTmux(directory: string, options?: PrivateTmuxOptions): PrivateTmux;
