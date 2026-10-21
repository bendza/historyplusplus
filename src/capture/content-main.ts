// Content script logic: visible-dwell tracking, text capture after min dwell, SPA re-capture.
import { browser } from 'wxt/browser';
import type { BgMessage, Settings } from '../shared/protocol';
import { isUrlAllowed } from '../shared/privacy';
import { extractText, hasSensitiveFields } from './extract';
import { loadSettings, onSettingsChanged } from './settings';
import { pageKey } from './spa';

const MIN_DWELL_REPORT_MS = 500;
const URL_POLL_MS = 1000;

export async function startContentCapture(): Promise<void> {
  let settings: Settings = await loadSettings();
  let url = location.href;
  let key = pageKey(url);
  let visibleSince: number | null = document.visibilityState === 'visible' ? performance.now() : null;
  let visibleMs = 0; // total visible time on the current URL
  let unreportedMs = 0; // visible time not yet sent as dwell
  let captured = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dead = false;

  const enabled = () => !settings.paused && isUrlAllowed(url, settings);

  const send = (msg: BgMessage) => {
    if (dead) return;
    try {
      browser.runtime.sendMessage(msg).catch((e: unknown) => {
        if (String((e as Error)?.message ?? e).includes('context invalidated')) shutdown();
      });
    } catch {
      shutdown(); // extension was reloaded; this script is orphaned
    }
  };

  const accrue = () => {
    if (visibleSince === null) return;
    const t = performance.now();
    const d = t - visibleSince;
    visibleMs += d;
    unreportedMs += d;
    visibleSince = document.visibilityState === 'visible' ? t : null;
  };

  const flushDwell = () => {
    accrue();
    if (unreportedMs >= MIN_DWELL_REPORT_MS && enabled()) {
      send({ to: 'bg', kind: 'dwell', url, dwellMs: Math.round(unreportedMs) });
    }
    unreportedMs = 0;
  };

  const capture = () => {
    if (captured || !enabled() || !settings.captureText) return;
    captured = true;
    const title = document.title || '';
    // Sensitive pages (password / card fields) keep their visit but never their text. Still send
    // the title (with empty text, which the engine treats as a title-only update), or the visit,
    // recorded before the page had a title, stays untitled forever.
    if (hasSensitiveFields(document)) {
      if (title) send({ to: 'bg', kind: 'capture', url, title, text: '', lang: null, ts: Date.now() });
      return;
    }
    const { text, lang } = extractText(document);
    if (!text) return;
    send({ to: 'bg', kind: 'capture', url, title, text, lang, ts: Date.now() });
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (captured || visibleSince === null || !enabled() || !settings.captureText) return;
    accrue();
    const remaining = Math.max(0, settings.minDwellMs - visibleMs);
    timer = setTimeout(() => {
      safe(() => {
        accrue();
        if (visibleMs + 50 >= settings.minDwellMs) capture();
        else schedule();
      });
    }, remaining);
  };

  const checkUrl = () => {
    const href = location.href;
    if (href === url) return;
    const newKey = pageKey(href);
    if (newKey === key) {
      url = href; // anchor jump on the same page
      return;
    }
    flushDwell(); // attributes dwell to the old URL
    url = href;
    key = newKey;
    visibleMs = 0;
    unreportedMs = 0;
    captured = false;
    schedule();
  };

  const onVisibility = () =>
    safe(() => {
      if (document.visibilityState === 'visible') {
        if (visibleSince === null) visibleSince = performance.now();
        schedule();
      } else {
        flushDwell();
        visibleSince = null;
        clearTimeout(timer);
      }
    });
  const onPageHide = () => safe(() => flushDwell());
  const onPageShow = (e: PageTransitionEvent) =>
    safe(() => {
      if (e.persisted && document.visibilityState === 'visible') {
        visibleSince = performance.now();
        schedule();
      }
    });
  const onMessage = (msg: unknown) => {
    if ((msg as { kind?: string })?.kind === 'spa-nav') safe(checkUrl);
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  browser.runtime.onMessage.addListener(onMessage);
  const poll = setInterval(() => safe(checkUrl), URL_POLL_MS);
  onSettingsChanged((s) =>
    safe(() => {
      settings = s;
      schedule();
    }),
  );

  function shutdown() {
    dead = true;
    clearTimeout(timer);
    clearInterval(poll);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    try {
      browser.runtime.onMessage.removeListener(onMessage);
    } catch {
      // ignore
    }
  }

  schedule();
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // never throw into the page
  }
}
