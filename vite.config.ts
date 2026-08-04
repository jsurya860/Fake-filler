import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import webExtension from 'vite-plugin-web-extension';
import { resolve } from 'path';
import { cpSync } from 'fs';

// TARGET_BROWSER selects the manifest shape and output directory:
//   npm run build          -> chrome (default), dist/
//   npm run build:firefox  -> firefox, dist-firefox/
const TARGET_BROWSER = process.env.TARGET_BROWSER === 'firefox' ? 'firefox' : 'chrome';
const outDir = TARGET_BROWSER === 'firefox' ? 'dist-firefox' : 'dist';

export default defineConfig({
  plugins: [
    react(),
    webExtension({
      manifest: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('./package.json');
        const manifest = require('./manifest.json');
        const merged = { ...manifest, version: pkg.version };

        if (TARGET_BROWSER === 'firefox') {
          // Chrome MV3 only understands `background.service_worker`. Firefox's
          // MV3 support for that exact key has varied by version; the
          // `scripts` + `type: "module"` form is Mozilla's consistently
          // documented cross-version path, so swap it in for this target.
          const { service_worker: backgroundEntry, ...restBackground } = merged.background;
          merged.background = { ...restBackground, scripts: [backgroundEntry] };
          // Chrome-only key — meaningless (and unvalidated) on Firefox.
          delete merged.minimum_chrome_version;
          // Required for Firefox to accept an MV3 extension / sign it via
          // AMO. strict_min_version is set high enough to cover the
          // `"world": "MAIN"` content-script entry (used by the API-error
          // interceptor), which Firefox only gained support for in more
          // recent releases — replace this placeholder gecko id with a
          // real reverse-domain identifier before publishing to AMO.
          merged.browser_specific_settings = {
            gecko: {
              id: 'fake-data-filler-pro@example.com',
              strict_min_version: '128.0',
            },
          };
        }

        return merged;
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
        cpSync(resolve(__dirname, 'icons'), resolve(__dirname, `${outDir}/icons`), { recursive: true });
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'esnext',
    minify: true,
    sourcemap: false,
  },
});
