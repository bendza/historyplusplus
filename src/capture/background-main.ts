// Background logic. Chromium: a service worker that can be killed after ~30 s idle, so every
// listener is registered synchronously and durable state lives in storage or the engine.
// Firefox: a persistent background page that also hosts the engine (see engine-bridge.ts).
import { browser, type Browser } from 'wxt/browser';
import type { BackupState, BgMessage, EngineResponse, ModelState } from '../shared/protocol';
import { isUrlAllowed } from '../shared/privacy';
import { isExtensionPage, isOwnPageReport } from '../shared/sender';
import { MODEL_TOTAL_BYTES } from '../embed/model-files';
import {
  BACKUP_CHECK_PERIOD_MIN,
  BACKUP_FILE_REGEX_SOURCE,
  isBackupDue,
  runBackup,
} from '../platform/backup';
import type { ModelStateMessage } from '../platform/host-api';
import { isBackfillRunning, runBackfill, type BackfillState } from './backfill';
import { CATCHUP_MIN_GAP_MS, CATCHUP_PERIOD_MIN, catchUpSince, runCatchUp, type SyncState } from './catchup';
import { bgEngine, callEngine, configureHost, ensureOffscreen, getHost } from './engine-bridge';
import { loadSettings, onSettingsChanged } from './settings';
import { RecentKeys, pageKey } from './spa';

const recent = new RecentKeys(2000);
let backfillInFlight: Promise<BackfillState> | null = null;
let catchUpInFlight: Promise<SyncState | null> | null = null;
let backupInFlight: Promise<BackupState> | null = null;

const ALARM_CATCHUP = 'catchup';
const ALARM_BACKUP = 'backup';

/** storage.local 'platform': background bookkeeping (not read by the UI). */
interface PlatformState {
  installedAt: number;
  /** When recording was last resumed after a pause; catch-up never imports from before it. */
  resumedAt?: number;
}

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

async function getKey<T>(key: string): Promise<T | undefined> {
  return (await browser.storage.local.get(key))[key] as T | undefined;
}

async function recordVisit(url: string, title: string | undefined, ts: number, transition: string | undefined, tabId?: number) {
  const settings = await loadSettings();
  if (settings.paused || !isUrlAllowed(url, settings)) return;
  if (!recent.shouldRecord(pageKey(url), ts)) return;
  await bgEngine('recordVisit', { url, title, ts, transition, tabId });
}

// ---- model state (the host reports; storage 'model' is what the UI reads) ----

const NOT_DOWNLOADED: ModelState = { status: 'not-downloaded', loaded: 0, total: MODEL_TOTAL_BYTES, downloadedAt: null };

async function onModelState(state: ModelState, init: boolean): Promise<void> {
  const stored = await getKey<ModelState>('model');
  if (init) {
    if (state.status === 'ready') {
      await browser.storage.local.set({ model: { ...state, downloadedAt: stored?.downloadedAt ?? Date.now() } });
    } else if (stored?.status === 'downloading') {
      // The host restarted (browser closed mid-download): pick the download up again.
      await (await getHost()).model('download');
    } else if (!stored || stored.status === 'ready') {
      await browser.storage.local.set({ model: NOT_DOWNLOADED }); // never fetched, or the cache was cleared
    }
    return;
  }
  const next: ModelState = { ...state };
  if (next.status === 'ready' && next.downloadedAt === null) next.downloadedAt = stored?.downloadedAt ?? Date.now();
  if (next.error === undefined) delete next.error;
  await browser.storage.local.set({ model: next });
}

async function modelAction(action: 'download' | 'remove'): Promise<void> {
  if (action === 'download') {
    const stored = await getKey<ModelState>('model');
    if (stored?.status !== 'ready') {
      await browser.storage.local.set({ model: { ...NOT_DOWNLOADED, status: 'downloading', loaded: 0 } satisfies ModelState });
    }
  }
  await (await getHost()).model(action);
}

// ---- app tab ----

async function openApp(path = ''): Promise<void> {
  const base = (browser.runtime.getURL as (p: string) => string)('/app.html');
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url?.startsWith(base));
  if (existing?.id !== undefined) {
    await browser.tabs.update(existing.id, { active: true, ...(path ? { url: base + path } : {}) });
    if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: base + path });
  }
}

