// Shared contract between capture (content script + background), the engine
// (offscreen document -> dedicated worker, sole owner of SQLite) and the UI.
//
// Message routing:
//   content script / UI page --chrome.runtime.sendMessage({to:'bg', ...})--> background
//   background --ensures offscreen doc, then sendMessage({to:'offscreen', req})--> offscreen
//   offscreen --postMessage--> engine worker --> reply flows back the same path.
// Only the background talks to the offscreen document. Every reply is EngineResponse.

export type Transition = string; // chrome.history TransitionType, e.g. 'link', 'typed'

export interface PageRow {
  id: number;
  url: string;
  domain: string;
  title: string;
  lang: string | null;
  first_seen: number; // epoch ms
  last_seen: number;
  visit_count: number;
  total_dwell_ms: number;
  has_text: boolean;
}

export interface VisitRow {
  id: number;
  page_id: number;
  ts: number;
  transition: Transition | null;
  dwell_ms: number;
  url: string;
  domain: string;
  title: string;
}

export interface SearchHit extends PageRow {
  score: number; // fused rank score, higher = better; already sorted best-first
  snippet: string; // HTML-safe except <mark>...</mark> around matches
  match: 'keyword' | 'meaning' | 'both'; // which retriever(s) found it
}

export interface SearchQuery {
  q: string; // raw user input, may contain before:/after:/site: operators
  limit?: number;
  offset?: number;
  mode?: 'keyword' | 'hybrid'; // default 'hybrid' (falls back to keyword when no vectors / embedder down)
  // 'relevance' (default): best match first. 'recent': the same matches, most recently visited first.
  sort?: 'relevance' | 'recent';
  // Set INTERNALLY by the offscreen layer (never by UI): e5 query embedding of the free text,
  // L2-normalized, EMBED_DIM long. Passed worker-side via structured clone.
  queryVector?: Float32Array;
}

// ---- Local semantic index (no network; model bundled in the extension) ----
export const EMBED_MODEL = 'Xenova/multilingual-e5-small';
export const EMBED_DIM = 384;

export interface IndexStatus {
  pages: number;
  pagesWithText: number;
  titleOnlyPages: number; // no captured text (e.g. imported history)
  chunksTotal: number;
  chunksEmbedded: number;
  pagesEmbedded: number; // pages with >= 1 embedded chunk
  model: string | null; // model name stored with vectors
  byMonth: { month: string; pages: number; withText: number; embedded: number }[]; // YYYY-MM by last_seen, newest first, max 24
  // Filled in by the offscreen layer (the engine leaves it undefined):
  embedder?: {
    // not-downloaded: model never fetched (search by words only). downloading: see `download`.
    state: 'not-downloaded' | 'downloading' | 'idle' | 'loading' | 'indexing' | 'ready' | 'error' | 'disabled';
    download?: { loaded: number; total: number }; // bytes, while downloading
    backend: 'webgpu' | 'wasm' | null;
    error?: string;
    perSecond?: number; // chunks/s over the last batch
  };
}

export interface ParsedQuery {
  text: string; // free text left after removing operators
  site: string[]; // domains, matched as suffix (site:github.com matches gist.github.com)
  before: number | null; // epoch ms, exclusive
  after: number | null; // epoch ms, inclusive
}

export interface DaySessions {
  day: string; // YYYY-MM-DD local time
  sessions: { start: number; end: number; visits: VisitRow[] }[];
}

export interface Stats {
  pages: number;
  visits: number;
  pagesWithText: number;
  oldestVisit: number | null;
  dbBytes: number;
  topDomains: { domain: string; visits: number; dwell_ms: number }[];
}

