// Import what chrome.history still has into the engine. Idempotent: the engine dedupes on (url, ts).
import type { EngineOps, Settings } from '../shared/protocol';
import { isUrlAllowed } from '../shared/privacy';

export type ImportVisit = EngineOps['importVisits']['args']['visits'][number];

/** Shape of storage.local key 'backfill', read by the UI. */
export interface BackfillState {
  status: 'running' | 'done' | 'error';
  imported: number; // visits sent to the engine so far
  inserted: number; // new rows the engine reported (0 on a re-run)
  total: number; // history items (URLs) to scan
  scanned: number; // history items scanned so far
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  error?: string;
}

export interface HistoryItemLike {
  url?: string;
  title?: string;
  lastVisitTime?: number;
}
export interface VisitItemLike {
  visitTime?: number;
  transition?: string;
}

export const BACKFILL_CHUNK = 500;
/** A 'running' state older than this is assumed to be from a killed service worker. */
export const BACKFILL_STALE_MS = 2 * 60_000;

/** Map one history item + its visits to engine import rows, applying privacy rules. */
export function mapHistoryItem(item: HistoryItemLike, visits: VisitItemLike[], settings: Pick<Settings, 'denylist'>): ImportVisit[] {
  const url = item.url;
  if (!url || !isUrlAllowed(url, settings)) return [];
  const title = item.title || undefined;
  const out: ImportVisit[] = [];
  for (const v of visits) {
    if (typeof v.visitTime !== 'number' || !Number.isFinite(v.visitTime)) continue;
    out.push({ url, title, ts: Math.round(v.visitTime), transition: v.transition });
  }
  // getVisits can be empty for very old items; fall back to the last visit time.
  if (out.length === 0 && typeof item.lastVisitTime === 'number') {
    out.push({ url, title, ts: Math.round(item.lastVisitTime) });
  }
  return out;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function isBackfillRunning(state: BackfillState | undefined, now = Date.now()): boolean {
  return !!state && state.status === 'running' && now - state.updatedAt < BACKFILL_STALE_MS;
}

export interface BackfillDeps {
  /** chrome.history.search from `startTime` on. */
  searchHistory(startTime: number): Promise<HistoryItemLike[]>;
  /** When recording was last resumed: visits from before it (incl. the pause) are not imported. */
  since?: number;
  getVisits(url: string): Promise<VisitItemLike[]>;
  importVisits(visits: ImportVisit[]): Promise<{ inserted: number }>;
  getSettings(): Promise<Settings>;
  saveState(state: BackfillState): Promise<void>;
  now?: () => number;
}

/** Scan history, stream visits to the engine in chunks, and report progress through saveState. */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillState> {
  const now = deps.now ?? Date.now;
  const state: BackfillState = {
    status: 'running',
    imported: 0,
    inserted: 0,
    total: 0,
    scanned: 0,
    startedAt: now(),
    updatedAt: now(),
    finishedAt: null,
  };
  const save = () => deps.saveState({ ...state, updatedAt: (state.updatedAt = now()) });
  try {
    await save();
    const settings = await deps.getSettings();
    // Paused: nothing may be stored (same rule as catch-up and live capture).
    const since = settings.paused ? Infinity : (deps.since ?? 0);
    const items = Number.isFinite(since) ? await deps.searchHistory(since) : [];
    state.total = items.length;
    await save();

    let pending: ImportVisit[] = [];
    const flush = async () => {
      while (pending.length >= BACKFILL_CHUNK) {
        const batch = pending.slice(0, BACKFILL_CHUNK);
        pending = pending.slice(BACKFILL_CHUNK);
        await send(batch);
      }
    };
    const send = async (batch: ImportVisit[]) => {
      const { inserted } = await deps.importVisits(batch);
      state.imported += batch.length;
      state.inserted += inserted;
      await save();
    };

    // getVisits in small parallel groups: fast, but bounded.
    for (const group of chunk(items, 50)) {
      const mapped = await Promise.all(
        group.map(async (item) => {
          if (!item.url || !isUrlAllowed(item.url, settings)) return [];
          const all = await deps.getVisits(item.url).catch(() => [] as VisitItemLike[]);
          const visits = all.filter((v) => (v.visitTime ?? 0) >= since);
          // mapHistoryItem falls back to lastVisitTime when given no visits; only do that if
          // getVisits had nothing at all (and that time is after `since`).
          if (!visits.length && (all.length || (item.lastVisitTime ?? 0) < since)) return [];
          return mapHistoryItem(item, visits, settings);
        }),
      );
      for (const m of mapped) pending.push(...m);
      state.scanned += group.length;
      await flush();
    }
    if (pending.length) await send(pending);

    state.status = 'done';
    state.finishedAt = now();
    await save();
  } catch (e) {
    state.status = 'error';
    state.error = String((e as Error)?.message ?? e);
    state.finishedAt = now();
    await save().catch(() => {});
  }
  return { ...state };
}