// ---- catch-up sync ----

export function startCatchUp(opts: { minGapMs?: number } = {}): Promise<SyncState | null> {
  // A forced run arriving during a gap-checked one (which may skip) runs right after it.
  if (catchUpInFlight) return opts.minGapMs ? catchUpInFlight : catchUpInFlight.then(() => startCatchUp());
  catchUpInFlight = (async () => {
    const { sync, backfill, platform } = (await browser.storage.local.get(['sync', 'backfill', 'platform'])) as {
      sync?: SyncState;
      backfill?: BackfillState;
      platform?: PlatformState;
    };
    const now = Date.now();
    if (!sync && !backfill) return null; // fresh install: the backfill imports everything
    if (opts.minGapMs && sync && now - sync.lastCatchUpAt < opts.minGapMs) return null;
    if (isBackfillRunning(backfill) || backfillInFlight) return null; // the backfill imports everything anyway
    const since = catchUpSince(sync, backfill?.startedAt, now, platform?.resumedAt);
    const state = await runCatchUp(since, {
      searchHistory: (startTime) => browser.history.search({ text: '', startTime, maxResults: 1_000_000 }),
      getVisits: (url) => browser.history.getVisits({ url }),
      importVisits: (visits) => bgEngine('importVisits', { visits }),
      getSettings: loadSettings,
    });
    await browser.storage.local.set({ sync: state });
    return state;
  })()
    .catch((e) => {
      console.warn('[history++] catch-up sync', errMsg(e));
      return null;
    })
    .finally(() => {
      catchUpInFlight = null;
    });
  return catchUpInFlight;
}

// ---- daily backup ----

function waitForDownload(id: number, timeoutMs = 5 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: string) => {
      browser.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      if (err) reject(new Error(err));
      else resolve();
    };
    const onChanged = (d: Browser.downloads.DownloadDelta) => {
      if (d.id !== id) return;
      if (d.state?.current === 'complete') done();
      else if (d.state?.current === 'interrupted') done(`Backup download interrupted (${d.error?.current ?? 'unknown reason'}).`);
    };
    const timer = setTimeout(() => done('Backup download timed out.'), timeoutMs);
    browser.downloads.onChanged.addListener(onChanged);
    // It may already have finished before the listener was attached.
    void browser.downloads.search({ id }).then(([d]) => {
      if (d?.state === 'complete') done();
      else if (d?.state === 'interrupted') done(`Backup download interrupted (${d.error ?? 'unknown reason'}).`);
    });
  });
}

type SetUiOptions = (opts: { enabled: boolean }) => Promise<void>;

export function startBackup(): Promise<BackupState> {
  if (backupInFlight) return backupInFlight;
  backupInFlight = (async () => {
    const prev = await getKey<BackupState>('backup');
    const host = await getHost();
    const setUiOptions = (browser.downloads as unknown as { setUiOptions?: SetUiOptions }).setUiOptions;
    return runBackup(prev?.running ? { ...prev, running: false } : prev, {
      backupBlob: () => host.backupBlob(),
      revokeBlob: (url) => host.revokeBlob(url),
      download: ({ url, filename }) => browser.downloads.download({ url, filename, saveAs: false, conflictAction: 'overwrite' }),
      waitForDownload: (id) => waitForDownload(id),
      searchBackups: () => browser.downloads.search({ filenameRegex: BACKUP_FILE_REGEX_SOURCE, state: 'complete', limit: 0 }),
      removeFile: (id) => browser.downloads.removeFile(id),
      erase: (id) => browser.downloads.erase({ id }).then(() => {}),
      setUiEnabled: setUiOptions ? (enabled) => setUiOptions.call(browser.downloads, { enabled }) : undefined,
      saveState: (backup) => browser.storage.local.set({ backup }),
    });
  })()
    .catch((e) => {
      console.warn('[history++] backup', errMsg(e));
      return { lastAt: null, lastBytes: 0, lastFile: null, running: false, error: errMsg(e) } satisfies BackupState;
    })
    .finally(() => {
      backupInFlight = null;
    });
  return backupInFlight;
}

