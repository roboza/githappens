import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages ship TypeScript source, so they are bundled rather than externalized.
const bundleWorkspace = {
  exclude: ['@githappens/git', '@githappens/providers', '@githappens/launchpad', '@githappens/cloud-api'],
};

export default defineConfig({
  main: {
    build: { externalizeDeps: bundleWorkspace },
  },
  preload: {
    build: { externalizeDeps: bundleWorkspace },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
