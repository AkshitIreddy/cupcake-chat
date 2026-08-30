import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  clearScreen: false,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 42619,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    sourcemap: true,
    target: 'chrome132',
  },
});
