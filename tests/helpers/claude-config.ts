import { afterEach } from 'node:test';

const original = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = original;
});

/** Test files run in separate processes. Local shell fixtures share the test's environment. */
export function fixtureClaudeConfig(directory: string) {
  process.env.CLAUDE_CONFIG_DIR = directory;
}
