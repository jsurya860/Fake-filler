import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import webExtension from 'vite-plugin-web-extension';
import { resolve } from 'path';
import { cpSync } from 'fs';

export default defineConfig({
  plugins: [
    react(),
    webExtension({
      manifest: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('./package.json');
        const manifest = require('./manifest.json');
        return { ...manifest, version: pkg.version };
      },
      disableAutoLaunch: true,
      additionalInputs: [
        'src/popup/index.html',
        'icons/icon16.png',
        'icons/icon48.png',
        'icons/icon128.png',
      ],
    }),
    {
      name: 'copy-icons',
      closeBundle() {
        cpSync(resolve(__dirname, 'icons'), resolve(__dirname, 'dist/icons'), { recursive: true });
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    minify: true,
    sourcemap: false,
  },
});