async function maybeBackup(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.backupEnabled) return;
  const { backup, platform } = (await browser.storage.local.get(['backup', 'platform'])) as { backup?: BackupState; platform?: PlatformState };
  if (backupInFlight) return;
  if (isBackupDue(backup, platform?.installedAt, Date.now())) await startBackup();
}

async function ensureAlarms(): Promise<void> {
  if (!(await browser.alarms.get(ALARM_CATCHUP))) {
    await browser.alarms.create(ALARM_CATCHUP, { delayInMinutes: CATCHUP_PERIOD_MIN, periodInMinutes: CATCHUP_PERIOD_MIN });
  }
  if (!(await browser.alarms.get(ALARM_BACKUP))) {
    await browser.alarms.create(ALARM_BACKUP, { delayInMinutes: 1, periodInMinutes: BACKUP_CHECK_PERIOD_MIN });
  }
}

async function onFreshInstall(): Promise<void> {
  // chrome.storage is wiped on uninstall, so existing state means this isn't really a first run
  // (e.g. an unpacked build re-registered from the command line): don't reset or re-onboard.
  if (await getKey<PlatformState>('platform')) return;
  const now = Date.now();
  await browser.storage.local.set({
    platform: { installedAt: now } satisfies PlatformState,
    sync: { lastCatchUpAt: now, added: 0 } satisfies SyncState,
  });
  if (!(await getKey<ModelState>('model'))) await browser.storage.local.set({ model: NOT_DOWNLOADED });
  void startBackfill();
  await openApp('#/welcome').catch((e) => console.warn('[history++] welcome tab', errMsg(e)));
}

// ---- messages ----

const extensionBase = () => (browser.runtime.getURL as (p: string) => string)('/');

async function handleBgMessage(msg: BgMessage, sender: Browser.runtime.MessageSender): Promise<unknown> {
  // Tabs (content scripts) may only report on their own page; everything else is for our pages.
  if (msg.kind === 'capture' || msg.kind === 'dwell') {
    if (!isOwnPageReport(sender, browser.runtime.id, msg.url)) return { ok: false, error: 'not allowed' };
  } else if (!isExtensionPage(sender, browser.runtime.id, extensionBase())) {
    return { ok: false, error: 'not allowed' };
  }
  switch (msg.kind) {
    case 'engine':
      return callEngine(msg.req);
    case 'capture': {
      if (sender.tab?.incognito) return { ok: true, result: null };
      const settings = await loadSettings();
      if (settings.paused || !settings.captureText || !isUrlAllowed(msg.url, settings)) return { ok: true, result: null };
      return callEngine({ op: 'upsertText', args: { url: msg.url, title: msg.title, text: msg.text, lang: msg.lang, ts: msg.ts } });
    }
    case 'dwell': {
      if (sender.tab?.incognito || msg.dwellMs <= 0) return { ok: true, result: { ok: true } };
      const settings = await loadSettings();
      if (settings.paused || !isUrlAllowed(msg.url, settings)) return { ok: true, result: { ok: true } };
      return callEngine({ op: 'addDwell', args: { url: msg.url, dwellMs: Math.round(msg.dwellMs) } });
    }
    case 'backfill':
      void startBackfill();
      return { ok: true, result: null };
    case 'settingsChanged':
      return { ok: true, result: null };
    case 'getSettings': // offscreen document (it has no chrome.storage)
      return loadSettings();
    case 'model':
      await modelAction(msg.action);
      return { ok: true, result: null };
    case 'backupNow':
      void startBackup();
      return { ok: true, result: null };
    case 'openApp':
      await openApp(msg.path);
      return { ok: true, result: null };
    default:
      return { ok: false, error: `unknown message kind` };
  }
}

export function startBackfill(): Promise<BackfillState> {
  if (backfillInFlight) return backfillInFlight;
  backfillInFlight = (async () => {
    const { backfill } = await browser.storage.local.get('backfill');
    if (isBackfillRunning(backfill as BackfillState | undefined)) return backfill as BackfillState;
    const platform = await getKey<PlatformState>('platform');
    return runBackfill({
      since: platform?.resumedAt,
      searchHistory: (startTime) => browser.history.search({ text: '', startTime, maxResults: 1_000_000 }),
      getVisits: (url) => browser.history.getVisits({ url }),
      importVisits: (visits) => bgEngine('importVisits', { visits }),
      getSettings: loadSettings,
      saveState: (state) => browser.storage.local.set({ backfill: state }),
    });
  })().finally(() => {
    backfillInFlight = null;
  });
  return backfillInFlight;
}

