import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), ...(command === 'serve' ? [{
    name: 'local-dev-csp',
    transformIndexHtml: { order: 'post' as const, handler: (html: string) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") },
  }] : [])],
  build: { outDir: 'dist/renderer', emptyOutDir: true },
  server: { host: '127.0.0.1' },
}));
