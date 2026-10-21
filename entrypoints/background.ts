import { registerBackground } from '../src/capture/background-main';

export default defineBackground({
  // Firefox (MV2): keep the page alive (it hosts the engine workers) and build it as ESM. The IIFE
  // (lib-mode) build inlines sqlite3.wasm as a data: URL, which CSP connect-src rightly blocks.
  // Both are ignored for the Chromium service worker.
  persistent: true,
  type: { firefox: 'module' },
  main() {
    registerBackground();
  },
});