function startOffscreen() {
  ensureOffscreen().catch((e) => console.warn('[history++] ensureOffscreen', errMsg(e)));
}

export function registerBackground(): void {
  configureHost({
    onModelState: (state, init) => void onModelState(state, init).catch((e) => console.warn('[history++] model state', errMsg(e))),
    loadSettings,
  });

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const internal = raw as ModelStateMessage | undefined;
    if (internal?.to === 'bg' && internal.kind === 'modelState') {
      // Only from our own offscreen document (it has no tab).
      if (sender.id === browser.runtime.id && !sender.tab) onModelState(internal.state, !!internal.init).catch((e) => console.warn('[history++] model state', errMsg(e)));
      return undefined;
    }
    const msg = raw as BgMessage | undefined;
    if (!msg || msg.to !== 'bg') return undefined; // let the offscreen document answer its own messages
    handleBgMessage(msg, sender)
      .then(sendResponse, (e) => sendResponse({ ok: false, error: errMsg(e) } satisfies EngineResponse));
    return true;
  });

  browser.history.onVisited.addListener((item) => {
    if (!item.url) return;
    const url = item.url;
    (async () => {
      const visits = await browser.history.getVisits({ url });
      const latest = visits.reduce<Browser.history.VisitItem | undefined>(
        (best, v) => (!best || (v.visitTime ?? 0) > (best.visitTime ?? 0) ? v : best),
        undefined,
      );
      await recordVisit(url, item.title || undefined, Math.round(latest?.visitTime ?? item.lastVisitTime ?? Date.now()), latest?.transition);
    })().catch((e) => console.warn('[history++] onVisited', errMsg(e)));
  });

  browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    (async () => {
      const tab = await browser.tabs.get(details.tabId).catch(() => undefined);
      if (!tab || tab.incognito) return; // fail closed: an unknown tab may be a private one
      await recordVisit(details.url, tab?.title || undefined, Math.round(details.timeStamp || Date.now()), 'spa', details.tabId);
      await browser.tabs.sendMessage(details.tabId, { kind: 'spa-nav' }).catch(() => {});
    })().catch((e) => console.warn('[history++] onHistoryStateUpdated', errMsg(e)));
  });

  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') void onFreshInstall();
    startOffscreen();
    void ensureAlarms();
  });

  // The offscreen document runs the background embedding indexer, so bring it up without
  // waiting for the UI. Then pick up visits made while the extension wasn't running.
  browser.runtime.onStartup.addListener(() => {
    startOffscreen();
    void ensureAlarms();
    void startCatchUp().then(() => maybeBackup());
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_CATCHUP) void startCatchUp();
    else if (alarm.name === ALARM_BACKUP) void maybeBackup();
  });

  onSettingsChanged((settings) => {
    void getHost().then((h) => h.settings(settings));
  });
  browser.storage.onChanged.addListener((changes, area) => {
    const c = changes.settings;
    if (area !== 'local' || !c) return;
    const was = (c.oldValue as { paused?: boolean } | undefined)?.paused === true;
    const now = (c.newValue as { paused?: boolean } | undefined)?.paused === true;
    if (was && !now) {
      // Resumed: the catch-up sync must not import what the browser recorded during the pause.
      void getKey<PlatformState>('platform').then((p) =>
        browser.storage.local.set({ platform: { installedAt: p?.installedAt ?? Date.now(), ...p, resumedAt: Date.now() } }),
      );
    }
  });

  // Woken up for any reason (incl. re-enabled after being disabled, which fires neither
  // onInstalled nor onStartup): catch up if the last sync is old.
  void ensureAlarms();
  void startCatchUp({ minGapMs: CATCHUP_MIN_GAP_MS });

  // The toolbar button opens the popup (entrypoints/popup); its footer opens the full app.
  // Alt+H opens it too (manifest commands._execute_action).
}
