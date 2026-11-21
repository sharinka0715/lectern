// Reads the model and effort lists from the installed Claude Code, as Lectern
// does: SDK control requests only (initialize, get_settings). No prompt, no
// model request, no transcript, no tmux pane. Optional: --ssh <host> [--port n].
import assert from 'node:assert/strict';
import { Backend } from '../src/backend/index.ts';

const args = process.argv.slice(2), arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const host = arg('--ssh'), port = arg('--port') ? Number(arg('--port')) : undefined;
const workspace = host ? { id: 'model-probe', name: 'Model probe', kind: 'ssh', host, ...(port && { port }), cwd: '~' } : { id: 'model-probe', name: 'Model probe', kind: 'local', cwd: '~' };
const backend = new Backend();
try {
  const started = Date.now();
  const catalog = await backend.probeModelCatalog(workspace);
  assert.ok(catalog.models.length > 0);
  console.log(JSON.stringify({ target: host ?? 'local', ms: Date.now() - started, version: catalog.version, defaults: catalog.defaults,
    models: catalog.models.map(row => `${row.label} [${row.value}] ${row.efforts.join('/') || '-'}`) }, null, 2));
} finally { await backend.dispose(); }
