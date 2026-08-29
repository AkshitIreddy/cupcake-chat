import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    sourcemap: true,
    target: 'node20',
    rollupOptions: {
      output: {
        entryFileNames: 'preload.js',
      },
    },
  },
});
