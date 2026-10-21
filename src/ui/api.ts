// Single data-access layer for the UI. Every engine call, storage read/write and
// background message goes through here so `?mock=1` can swap in fake data.
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { BackfillState } from '../capture/backfill';
import { faviconSupported } from '../shared/browsers';
import { engine } from '../shared/engine-client';
import { DEFAULT_SETTINGS, type BackupState, type BgMessage, type EngineOp, type EngineOps, type ModelState, type Settings } from '../shared/protocol';
import { mockBg, mockEngine, mockGetStore, mockOnStore, mockSetSemantic, mockSetStore } from './mock';

export type { BackfillState };

export const isMock = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === '1';

export function call<K extends EngineOp>(op: K, args: EngineOps[K]['args']): Promise<EngineOps[K]['result']> {
  return isMock ? mockEngine(op, args) : engine(op, args);
}

// ---- chrome.storage.local keys the UI reads (written by the background unless noted) ----

export interface SyncState {
  lastCatchUpAt: number;
  added: number;
}
export interface OnboardingState {
  completedAt: number | null;
  step: number;
}
/** UI-owned: one row per history file imported from another browser. */
export interface ImportRecord {
  browser: string;
  file: string;
  visits: number;
  inserted: number;
  at: number;
}
export interface StoreShape {
  settings: Settings;
  model: ModelState;
  backup: BackupState;
  sync: SyncState;
  onboarding: OnboardingState;
  backfill: BackfillState;
  imports: ImportRecord[];
}
export type StoreKey = keyof StoreShape;

export async function getStore<K extends StoreKey>(key: K): Promise<StoreShape[K] | null> {
  if (isMock) return mockGetStore(key) as StoreShape[K] | null;
  const got = await browser.storage.local.get(key);
  return (got[key] as StoreShape[K] | undefined) ?? null;
}

export async function setStore<K extends StoreKey>(key: K, value: StoreShape[K]): Promise<void> {
  if (isMock) return mockSetStore(key, value);
  await browser.storage.local.set({ [key]: value });
}

/** Subscribe to one storage key; returns an unsubscribe function. */
export function onStore<K extends StoreKey>(key: K, cb: (v: StoreShape[K] | null) => void): () => void {
  if (isMock) return mockOnStore(key, cb as (v: unknown) => void);
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && key in changes) cb((changes[key]!.newValue as StoreShape[K] | undefined) ?? null);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Live value of a storage key: undefined while loading, null when unset. */
export function useStore<K extends StoreKey>(key: K): StoreShape[K] | null | undefined {
  const [v, setV] = useState<StoreShape[K] | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    getStore(key).then((x) => alive && setV(x), () => alive && setV(null));
    const off = onStore(key, (x) => alive && setV(x));
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return v;
}

// ---- Settings ----

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await getStore('settings')) ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await setStore('settings', s);
  if (isMock) mockSetSemantic(s.semanticSearch);
  else await sendBg({ to: 'bg', kind: 'settingsChanged' });
}

export function useSettings(): [Settings | null, (patch: Partial<Settings>) => Promise<void>] {
  const raw = useStore('settings');
  const settings = raw === undefined ? null : { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  const update = async (patch: Partial<Settings>) => saveSettings({ ...(await getSettings()), ...patch });
  return [settings, update];
}

// ---- Background messages ----

type UiBgMessage = Extract<BgMessage, { kind: 'backfill' | 'settingsChanged' | 'model' | 'backupNow' | 'openApp' }>;

export async function sendBg(msg: UiBgMessage): Promise<unknown> {
  if (isMock) return mockBg(msg);
  try {
    const res = (await browser.runtime.sendMessage(msg)) as { ok?: boolean; error?: string } | undefined;
    if (res && res.ok === false) throw new Error(res.error || `${msg.kind} failed`);
    return res;
  } catch (e) {
    // The background may not reply to fire-and-forget messages; only surface real failures.
    if (!/receiving end does not exist|message port closed/i.test(String(e))) throw e;
    return undefined;
  }
}

export const triggerBackfill = () => sendBg({ to: 'bg', kind: 'backfill' });
export const downloadModel = () => sendBg({ to: 'bg', kind: 'model', action: 'download' });
export const removeModel = () => sendBg({ to: 'bg', kind: 'model', action: 'remove' });
export const backupNow = () => sendBg({ to: 'bg', kind: 'backupNow' });

/** Open (or focus) the full app at a route, e.g. '#/search?q=x'. Closes the popup when called from it. */
export async function openApp(path = ''): Promise<void> {
  if (isMock) {
    window.open(`app.html${location.search}${path}`, '_blank', 'noopener');
    return;
  }
  try {
    await sendBg({ to: 'bg', kind: 'openApp', path });
  } catch {
    // Older background without 'openApp': do it here.
    const base = (browser.runtime.getURL as (p: string) => string)('/app.html');
    const [existing] = await browser.tabs.query({ url: `${base}*` });
    if (existing?.id !== undefined) {
      await browser.tabs.update(existing.id, { active: true, ...(path ? { url: base + path } : {}) });
      if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
    } else await browser.tabs.create({ url: base + path });
  }
}

// ---- Favicons ----

/** Chromium serves cached favicons at /_favicon/; Firefox has no equivalent, so we draw letter tiles. */
const hasFaviconApi = (() => {
  if (isMock || !faviconSupported) return false;
  try {
    return (browser.runtime.getManifest().permissions ?? []).includes('favicon' as never);
  } catch {
    return false;
  }
})();

export function faviconUrl(pageUrl: string): string {
  if (!hasFaviconApi) return '';
  try {
    return `${browser.runtime.getURL('/_favicon/' as never)}?pageUrl=${encodeURIComponent(pageUrl)}&size=32`;
  } catch {
    return '';
  }
}

/** Open a URL in the current tab or a new one. */
export async function openUrl(url: string, newTab: boolean): Promise<void> {
  if (newTab) {
    if (isMock) window.open(url, '_blank', 'noopener');
    else await browser.tabs.create({ url, active: false });
  } else if (isMock) {
    location.href = url;
  } else {
    // tabs.update also handles chrome:// and file:// URLs that a plain navigation can't reach.
    await browser.tabs.update({ url });
  }
}
