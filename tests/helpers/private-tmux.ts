import { mkdtempSync } from 'node:fs';
import { createPrivateTmux } from '../../scripts/fixtures/private-tmux.mjs';

/** Backend still selects its socket by label, using the test process's environment. */
export function isolateTmux(name: string, env = process.env) {
  // A short path leaves room for the socket name on macOS.
  const fixture = createPrivateTmux(mkdtempSync('/tmp/lt-tmux-'), { name, env });
  const keys = ['TMUX_TMPDIR', 'TMUX', 'TMUX_PANE'] as const;
  const previous = keys.map(key => process.env[key]);
  process.env.TMUX_TMPDIR = fixture.dir;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  return {
    ...fixture,
    cleanup() {
      try { fixture.cleanup(); }
      finally {
        keys.forEach((key, index) => {
          const value = previous[index];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        });
      }
    },
  };
}
