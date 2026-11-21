import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { context } from 'esbuild';
import electron from 'electron';
const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
const ctx = await context({
  entryPoints: { index: 'src/main/index.ts', preload: 'src/main/preload.ts' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outdir: 'dist/main', outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: true,
});
await ctx.rebuild();
await ctx.watch();
const env = { ...process.env, LECTERN_DEV_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', async code => { await server.close(); await ctx.dispose(); process.exit(code ?? 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
