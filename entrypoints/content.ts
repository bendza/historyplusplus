import { startContentCapture } from '../src/capture/content-main';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    startContentCapture().catch(() => {});
  },
});
