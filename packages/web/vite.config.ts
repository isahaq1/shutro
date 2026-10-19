/**
 * The web client build. `pnpm dev` proxies /api to a running `shutro serve` (SHUTRO_API, default port 8069);
 * `pnpm build` writes dist/, which `@shutro/server` serves.
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['@shutro/source'] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env['SHUTRO_API'] ?? 'http://127.0.0.1:8069', changeOrigin: false },
    },
  },
  build: { target: 'es2023', sourcemap: false, chunkSizeWarningLimit: 900 },
});
