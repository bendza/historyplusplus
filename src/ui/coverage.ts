// Pure helpers for the "Search index" card: percentages, ETA, month labels, embedder status text.
// No DOM or extension APIs here so everything is unit-testable in node.
import type { IndexStatus } from '../shared/protocol';

type Embedder = NonNullable<IndexStatus['embedder']>;

/** Whole-number percentage of part/total, clamped to 0..100. Shows 99 (not 100) until truly done. */
export function percent(part: number, total: number): number {
  if (!(total > 0) || !(part > 0)) return 0;
  if (part >= total) return 100;
  return Math.min(99, Math.max(part > 0 ? 1 : 0, Math.round((part / total) * 100)));
}

/** "about 40 s", "about 12 min", "about 2 h 5 min"; '' when unknown (no rate or nothing left). */
export function formatEta(remaining: number, perSecond: number | undefined): string {
  if (!(remaining > 0) || !perSecond || !(perSecond > 0)) return '';
  const s = Math.ceil(remaining / perSecond);
  if (s < 60) return `about ${Math.max(5, Math.ceil(s / 5) * 5)} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `about ${min} min`;
  const hrs = Math.floor(min / 60);
  const rest = min % 60;
  return `about ${hrs} h${rest ? ` ${rest} min` : ''}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-03" -> "Mar" in the current year, "Mar 2025" otherwise. Unparseable input is returned as-is. */
export function monthLabel(ym: string, now = Date.now()): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const year = Number(m[1]);
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return ym;
  return year === new Date(now).getFullYear() ? month : `${month} ${year}`;
}

export function backendLabel(b: Embedder['backend'] | undefined): string {
  if (b === 'webgpu') return 'GPU (WebGPU)';
  if (b === 'wasm') return 'CPU (WASM)';
  return '';
}

/** Short status line for the on-device model. `enabled` is Settings.semanticSearch. */
export function embedderStateLabel(status: Pick<IndexStatus, 'chunksTotal' | 'chunksEmbedded' | 'embedder'>, enabled: boolean): string {
  const e = status.embedder;
  if (!enabled || e?.state === 'disabled') return 'Off';
  if (!e) return 'Not running';
  switch (e.state) {
    case 'loading':
      return 'Loading model…';
    case 'indexing':
      return 'Indexing…';
    case 'error':
      return `Error: ${e.error || 'unknown error'}`;
    case 'idle':
    case 'ready':
      return status.chunksEmbedded >= status.chunksTotal ? 'Up to date' : 'Waiting to index';
    case 'not-downloaded':
      return 'Not downloaded';
    case 'downloading':
      return 'Downloading…';
  }
}

/** Poll fast while the model is busy, slowly otherwise. */
export function pollInterval(status: IndexStatus | null): number {
  const s = status?.embedder?.state;
  return s === 'loading' || s === 'indexing' || s === 'downloading' ? 2000 : 15000;
}

/** Results-count suffix: shown when any hit came from the meaning retriever. */
export function matchSuffix(hits: { match?: string }[]): string {
  return hits.some((h) => h.match && h.match !== 'keyword') ? ' · meaning + keywords' : '';
}

export type MeaningPhase = 'off' | 'not-downloaded' | 'downloading' | 'error' | 'reading' | 'ready';

/**
 * One answer to "can I search by meaning yet?", combining storage 'model' (download) with
 * indexStatus (pages read). `model` null = not reported yet; fall back to the embedder state.
 */
export function meaningPhase(
  model: { status: 'not-downloaded' | 'downloading' | 'ready' | 'error' } | null | undefined,
  idx: Pick<IndexStatus, 'pages' | 'pagesEmbedded' | 'chunksTotal' | 'chunksEmbedded' | 'embedder'> | null,
  enabled = true,
): MeaningPhase {
  if (!enabled || idx?.embedder?.state === 'disabled') return 'off';
  const st = model?.status ?? (idx?.embedder?.state === 'not-downloaded' ? 'not-downloaded' : idx?.embedder?.state === 'downloading' ? 'downloading' : null);
  if (st === 'not-downloaded' || st === 'downloading' || st === 'error') return st;
  if (idx?.embedder?.state === 'error') return 'error';
  if (!idx) return 'ready';
  return idx.chunksEmbedded < idx.chunksTotal ? 'reading' : 'ready';
}

/** "42 MB of 118 MB" (total unknown: "42 MB"). */
export function downloadLabel(loaded: number, total: number): string {
  const mb = (n: number) => `${Math.round(n / 1_048_576)} MB`;
  return total > 0 ? `${mb(loaded)} of ${mb(total)}` : mb(loaded);
}
