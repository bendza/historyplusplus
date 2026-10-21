// Offscreen document (Chromium): hosts the engine (SQLite worker, embedding worker, model
// download; see src/platform/engine-host.ts) and answers the background's runtime messages.
// Offscreen documents only get chrome.runtime, so settings come from the background and model
// state goes back to it for chrome.storage.
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type EngineRequest, type EngineResponse, type Settings } from '../../src/shared/protocol';
import type { HostMessage, HostReply, ModelStateMessage } from '../../src/platform/host-api';
import { createEngineHost } from '../../src/platform/engine-host';
import { isExtensionContext } from '../../src/shared/sender';

let gotSettings = false;

const host = createEngineHost({
  onModelState: (state, init) => {
    const msg: ModelStateMessage = { to: 'bg', kind: 'modelState', state, init };
    browser.runtime.sendMessage(msg).catch((e: unknown) => console.warn('[history++] modelState report failed', e));
  },
});

function applySettings(s: Settings) {
  gotSettings = true;
  host.settings(s);
}

async function reply<T>(p: Promise<T>): Promise<HostReply<T>> {
  try {
    return { ok: true, result: await p };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// Replies go through sendResponse + `return true`, not a returned Promise: Chromium only
// started honouring Promise returns from onMessage listeners recently (Brave 147 never
// answered), while sendResponse works in every Chromium version.
function answer(msg: unknown): Promise<unknown> | undefined {
  const m = msg as { to?: string; req?: EngineRequest; kind?: HostMessage['kind'] | 'settings'; settings?: Settings; action?: string; url?: string } | null;
  if (!m || m.to !== 'offscreen') return; // not ours: let other listeners answer
  switch (m.kind) {
    case 'settings':
      if (m.settings) applySettings(m.settings);
      return; // no reply expected
    case 'model':
      if (m.action === 'remove') return reply(host.model('remove').then(() => null));
      void host.model('download'); // progress + outcome arrive as modelState messages
      return Promise.resolve({ ok: true, result: null });
    case 'backupBlob':
      return reply(host.backupBlob());
    case 'revokeBlob':
      if (m.url) host.revokeBlob(m.url);
      return Promise.resolve({ ok: true, result: null });
  }
  if (!m.req) return;
  // Results are JSON-safe by contract (exportDb returns base64, not a Uint8Array).
  return host.engine(m.req) as Promise<EngineResponse>;
}

const extensionBase = (browser.runtime.getURL as (p: string) => string)('/');

browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Only the background talks to the engine directly; tabs (incl. content scripts) go through it.
  if (!isExtensionContext(sender, browser.runtime.id, extensionBase)) return;
  const p = answer(msg);
  if (!p) return; // not ours, or no reply expected
  p.then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }));
  return true; // keep the channel open for the async reply
});

async function initSettings() {
  for (let attempt = 0; attempt < 5 && !gotSettings; attempt++) {
    try {
      const s = (await browser.runtime.sendMessage({ to: 'bg', kind: 'getSettings' })) as Settings | undefined;
      if (s && typeof s === 'object' && 'semanticSearch' in s) {
        if (!gotSettings) applySettings(s); // a pushed update may have arrived meanwhile
        return;
      }
    } catch (e) {
      console.warn('[history++] getSettings failed', e);
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  if (!gotSettings) applySettings({ ...DEFAULT_SETTINGS });
}

void initSettings();