// ---- Engine requests (op name -> args / result) ----
export interface EngineOps {
  recordVisit: {
    args: { url: string; title?: string; ts: number; transition?: Transition; tabId?: number };
    result: { pageId: number; visitId: number } | null; // null when denied by privacy rules
  };
  // Content script captured readable text after minimum dwell.
  upsertText: {
    args: { url: string; title: string; text: string; lang?: string | null; ts: number };
    result: { pageId: number; changed: boolean } | null;
  };
  addDwell: { args: { url: string; dwellMs: number }; result: { ok: true } };
  // Bulk import from chrome.history (backfill). Idempotent on (url, ts).
  importVisits: {
    args: { visits: { url: string; title?: string; ts: number; transition?: Transition }[] };
    result: { inserted: number };
  };
  search: {
    args: SearchQuery;
    // dateLabel: human label when a date range was understood from plain words in q
    // ("Last week · Oct 6–12"); parsed.before/after hold the range. null when none.
    result: { hits: SearchHit[]; total: number; parsed: ParsedQuery; tookMs: number; dateLabel: string | null };
  };
  timeline: {
    args: { before?: number; days?: number }; // days of history ending before `before` (default now, 7)
    result: { days: DaySessions[] };
  };
  getPage: { args: { id: number }; result: (PageRow & { text: string | null }) | null };
  stats: { args: Record<string, never>; result: Stats };
  deletePage: { args: { id: number }; result: { ok: true } };
  deleteDomain: { args: { domain: string }; result: { deleted: number } };
  exportDb: { args: Record<string, never>; result: { bytes: string } }; // raw SQLite file, base64 (runtime messaging drops typed arrays)
  exportJson: { args: Record<string, never>; result: { json: string } };
  indexStatus: { args: Record<string, never>; result: IndexStatus };
  // Pages most similar in meaning to one page (excluding itself). Empty when it has no vectors yet.
  related: { args: { pageId: number; limit?: number }; result: { hits: SearchHit[] } };
  // Replace the whole database with a backup (a SQLite file made by exportDb), base64 like exportDb.
  // Validates it is a history++ database first; on failure the current data is untouched.
  // Large files: the UI writes the upload to OPFS (same extension origin) at RESTORE_OPFS_FILE and passes
  // opfsFile instead of bytes, so nothing big crosses runtime messaging (Chrome caps a message at 64 MiB).
  // The engine deletes that OPFS file when done.
  restoreDb: { args: { bytes?: string; opfsFile?: string }; result: { pages: number; visits: number } };
  deleteAll: { args: Record<string, never>; result: { ok: true } };
  // Embedding queue (driven by the offscreen layer, never by UI/background).
  // embedPending creates chunk rows lazily and returns un-embedded chunks, oldest-visited last
  // (most recently seen pages first). `text` is the passage WITHOUT the 'passage: ' prefix.
  embedPending: { args: { limit: number }; result: { items: { chunkId: number; text: string }[] } };
  storeEmbeddings: {
    args: { model: string; items: { chunkId: number; vector: Float32Array }[] }; // structured clone only
    result: { stored: number };
  };
}

export type EngineOp = keyof EngineOps;

export interface EngineRequest<K extends EngineOp = EngineOp> {
  op: K;
  args: EngineOps[K]['args'];
}

export type EngineResponse<K extends EngineOp = EngineOp> =
  | { ok: true; result: EngineOps[K]['result'] }
  | { ok: false; error: string };

// ---- Runtime messages ----
export type BgMessage =
  | { to: 'bg'; kind: 'engine'; req: EngineRequest } // UI or content -> engine via bg
  | { to: 'bg'; kind: 'capture'; url: string; title: string; text: string; lang: string | null; ts: number }
  | { to: 'bg'; kind: 'dwell'; url: string; dwellMs: number }
  | { to: 'bg'; kind: 'backfill' } // re-run chrome.history import
  | { to: 'bg'; kind: 'settingsChanged' }
  | { to: 'bg'; kind: 'getSettings' } // offscreen asks on start (offscreen docs can't read storage); reply: Settings
  | { to: 'bg'; kind: 'model'; action: 'download' | 'remove' } // start/redo the one-time model download, or delete it
  | { to: 'bg'; kind: 'backupNow' } // write a backup to Downloads/history++ now; progress in storage 'backup'
  | { to: 'bg'; kind: 'openApp'; path?: string }; // open/focus app.html (optional #route)

export type OffscreenMessage =
  | { to: 'offscreen'; req: EngineRequest }
  // background pushes settings whenever storage 'settings' changes (offscreen docs only get chrome.runtime)
  | { to: 'offscreen'; kind: 'settings'; settings: Settings };

// ---- Settings (chrome.storage.local key 'settings') ----
export interface Settings {
  denylist: string[]; // domains; suffix match
  minDwellMs: number; // default 5000
  captureText: boolean; // default true
  paused: boolean; // default false
  semanticSearch: boolean; // default true: run the local embedding model + hybrid search
  backupEnabled: boolean; // default true: daily backup to Downloads/history++, keep BACKUP_KEEP
}

export const DEFAULT_SETTINGS: Settings = {
  denylist: [],
  minDwellMs: 5000,
  captureText: true,
  paused: false,
  semanticSearch: true,
  backupEnabled: true,
};

// ---- Other chrome.storage.local keys (written by background, read by UI) ----
// 'model':      ModelState
// 'backup':     BackupState
// 'sync':       { lastCatchUpAt: number; added: number }   catch-up sync at browser start
// 'onboarding': { completedAt: number | null; step: number }
// 'backfill':   existing import state (see src/capture/backfill.ts)
export interface ModelState {
  status: 'not-downloaded' | 'downloading' | 'ready' | 'error';
  loaded: number; // bytes
  total: number; // bytes (0 = unknown yet)
  downloadedAt: number | null;
  error?: string;
}
export interface BackupState {
  lastAt: number | null;
  lastBytes: number;
  lastFile: string | null; // e.g. history++/history-plus-plus-2026-10-14.sqlite3
  running: boolean;
  error?: string;
}
export const BACKUP_KEEP = 7;
export const BACKUP_DIR = 'history++';
export const RESTORE_OPFS_FILE = 'restore-upload.sqlite3';

export const MAX_TEXT_CHARS = 40_000;
