import { build } from 'esbuild';
await build({
  entryPoints: { index: 'src/main/index.ts', preload: 'src/main/preload.ts' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outdir: 'dist/main', outExtension: { '.js': '.cjs' }, external: ['electron'],
  sourcemap: true,
});
