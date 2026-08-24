import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  cacheDir: process.env.NOVUS_VITE_CACHE_DIR ?? 'node_modules/.vite',
  plugins: [react()],
  resolve: {
    alias: {
      '@agent-canvas/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'chrome108',
    sourcemap: false,
  },
});
