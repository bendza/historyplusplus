// Catch-up sync: import visits the browser recorded while history++ wasn't listening (browser
// closed before the service worker woke, extension disabled or updating). Runs at browser start,
// when the background wakes up after a long gap, and every CATCHUP_PERIOD_MIN via chrome.alarms.
// Idempotent: the engine dedupes on (url, ts), so overlapping windows are harmless.
import type { Settings } from '../shared/protocol';
import { chunk, mapHistoryItem, type HistoryItemLike, type ImportVisit, type VisitItemLike } from './backfill';

/** Shape of storage.local key 'sync'. */
export interface SyncState {
  lastCatchUpAt: number;
  added: number; // visits newly inserted by the last run
}

export const CATCHUP_PERIOD_MIN = 6 * 60;
export const CATCHUP_OVERLAP_MS = 60 * 60_000;
/** Without any previous sync or backfill record, look this far back. */
export const CATCHUP_DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** On a plain service-worker wake-up, only run when the last run is at least this old. */
export const CATCHUP_MIN_GAP_MS = 15 * 60_000;

export interface CatchUpDeps {
  /** chrome.history.search from `startTime` on. */
  searchHistory(startTime: number): Promise<HistoryItemLike[]>;
  getVisits(url: string): Promise<VisitItemLike[]>;
  importVisits(visits: ImportVisit[]): Promise<{ inserted: number }>;
  getSettings(): Promise<Settings>;
  now?: () => number;
}

/**
 * Start of the window to re-import: last sync (or backfill start) minus an overlap, but never
 * before `floor` (when recording was last resumed: visits made while paused stay out).
 */
export function catchUpSince(
  prev: { lastCatchUpAt?: number } | undefined,
  backfillStartedAt: number | undefined,
  now: number,
  floor = 0,
): number {
  const anchor = prev?.lastCatchUpAt ?? backfillStartedAt ?? now - CATCHUP_DEFAULT_LOOKBACK_MS;
  return Math.max(0, floor, Math.min(anchor, now) - CATCHUP_OVERLAP_MS);
}

export async function runCatchUp(since: number, deps: CatchUpDeps): Promise<SyncState> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const settings = await deps.getSettings();
  // Paused: nothing from this window may be stored, and it must not be picked up later either.
  if (settings.paused) return { lastCatchUpAt: startedAt, added: 0 };
  const items = await deps.searchHistory(since);
  let added = 0;
  const visits: ImportVisit[] = [];
  for (const group of chunk(items, 50)) {
    const mapped = await Promise.all(
      group.map(async (item) => {
        if (!item.url || (item.lastVisitTime ?? Infinity) < since) return [];
        const all = await deps.getVisits(item.url).catch(() => [] as VisitItemLike[]);
        const recent = all.filter((v) => (v.visitTime ?? 0) >= since);
        // mapHistoryItem falls back to lastVisitTime when given no visits; only do that if
        // getVisits had nothing at all.
        return recent.length || !all.length ? mapHistoryItem(item, recent, settings) : [];
      }),
    );
    for (const m of mapped) visits.push(...m);
  }
  for (const batch of chunk(visits, 500)) added += (await deps.importVisits(batch)).inserted;
  return { lastCatchUpAt: startedAt, added };
}
