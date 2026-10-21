// Background-only: reaches the engine host (see src/platform/host-api.ts).
// Chromium: owns the offscreen document and forwards requests to it by runtime messages.
// Firefox (MV2, persistent background page): creates the host in this page and calls it directly.
import { browser } from 'wxt/browser';
import type { EngineOp, EngineOps, EngineRequest, EngineResponse, ModelState, OffscreenMessage, Settings } from '../shared/protocol';
import type { BackupBlob, HostApi, HostMessage, HostReply } from '../platform/host-api';

const OFFSCREEN_PATH = 'offscreen.html';
let creating: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const url = (browser.runtime.getURL as (path: string) => string)(`/${OFFSCREEN_PATH}`);
  try {
    const contexts = await browser.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    return contexts.length > 0;
  } catch {
    // Older Chrome without getContexts.
    return (await (browser.offscreen as unknown as { hasDocument?: () => Promise<boolean> }).hasDocument?.()) ?? false;
  }
}

/** Chromium: make sure the offscreen document (the engine host) exists. Firefox: start the in-page host. */
export async function ensureOffscreen(): Promise<void> {
  if (import.meta.env.FIREFOX) {
    await getLocalHost();
    return;
  }
  if (await hasOffscreenDocument()) return;
  if (!creating) {
    creating = browser.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS', 'BLOBS'],
        justification: 'Runs the on-device search engine and embedding workers, and prepares backup files.',
      })
      .catch((e: unknown) => {
        // Another caller won the race; that's fine.
        if (!String((e as Error)?.message ?? e).includes('single offscreen')) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

function isNotReady(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return m.includes('Receiving end does not exist') || m.includes('Could not establish connection');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send one message to the offscreen document, (re)creating it and retrying once while it boots. */
async function sendOffscreen<T>(msg: OffscreenMessage | HostMessage, what: string): Promise<T | { ok: false; error: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ensureOffscreen();
      const res = (await browser.runtime.sendMessage(msg)) as T | undefined;
      if (res) return res;
      if (attempt >= 1) return { ok: false, error: `${what}: no response from offscreen document` };
    } catch (e) {
      if (attempt >= 1 || !isNotReady(e)) return { ok: false, error: `${what}: ${String((e as Error)?.message ?? e)}` };
    }
    await sleep(250);
  }
}

async function unwrap<T>(p: Promise<HostReply<T> | { ok: false; error: string }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

const offscreenHost: HostApi = {
  engine: (req) => sendOffscreen<EngineResponse>({ to: 'offscreen', req }, `engine ${req.op}`),
  settings: (settings) => {
    // No offscreen document yet: it asks for settings itself when it starts.
    browser.runtime.sendMessage({ to: 'offscreen', kind: 'settings', settings } satisfies OffscreenMessage).catch(() => {});
  },
  model: (action) => unwrap(sendOffscreen<HostReply<null>>({ to: 'offscreen', kind: 'model', action }, 'model')).then(() => {}),
  backupBlob: () => unwrap(sendOffscreen<HostReply<BackupBlob>>({ to: 'offscreen', kind: 'backupBlob' }, 'backup')),
  revokeBlob: (url) => {
    browser.runtime.sendMessage({ to: 'offscreen', kind: 'revokeBlob', url } satisfies HostMessage).catch(() => {});
  },
};

// ---- Firefox: in-page host ----
let localHost: Promise<HostApi> | null = null;
let modelStateHandler: ((state: ModelState, init: boolean) => void) | null = null;
let settingsSource: (() => Promise<Settings>) | null = null;

/** Where the host reports model state, and where an in-page host reads its initial settings. */
export function configureHost(opts: { onModelState: (state: ModelState, init: boolean) => void; loadSettings: () => Promise<Settings> }) {
  modelStateHandler = opts.onModelState;
  settingsSource = opts.loadSettings;
}

function getLocalHost(): Promise<HostApi> {
  localHost ??= import('../platform/engine-host').then(async ({ createEngineHost }) => {
    const host = createEngineHost({ onModelState: (s, init) => modelStateHandler?.(s, init) });
    if (settingsSource) host.settings(await settingsSource());
    return host;
  });
  return localHost;
}

/** The engine host for this browser. */
export async function getHost(): Promise<HostApi> {
  return import.meta.env.FIREFOX ? getLocalHost() : offscreenHost;
}

/** Send one request to the engine. Never throws; errors come back as {ok:false}. */
export async function callEngine(req: EngineRequest): Promise<EngineResponse> {
  try {
    return await (await getHost()).engine(req);
  } catch (e) {
    return { ok: false, error: `engine ${req.op}: ${String((e as Error)?.message ?? e)}` };
  }
}

/** Typed convenience for background code: throws on engine error. */
export async function bgEngine<K extends EngineOp>(op: K, args: EngineOps[K]['args']): Promise<EngineOps[K]['result']> {
  const res = (await callEngine({ op, args } as EngineRequest)) as EngineResponse<K>;
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
