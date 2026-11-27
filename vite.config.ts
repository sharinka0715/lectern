import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), {
    // Chromium reads WOFF2: KaTeX's WOFF and TrueType copies of each font would only add ~1 MB.
    name: 'katex-woff2-only',
    enforce: 'pre' as const,
    transform: (code: string, id: string) => id.replace(/\\/g, '/').split('?')[0].endsWith('/katex/dist/katex.min.css')
      ? code.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '') : undefined,
  }, ...(command === 'serve' ? [{
    name: 'local-dev-csp',
    transformIndexHtml: { order: 'post' as const, handler: (html: string) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") },
  }] : [])],
  build: { outDir: 'dist/renderer', emptyOutDir: true },
  server: { host: '127.0.0.1' },
}));
