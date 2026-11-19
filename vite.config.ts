import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Declared locally so the config type-checks without pulling Node typings into the browser program.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Lets several dev servers run side by side without sharing an optimiser cache.
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  // The race engine runs in a dedicated module worker (src/workers/raceSimulation.worker.ts).
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
