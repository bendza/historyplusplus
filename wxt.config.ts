import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'wxt';
import { MODEL_CONNECT_HOSTS } from './src/embed/model-files';

// Local semantic search: the ONNX runtime wasm ships inside the extension; the embedding model is
// downloaded on demand from huggingface.co at a pinned revision (src/embed/model-files.ts) and
// kept in Cache Storage. scripts/fetch-model.sh -> models/ is only for dev/eval and never bundled.
// transformers.js imports `onnxruntime-web/webgpu`, whose runtime is the asyncify build
// (serves both the WebGPU and the plain wasm execution providers).
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs'];

function ortDistDir(): string {
  const req = createRequire(resolve('node_modules/@huggingface/transformers/package.json'));
  // The package exports map hides package.json; the webgpu entry lives in dist/ next to the wasm.
  return dirname(req.resolve('onnxruntime-web/webgpu'));
}

// Toolbar icon sizes (public/icon/*.png, rendered from branding/icon*.svg).
const ACTION_ICONS = { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' };

export default defineConfig({
  srcDir: '.',
  // Same code for Chromium (MV3: service worker + offscreen document hosting the engine) and
  // Firefox (`wxt build -b firefox`, MV2: persistent background page hosting the engine).
  manifest: ({ browser, manifestVersion }) => {
    const firefox = browser === 'firefox';
    // 'wasm-unsafe-eval': sqlite3.wasm (engine worker) and onnxruntime wasm (embed worker).
    // connect-src: extension pages and their workers may reach only the extension itself and the
    // Hugging Face hosts of the one-time model download.
    const csp = `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' ${MODEL_CONNECT_HOSTS.join(' ')}`;
    return {
      name: 'history++',
      description: 'Every page you visit, kept forever on your computer. Find it again by what it was about. Nothing leaves your device.',
      permissions: [
        'history',
        'storage',
        'unlimitedStorage',
        'tabs',
        'webNavigation',
        'alarms',
        'downloads',
        // Chromium only: offscreen engine host, cached favicons (/_favicon/), and
        // downloads.setUiOptions so the daily backup doesn't pop up the downloads bubble.
        ...(firefox ? [] : ['offscreen', 'favicon', 'downloads.ui']),
      ],
      host_permissions: ['<all_urls>'],
      action: {
        default_title: 'history++',
        // Set explicitly: Firefox's toolbar button doesn't fall back to the manifest icons.
        default_icon: ACTION_ICONS,
      },
      commands: {
        [manifestVersion === 2 ? '_execute_browser_action' : '_execute_action']: {
          suggested_key: { default: 'Alt+H', mac: 'Alt+H' },
          description: 'Open history++',
        },
      },
      ...(firefox
        ? {
            content_security_policy: csp,
            browser_specific_settings: {
              gecko: {
                id: 'history-plus-plus@extension',
                strict_min_version: '128.0',
                data_collection_permissions: { required: ['none'] },
              },
            },
          }
        : {
            // Cross-origin isolation for extension pages -> SharedArrayBuffer -> multi-threaded
            // onnxruntime wasm in the embed worker (several x faster indexing).
            cross_origin_embedder_policy: { value: 'require-corp' },
            cross_origin_opener_policy: { value: 'same-origin' },
            content_security_policy: { extension_pages: csp },
          }),
    };
  },
  // Source zip for Firefox add-on review: everything needed to rebuild, nothing private or huge.
  // scripts/eval/ holds queries built from a real browsing history; models/ is the dev copy of
  // the model the extension downloads at runtime; docs/ and branding/store/ aren't build inputs.
  zip: {
    excludeSources: ['models/**', 'scripts/eval/**', 'docs/**', 'branding/store/**', '.output/**'],
  },
  hooks: {
    // WXT's MV2 conversion (Firefox) keeps only title + popup from `action`; restore the icon.
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.manifest_version === 2 && manifest.browser_action) manifest.browser_action.default_icon = ACTION_ICONS;
    },
    // Copy the ONNX runtime wasm + glue from node_modules to /ort/ so it stays in sync with
    // the installed onnxruntime-web version (never the jsDelivr default).
    'build:publicAssets': (_wxt, files) => {
      const dir = ortDistDir();
      for (const f of ORT_FILES) {
        const absoluteSrc = join(dir, f);
        if (!existsSync(absoluteSrc)) throw new Error(`[history++] onnxruntime-web file missing: ${absoluteSrc}`);
        files.push({ absoluteSrc, relativeDest: `ort/${f}` });
      }
    },
  },
  vite: () => ({
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', '@huggingface/transformers', 'onnxruntime-web'] },
    worker: { format: 'es' },
    // Never inline assets as data: URLs. The Firefox (MV2) build otherwise inlined sqlite3.wasm
    // into the engine worker, and the CSP's connect-src (self + model hosts) blocks fetching
    // data: URLs, so the database never started in Firefox.
    build: { assetsInlineLimit: 0 },
  }),
});
