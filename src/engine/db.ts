// SQLite storage + every engine op. Takes an already-open sqlite-wasm oo1
// Database so it runs the same in the OPFS worker and in Node tests (':memory:').
import type { BindableValue, Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import {
  EMBED_DIM,
  EMBED_MODEL,
  MAX_TEXT_CHARS,
  type DaySessions,
  type EngineOp,
  type EngineOps,
  type EngineRequest,
  type EngineResponse,
  type IndexStatus,
  type PageRow,
  type ParsedQuery,
  type SearchHit,
  type Stats,
  type VisitRow,
} from '../shared/protocol';
import { domainOf, normalizeUrl } from '../shared/url';
import { TEXT_HEAD_CHARS, textChunks, titleChunk } from './chunk';
import { parseSearch, toFtsLooseMatch, toFtsMatch } from './query';
import { QUANT_BYTES, VectorIndex, dequantize, quantize, type VectorHit } from './vectors';

// meta.embed_model = model + stored vector format; a mismatch on open clears all vectors.
const EMBED_TAG = `${EMBED_MODEL}#int8-scaled`;

const SESSION_GAP_MS = 30 * 60_000;

// ---- Hybrid search tuning ----
// Measured with scripts/eval (npm run eval: the real engine over a copy of a real 9.9k-page
// history, 53 labelled queries + negatives). Numbers below quote that eval.
// Candidates per retriever before fusion; hybrid `total` is at most twice this.
const KEYWORD_POOL = 200;
// Strict (all terms) keyword matches below this count: add pages with most of the terms
// (toFtsLooseMatch), so long natural-language questions still get keyword candidates.
// Eval keyword-only MRR 0.31 -> 0.39 (stopwords + dates alone: 0.25 -> 0.31); 1-10 same.
const KEYWORD_LOOSE_BELOW = 3;
// The loose list is fused as its own down-weighted RRF list. At 1 its weak hits outranked
// meaning hits (paraphrase hit@1 65->53%); 0.3-0.75 measured the same; 0.5.
const LOOSE_RRF_WEIGHT = 0.5;
// Meaning-only matches beyond the closest couple dozen are noise for e5-small. 15-30 measured
// the same; 20 with the floors below.
const MEANING_POOL = 20;
// Meaning candidates scanned before site:/date filters cut them down.
const MEANING_SCAN = 2000;
// e5 similarities are compressed AND their baseline shifts per query: measured with
// multilingual-e5-small against 13k real history titles, the background mean ranged
// 0.76-0.81 by query. Two regimes (see VectorIndex.search):
// - Small index (< CENTER_MIN_VECTORS): raw cosine. A hit must be within MEANING_REL_SIM of
//   the best (filtered) hit; the right page scored >= ~0.03 above the best unrelated one
//   (e.g. "dessert baking": cake 0.839 vs 0.769; sandstone: German match 0.781 vs 0.744).
//   MEANING_MIN_SIM is only a cheap pre-filter.
// - Large index: corpus-centered cosine, judged against this query's own similarity
//   distribution. The best hit must reach MEANING_BEST_Z sd above the mean or the query gets
//   no meaning hits at all; the others must reach MEANING_Z and be within MEANING_Z_BAND of
//   the best. Eval (hybrid hit@1/5/10, MRR): Z 3 / band 1 / no best floor 66/75/75% 0.71;
//   Z 2.5 / band 1.5 / best 3: 66/77/81% 0.72 (meaning hit@10 now equals the unfloored
//   vector ranking). Best z of real matches ranged 3.1-8.7, so a best floor high enough to
//   silence absent topics (sourdough 4.0, scuba 4.3 sd; raw cosine 0.848, overlapping true
//   matches at 0.81-0.85) cost hit@5 75->68% and MRR 0.71->0.63 at 4.4: not used.
export const MEANING_MIN_SIM = 0.7;
export const MEANING_REL_SIM = 0.03;
export const MEANING_Z = 2.5;
export const MEANING_Z_BAND = 1.5;
export const MEANING_BEST_Z = 3;
// A page's score is its best chunk's similarity, and the max over k chunks of noise grows
// with k (expected max of k standard normals: 0, 0.56, 0.85, 1.03, 1.16, 1.27, 1.35 sd for
// k = 1..7), so pages with captured text (up to 7 chunks) beat title-only pages too often.
// Subtract CHUNK_PENALTY x that expectation (in sd of this query's similarities). Eval: 0.25
// lifted hybrid hit@5 74->75%, MRR 0.70->0.71 with no loss anywhere; 1.5 gained one more
// hit@1 but lost a text-phrase sanity case. Only 30 pages had text, so kept conservative.
export const CHUNK_PENALTY = 0.25;
// Reciprocal Rank Fusion constant (Cormack et al.); score = sum 1 / (RRF_K + rank).
const RRF_K = 60;
// Search-engine result pages (google.com/search, bing.com/search, ...) carry snippets of many
// sites and AI answers, so they weakly match almost any query and crowded out the page itself
// in real history ("indie dev with a lot of projects" -> a Google search about a bank). Their
// fused score is multiplied by this; 1 turns it off.
export const SERP_WEIGHT = 0.5;
// Visits to one page under different query strings (app dashboards: /matches?tab=2) are
// separate rows with the same title. 1: show only the best of each (domain, path, title).
export const COLLAPSE_DUPLICATES = 1;
// One site whose pages hold lots of varied text (a job board's dashboards, a feed) matched
// every query and filled the first page. Each result from a site beyond the first PER_SITE_CAP
// has its score multiplied by PER_SITE_DECAY once more (3rd x0.6, 4th x0.36, ...), so other
// sites come up between them. Sending them to the very end put a relevant third GitHub repo
// below Google pages. 0 = off.
export const PER_SITE_CAP = 2;
export const PER_SITE_DECAY = 0.6;

/** Search knobs; HistoryDb.tuning starts as a copy so the eval can try other values. */
export interface SearchTuning {
  keywordPool: number;
  keywordLooseBelow: number;
  looseRrfWeight: number;
  meaningPool: number;
  meaningZ: number;
  meaningZBand: number;
  meaningBestZ: number;
  chunkPenalty: number;
  rrfK: number;
  serpWeight: number;
  collapseDuplicates: number;
  perSiteCap: number;
}
export const DEFAULT_TUNING: Readonly<SearchTuning> = {
  keywordPool: KEYWORD_POOL,
  keywordLooseBelow: KEYWORD_LOOSE_BELOW,
  looseRrfWeight: LOOSE_RRF_WEIGHT,
  meaningPool: MEANING_POOL,
  meaningZ: MEANING_Z,
  meaningZBand: MEANING_Z_BAND,
  meaningBestZ: MEANING_BEST_Z,
  chunkPenalty: CHUNK_PENALTY,
  rrfK: RRF_K,
  serpWeight: SERP_WEIGHT,
  collapseDuplicates: COLLAPSE_DUPLICATES,
  perSiteCap: PER_SITE_CAP,
};

/** A search engine's result page, judged by host and path. */
export function isSearchResultsPage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname;
  return (
    (/^google\.[a-z.]+$/.test(host) && (path === '/search' || path === '/webhp' || path.startsWith('/sorry/'))) ||
    (host === 'bing.com' && path === '/search') ||
    (host === 'duckduckgo.com' && u.searchParams.has('q')) ||
    (host === 'search.brave.com' && path === '/search') ||
    (host === 'search.yahoo.com' && path.startsWith('/search')) ||
    (/^yandex\.[a-z.]+$/.test(host) && path.startsWith('/search')) ||
    (host === 'ecosia.org' && path === '/search') ||
    (host === 'perplexity.ai' && path.startsWith('/search'))
  );
}

/** Key under which visits to one page with different query strings collapse. */
function duplicateKey(url: string, title: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}\u0000${title}`;
  } catch {
    return `${url}\u0000${title}`;
  }
}

// related: at most this many pages, each at least MEANING_Z sd above the background.
const RELATED_MAX = 50;
const SNIPPET_CHARS = 160;
// Pages chunked per embedPending round.
const CHUNK_BATCH = 64;

// Each entry upgrades schema_version N -> N+1. Append only; never edit a shipped one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;

  CREATE TABLE pages (
    id             INTEGER PRIMARY KEY,
    url            TEXT NOT NULL UNIQUE,        -- normalized
    domain         TEXT NOT NULL,
    title          TEXT NOT NULL DEFAULT '',
    lang           TEXT,
    text           TEXT,                        -- readable text, capped at MAX_TEXT_CHARS
    text_hash      TEXT,
    first_seen     INTEGER NOT NULL,
    last_seen      INTEGER NOT NULL,
    visit_count    INTEGER NOT NULL DEFAULT 0,
    total_dwell_ms INTEGER NOT NULL DEFAULT 0,
    promoted_at    INTEGER
  );
  CREATE INDEX pages_domain ON pages(domain);
  CREATE INDEX pages_last_seen ON pages(last_seen);

  CREATE TABLE visits (
    id               INTEGER PRIMARY KEY,
    page_id          INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    ts               INTEGER NOT NULL,
    transition       TEXT,
    referrer_page_id INTEGER,
    dwell_ms         INTEGER NOT NULL DEFAULT 0,
    tab_session_id   INTEGER
  );
  -- Makes importVisits idempotent and serves "latest visit of page" lookups.
  CREATE UNIQUE INDEX visits_page_ts ON visits(page_id, ts);
  CREATE INDEX visits_ts ON visits(ts);

  -- External-content FTS over pages(title, text), kept in sync by triggers.
  -- remove_diacritics 2 folds ć/č/š/ž/đ... so "cevapi" finds "ćevapi".
  CREATE VIRTUAL TABLE pages_fts USING fts5(
    title, text, content='pages', content_rowid='id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
  END;
  CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  END;
  -- Only fires on title/text changes, so counter bumps don't churn the index.
  CREATE TRIGGER pages_fts_au AFTER UPDATE OF title, text ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
    INSERT INTO pages_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
  END;
  `,
  // v2: semantic index. Pages are split into chunks (ord 0 = title chunk, 1.. = text
  // passages), created lazily by embedPending and embedded by the offscreen embedder.
  `
  -- Both live after the (possibly overflowing) text column, so readers that only need
  -- them go through the covering indexes below instead of touching page rows.
  ALTER TABLE pages ADD COLUMN has_text INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pages ADD COLUMN chunked INTEGER NOT NULL DEFAULT 0; -- 0 = chunk rows missing/stale
  UPDATE pages SET has_text = 1 WHERE text IS NOT NULL AND text <> '';
  CREATE INDEX pages_seen_text ON pages(last_seen, has_text);
  CREATE INDEX pages_unchunked ON pages(last_seen) WHERE chunked = 0;

  CREATE TABLE chunks (
    id        INTEGER PRIMARY KEY,
    page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    ord       INTEGER NOT NULL,                 -- 0 = title chunk
    prio      INTEGER NOT NULL,                 -- page last_seen when chunked: embed queue order
    text      TEXT NOT NULL,
    embedding BLOB,                             -- quantize(): EMBED_DIM x int8 + float32 scale, NULL = pending
    model     TEXT
  );
  CREATE UNIQUE INDEX chunks_page_ord ON chunks(page_id, ord);
  CREATE INDEX chunks_pending ON chunks(prio DESC, ord) WHERE embedding IS NULL;
  CREATE INDEX chunks_embedded ON chunks(page_id) WHERE embedding IS NOT NULL;

  -- Text change: drop text passages (re-created lazily). Title change: same for the title chunk.
  CREATE TRIGGER pages_text_chunks AFTER UPDATE OF text ON pages WHEN new.text IS NOT old.text BEGIN
    UPDATE pages SET has_text = (new.text IS NOT NULL AND new.text <> ''), chunked = 0 WHERE id = new.id;
    DELETE FROM chunks WHERE page_id = new.id AND ord > 0;
  END;
  CREATE TRIGGER pages_title_chunks AFTER UPDATE OF title ON pages WHEN new.title IS NOT old.title BEGIN
    UPDATE pages SET chunked = 0 WHERE id = new.id;
    DELETE FROM chunks WHERE page_id = new.id AND ord = 0;
  END;
  -- Independent of PRAGMA foreign_keys.
  CREATE TRIGGER pages_chunks_ad AFTER DELETE ON pages BEGIN
    DELETE FROM chunks WHERE page_id = old.id;
  END;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Per-connection pragmas + pending migrations. Safe to call on every open.
 * `target` exists for tests that need an old schema.
 */
export function migrate(db: Database, target: number = MIGRATIONS.length): number {
  db.exec('PRAGMA foreign_keys = ON;');
  // Deleted pages are overwritten with zeros, so a forgotten site doesn't linger in free pages
  // (and in the next backup, which copies the whole file).
  db.exec('PRAGMA secure_delete = ON;');
  const hasMeta = db.selectValue("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'");
  let version = hasMeta ? Number(db.selectValue("SELECT value FROM meta WHERE key='schema_version'") ?? 0) : 0;
  while (version < target) {
    const next = version + 1;
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec({ sql: "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", bind: [String(next)] });
    });
    version = next;
  }
  // FTS5 keeps deleted rows' tokens in its index segments until they merge; this purges them
  // on delete. Stored in the FTS config table, so setting it again is a no-op.
  if (db.selectValue("SELECT 1 FROM sqlite_master WHERE name = 'pages_fts'")) {
    db.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 1)");
  }
  return version;
}

/** Only web pages are stored; everything else (chrome:, file:, data:...) is dropped. */
function isRecordable(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** cyrb53: fast 53-bit string hash, plenty for "did the text change?" */
export function hashText(str: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + str.length;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);
}

// snippet() wraps matches in these; we escape everything, then swap them for <mark>.
const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';
function renderSnippet(raw: string): string {
  return escapeHtml(raw).replaceAll(MARK_OPEN, '<mark>').replaceAll(MARK_CLOSE, '</mark>');
}

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PAGE_COLS = `p.id, p.url, p.domain, p.title, p.lang, p.first_seen, p.last_seen, p.visit_count,
  p.total_dwell_ms, (p.text IS NOT NULL AND p.text <> '') AS has_text`;

type Row = Record<string, unknown>;

function toPage(r: Row): PageRow {
  return {
    id: Number(r.id),
    url: String(r.url),
    domain: String(r.domain),
    title: String(r.title ?? ''),
    lang: (r.lang as string | null) ?? null,
    first_seen: Number(r.first_seen),
    last_seen: Number(r.last_seen),
    visit_count: Number(r.visit_count),
    total_dwell_ms: Number(r.total_dwell_ms),
    has_text: !!r.has_text,
  };
}

function toVisit(r: Row): VisitRow {
  return {
    id: Number(r.id),
    page_id: Number(r.page_id),
    ts: Number(r.ts),
    transition: (r.transition as string | null) ?? null,
    dwell_ms: Number(r.dwell_ms),
    url: String(r.url),
    domain: String(r.domain),
    title: String(r.title ?? ''),
  };
}

/** site:x suffix match on domain (github.com matches gist.github.com, not evilgithub.com). */
function siteClause(sites: string[], bind: BindableValue[]): string {
  const parts = sites.map((s) => {
    bind.push(s, '%.' + s.replace(/[\\%_]/g, '\\$&'));
    return "(p.domain = ? OR p.domain LIKE ? ESCAPE '\\')";
  });
  return '(' + parts.join(' OR ') + ')';
}

/** site:/before:/after: as SQL conditions on `pages p`. Appends to `bind` in order. */
function filterClauses(parsed: ParsedQuery, bind: BindableValue[]): string[] {
  const where: string[] = [];
  if (parsed.site.length) where.push(siteClause(parsed.site, bind));
  if (parsed.before !== null || parsed.after !== null) {
    // Date filters apply to visits: the page had at least one visit in range.
    where.push('EXISTS (SELECT 1 FROM visits v WHERE v.page_id = p.id AND v.ts >= ? AND v.ts < ?)');
    bind.push(parsed.after ?? -Number.MAX_SAFE_INTEGER, parsed.before ?? Number.MAX_SAFE_INTEGER);
  }
  return where;
}

const placeholders = (n: number) => Array(n).fill('?').join(',');

/** Shorten to about `max` chars at a word boundary. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(' ', max);
  return t.slice(0, cut > max * 0.6 ? cut : max) + '…';
}

/** BLOB from SQLite -> int8 view (no copy). */
function asInt8(blob: unknown): Int8Array | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== QUANT_BYTES) return null;
  return new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
}

interface KeywordPlan {
  strict: string;
  loose: string | null;
  strictIds: number[]; // strict matches (fewer than keywordLooseBelow) when loose is set
}

interface Fused {
  id: number;
  score: number; // RRF
  kwRank: number | null; // 1-based
  meaning: VectorHit | null;
}

export interface HistoryDbOptions {
  /** The sqlite-wasm module; restoreDb needs it (in-memory staging DB, deserialize). */
  sqlite3?: Sqlite3Static;
  /** Clock for plain-language dates ("yesterday"); the eval pins it to the snapshot time. */
  now?: () => number;
}

export class HistoryDb {
  // Loaded on first semantic search; null = not loaded (or invalidated).
  private vectors: VectorIndex | null = null;
  readonly tuning: SearchTuning = { ...DEFAULT_TUNING };
  private readonly now: () => number;
  private readonly sqlite3: Sqlite3Static | undefined;

  /**
   * @param exportDb serializes the whole database file (worker passes
   *   sqlite3.capi.sqlite3_js_db_export bound to this db).
   */
  constructor(
    readonly db: Database,
    private readonly exportDbImpl?: () => Uint8Array,
    opts: HistoryDbOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sqlite3 = opts.sqlite3;
    migrate(db);
    this.purgeFreedPagesOnce();
    const model = db.selectValue("SELECT value FROM meta WHERE key = 'embed_model'");
    // Model or vector format changed: re-index.
    if (model != null && model !== EMBED_TAG) this.invalidateEmbeddings();
  }

  /**
   * Databases from before secure_delete may still hold deleted pages in free pages: rewrite the
   * file once. Fresh databases have nothing to purge, so they only get the flag.
   */
  private purgeFreedPagesOnce(): void {
    if (this.db.selectValue("SELECT 1 FROM meta WHERE key = 'freed_pages_purged'")) return;
    try {
      if (Number(this.db.selectValue('PRAGMA freelist_count')) > 0) this.db.exec('VACUUM');
      this.db.exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('freed_pages_purged', '1')");
    } catch (e) {
      console.warn('[history++] one-time VACUUM failed', e); // retried on the next open
    }
  }

  /** Upsert a page row by normalized URL; returns its id. Title only moves forward in time. */
  private upsertPage(url: string, title: string, ts: number): number {
    return Number(
      this.db.selectValue(
        `INSERT INTO pages(url, domain, title, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = CASE WHEN excluded.title <> '' AND (pages.title = '' OR excluded.last_seen >= pages.last_seen)
                        THEN excluded.title ELSE pages.title END,
           first_seen = min(pages.first_seen, excluded.first_seen),
           last_seen = max(pages.last_seen, excluded.last_seen)
         RETURNING id`,
        [url, domainOf(url), title, ts, ts],
      ),
    );
  }

  /** Insert a visit unless (page, ts) exists; bumps visit_count. Returns visit id and whether it was new. */
  private insertVisit(pageId: number, ts: number, transition: string | null): { id: number; inserted: boolean } {
    this.db.exec({
      sql: 'INSERT OR IGNORE INTO visits(page_id, ts, transition) VALUES (?, ?, ?)',
      bind: [pageId, ts, transition],
    });
    const inserted = this.db.changes() > 0;
    if (inserted) this.db.exec({ sql: 'UPDATE pages SET visit_count = visit_count + 1 WHERE id = ?', bind: [pageId] });
    const id = Number(this.db.selectValue('SELECT id FROM visits WHERE page_id = ? AND ts = ?', [pageId, ts]));
    return { id, inserted };
  }

  recordVisit(a: EngineOps['recordVisit']['args']): EngineOps['recordVisit']['result'] {
    if (!isRecordable(a.url)) return null;
    const url = normalizeUrl(a.url);
    return this.db.transaction(() => {
      const pageId = this.upsertPage(url, a.title ?? '', a.ts);
      const { id } = this.insertVisit(pageId, a.ts, a.transition ?? null);
      return { pageId, visitId: id };
    });
  }

  upsertText(a: EngineOps['upsertText']['args']): EngineOps['upsertText']['result'] {
    if (!isRecordable(a.url)) return null;
    const url = normalizeUrl(a.url);
    // \u0001/\u0002 are our snippet sentinels; they must not occur in stored text.
    const text = (a.text ?? '').replace(/[\u0001\u0002]/g, '').slice(0, MAX_TEXT_CHARS);
    const hash = hashText(text);
    return this.db.transaction(() => {
      const pageId = this.upsertPage(url, a.title ?? '', a.ts);
      // Empty text = title-only update (e.g. a sensitive page whose text is never captured);
      // it must never wipe text stored earlier.
      if (!text.trim()) return { pageId, changed: false };
      const old = this.db.selectValue('SELECT text_hash FROM pages WHERE id = ?', [pageId]);
      const changed = old !== hash;
      if (changed) {
        this.db.exec({
          sql: 'UPDATE pages SET text = ?, text_hash = ?, lang = coalesce(?, lang) WHERE id = ?',
          bind: [text, hash, a.lang ?? null, pageId],
        });
      }
      return { pageId, changed };
    });
  }

  addDwell(a: EngineOps['addDwell']['args']): EngineOps['addDwell']['result'] {
    const ms = Math.round(a.dwellMs);
    if (!Number.isFinite(ms) || ms <= 0) return { ok: true };
    const pageId = this.db.selectValue('SELECT id FROM pages WHERE url = ?', [normalizeUrl(a.url)]);
    if (pageId == null) return { ok: true };
    this.db.transaction(() => {
      this.db.exec({ sql: 'UPDATE pages SET total_dwell_ms = total_dwell_ms + ? WHERE id = ?', bind: [ms, pageId] });
      this.db.exec({
        sql: `UPDATE visits SET dwell_ms = dwell_ms + ?
              WHERE id = (SELECT id FROM visits WHERE page_id = ? ORDER BY ts DESC LIMIT 1)`,
        bind: [ms, pageId],
      });
    });
    return { ok: true };
  }

  importVisits(a: EngineOps['importVisits']['args']): EngineOps['importVisits']['result'] {
    let inserted = 0;
    this.db.transaction(() => {
      for (const v of a.visits) {
        if (!isRecordable(v.url) || !Number.isFinite(v.ts)) continue;
        const pageId = this.upsertPage(normalizeUrl(v.url), v.title ?? '', v.ts);
        if (this.insertVisit(pageId, v.ts, v.transition ?? null).inserted) inserted++;
      }
    });
    return { inserted };
  }

  search(a: EngineOps['search']['args']): EngineOps['search']['result'] {
    const t0 = performance.now();
    const q = a.q ?? '';
    let { parsed, dateLabel } = parseSearch(q, this.now());
    let res = this.searchParsed(a, parsed);
    // A time phrase that leaves nothing was probably just words ("posted 4 months ago" pasted
    // from a page): search again with it as plain text, and report no date range.
    if (dateLabel && !res.total) {
      ({ parsed, dateLabel } = parseSearch(q, this.now(), { dates: false }));
      res = this.searchParsed(a, parsed);
    }
    return { ...res, parsed, dateLabel, tookMs: Math.round((performance.now() - t0) * 10) / 10 };
  }

  private searchParsed(a: EngineOps['search']['args'], parsed: ParsedQuery): { hits: SearchHit[]; total: number } {
    const limit = Math.max(1, Math.min(500, Math.floor(a.limit ?? 50)));
    const offset = Math.max(0, Math.floor(a.offset ?? 0));
    const plan = this.keywordPlan(parsed);

    const qv = a.queryVector;
    if (plan && a.mode !== 'keyword' && qv && qv.length === EMBED_DIM) {
      const meaning = this.meaningCandidates(qv, parsed);
      // No vectors yet (or nothing close enough): plain keyword search, unpaginated by pools.
      if (meaning.length) return this.hybridSearch(plan, parsed, meaning, limit, offset, a.sort ?? 'relevance');
    }

    if (plan) {
      // Rank ids first; page columns and snippet() only for the returned page (snippet() on
      // every match before LIMIT costs ~0.1 ms per row).
      let ranked: { id: number; score: number }[];
      let total: number;
      if (a.sort === 'recent') {
        // Same matches, newest visit first (loose = "most terms" when the strict match is thin).
        const match = plan.loose ?? plan.strict;
        ranked = this.ftsRank(match, parsed, limit, offset, 'recent');
        total = this.ftsCount(match, parsed);
      } else if (plan.loose) {
        // Strict matches first (all of them: fewer than keywordLooseBelow), then the rest of the loose ones.
        const strict = this.ftsRank(plan.strict, parsed, plan.strictIds.length);
        const seen = new Set(plan.strictIds);
        const rest = this.ftsRank(plan.loose, parsed, offset + limit + seen.size).filter((r) => !seen.has(r.id));
        ranked = [...strict, ...rest].slice(offset, offset + limit);
        total = this.ftsCount(plan.loose, parsed);
      } else {
        ranked = this.ftsRank(plan.strict, parsed, limit, offset);
        total = this.ftsCount(plan.strict, parsed);
      }
      const hits = this.toHits(
        ranked.map((r, i) => ({ ...r, kwRank: offset + i + 1, meaning: null })),
        plan.loose ?? plan.strict,
      );
      return { hits, total };
    }

    // No searchable words: everything within the filters, newest first.
    const bind: BindableValue[] = [];
    const where = filterClauses(parsed, bind);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = Number(this.db.selectValue(`SELECT count(*) FROM pages p ${whereSql}`, bind.length ? bind : undefined));
    const ranked = this.db.selectArrays(`SELECT p.id FROM pages p ${whereSql} ORDER BY p.last_seen DESC LIMIT ? OFFSET ?`, [
      ...bind,
      limit,
      offset,
    ]);
    const hits = this.toHits(
      ranked.map(([id], i) => ({ id: Number(id), score: 0, kwRank: offset + i + 1, meaning: null })),
      null,
    );
    return { hits, total };
  }

  /** FTS matches within the site:/date filters, best bm25 first (title weighted 5x), or newest first. */
  private ftsRank(
    match: string,
    parsed: ParsedQuery,
    limit: number,
    offset = 0,
    order: 'relevance' | 'recent' = 'relevance',
  ): { id: number; score: number }[] {
    if (limit <= 0) return [];
    const bind: BindableValue[] = [match];
    const where = ['pages_fts MATCH ?', ...filterClauses(parsed, bind)];
    return this.db
      .selectArrays(
        `SELECT p.id, -bm25(pages_fts, 5.0, 1.0) AS score
         FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid WHERE ${where.join(' AND ')}
         ORDER BY ${order === 'recent' ? 'p.last_seen DESC, score DESC' : 'score DESC, p.last_seen DESC'} LIMIT ? OFFSET ?`,
        [...bind, limit, offset],
      )
      .map(([id, score]) => ({ id: Number(id), score: Number(score) }));
  }

  private ftsCount(match: string, parsed: ParsedQuery): number {
    const bind: BindableValue[] = [match];
    const where = ['pages_fts MATCH ?', ...filterClauses(parsed, bind)];
    return Number(
      this.db.selectValue(`SELECT count(*) FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid WHERE ${where.join(' AND ')}`, bind),
    );
  }

  /**
   * FTS expressions for the free text, null when nothing is searchable. `strict` needs every
   * term (stopwords dropped). When it finds fewer than keywordLooseBelow pages within the
   * filters, `loose` (most of the terms) adds candidates after those `strictIds`.
   */
  private keywordPlan(parsed: ParsedQuery): KeywordPlan | null {
    const strict = toFtsMatch(parsed.text);
    if (!strict) return null;
    const loose = toFtsLooseMatch(parsed.text);
    if (!loose) return { strict, loose: null, strictIds: [] };
    const strictIds = this.ftsRank(strict, parsed, this.tuning.keywordLooseBelow).map((r) => r.id);
    if (strictIds.length >= this.tuning.keywordLooseBelow) return { strict, loose: null, strictIds: [] };
    return { strict, loose, strictIds };
  }

  /** The vector index, loading every embedded chunk on first use; pending deletes applied. */
  private vectorIndex(): VectorIndex {
    if (this.vectors) {
      this.drainTombstones();
      return this.vectors;
    }
    const idx = new VectorIndex();
    // Per-connection (TEMP) trigger: every deleted embedded chunk leaves a tombstone that we
    // apply to the in-memory index. Covers deletes done by the schema triggers (text/title
    // changes, page deletes) without the engine having to track them.
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS chunk_tombstones(id INTEGER PRIMARY KEY);
      CREATE TEMP TRIGGER IF NOT EXISTS chunk_tombstone AFTER DELETE ON chunks
        WHEN old.embedding IS NOT NULL BEGIN
          INSERT OR IGNORE INTO chunk_tombstones(id) VALUES (old.id);
        END;
      DELETE FROM chunk_tombstones;
    `);
    this.db.exec({
      sql: 'SELECT id, page_id, embedding FROM chunks WHERE embedding IS NOT NULL',
      rowMode: 'array',
      callback: (row) => {
        const r = row as unknown[];
        const v = asInt8(r[2]);
        if (v) idx.upsert(Number(r[0]), Number(r[1]), v);
      },
    });
    this.vectors = idx;
    return idx;
  }

  private drainTombstones(): void {
    if (!this.vectors) return;
    const dead = this.db.selectArrays('SELECT id FROM chunk_tombstones');
    if (!dead.length) return;
    for (const [id] of dead) this.vectors.remove(Number(id));
    this.db.exec('DELETE FROM chunk_tombstones');
  }

  /** Model changed: forget every vector so the embedder re-indexes everything. */
  private invalidateEmbeddings(): void {
    this.db.transaction(() => {
      this.db.exec('UPDATE chunks SET embedding = NULL, model = NULL WHERE embedding IS NOT NULL');
      this.db.exec("DELETE FROM meta WHERE key = 'embed_model'");
    });
    this.vectors = null;
  }

  /**
   * Pages ranked by their best chunk's similarity, after site:/date filters and the
   * relative + per-query background floors (see MEANING_REL_SIM). At most MEANING_POOL.
   */
  private meaningCandidates(qv: ArrayLike<number>, parsed: ParsedQuery): VectorHit[] {
    const t = this.tuning;
    const index = this.vectorIndex();
    let hits = index.search(qv, MEANING_MIN_SIM, t.meaningZ, t.chunkPenalty).slice(0, MEANING_SCAN);
    const { mean, sd, centered } = index.lastStats;
    if (hits.length && (parsed.site.length || parsed.before !== null || parsed.after !== null)) {
      const bind: BindableValue[] = hits.map((h) => h.pageId);
      const where = filterClauses(parsed, bind);
      const ok = new Set(
        this.db
          .selectArrays(`SELECT p.id FROM pages p WHERE p.id IN (${placeholders(hits.length)}) AND ${where.join(' AND ')}`, bind)
          .map((r) => Number(r[0])),
      );
      hits = hits.filter((h) => ok.has(h.pageId));
    }
    if (!hits.length) return hits;
    const best = hits[0]!.sim;
    const bestZ = (best - mean) / (sd || 1);
    if (centered && bestZ < t.meaningBestZ) return [];
    const floor = centered
      ? mean + sd * Math.max(t.meaningZ, bestZ - t.meaningZBand)
      : Math.max(MEANING_MIN_SIM, best - MEANING_REL_SIM);
    return hits.filter((h) => h.sim >= floor).slice(0, t.meaningPool);
  }

  /** Reciprocal Rank Fusion of the top KEYWORD_POOL FTS hits and the meaning candidates. */
  private hybridSearch(
    plan: KeywordPlan,
    parsed: ParsedQuery,
    meaning: VectorHit[],
    limit: number,
    offset: number,
    sort: 'relevance' | 'recent' = 'relevance',
  ): { hits: SearchHit[]; total: number } {
    const pool = this.tuning.keywordPool;
    const k = this.tuning.rrfK;
    const fused = new Map<number, Fused>();
    // Strict keyword list, then (when the strict one is nearly empty) the loose list as a third,
    // down-weighted list. Strict hits are in both, like a page found by both retrievers.
    const strictIds = plan.loose ? plan.strictIds : this.ftsRank(plan.strict, parsed, pool).map((r) => r.id);
    strictIds.forEach((id, i) => fused.set(id, { id, score: 1 / (k + i + 1), kwRank: i + 1, meaning: null }));
    if (plan.loose) {
      const w = this.tuning.looseRrfWeight;
      let rank = strictIds.length;
      this.ftsRank(plan.loose, parsed, pool).forEach(({ id }, i) => {
        const f = fused.get(id);
        if (f) f.score += w / (k + i + 1);
        else fused.set(id, { id, score: w / (k + i + 1), kwRank: ++rank, meaning: null });
      });
    }
    meaning.forEach((m, i) => {
      const s = 1 / (k + i + 1);
      const f = fused.get(m.pageId);
      if (f) {
        f.score += s;
        f.meaning = m;
      } else fused.set(m.pageId, { id: m.pageId, score: s, kwRank: null, meaning: m });
    });
    this.adjustFused(fused);
    // Ties (same rank in one list each): keyword first, then newer page id.
    let ranked = [...fused.values()].sort(
      (x, y) => y.score - x.score || (x.kwRank ?? Infinity) - (y.kwRank ?? Infinity) || y.id - x.id,
    );
    ranked = this.collapseDuplicates(ranked);
    if (sort === 'recent' && ranked.length) {
      // Same fused candidates (relevance decides what matches), shown newest visit first.
      const ids = ranked.map((f) => f.id);
      const seen = new Map(
        this.db.selectArrays(`SELECT id, last_seen FROM pages WHERE id IN (${placeholders(ids.length)})`, ids).map(([id, t]) => [Number(id), Number(t)]),
      );
      ranked.sort((x, y) => (seen.get(y.id) ?? 0) - (seen.get(x.id) ?? 0) || y.score - x.score);
    }
    const slice = ranked.slice(offset, offset + limit);
    return { hits: this.toHits(slice, plan.loose ?? plan.strict), total: ranked.length };
  }

  /** Down-weight search-engine result pages (see SERP_WEIGHT). */
  private adjustFused(fused: Map<number, Fused>): void {
    const w = this.tuning.serpWeight;
    if (w === 1 || !fused.size) return;
    const ids = [...fused.keys()];
    for (const [id, url] of this.db.selectArrays(`SELECT id, url FROM pages WHERE id IN (${placeholders(ids.length)})`, ids)) {
      if (isSearchResultsPage(String(url))) fused.get(Number(id))!.score *= w;
    }
  }

  /**
   * Keep the best-ranked of each (domain, path, title) (COLLAPSE_DUPLICATES), then lower a
   * site's results beyond PER_SITE_CAP (PER_SITE_DECAY) and re-rank.
   */
  private collapseDuplicates(ranked: Fused[]): Fused[] {
    const { collapseDuplicates, perSiteCap } = this.tuning;
    if ((!collapseDuplicates && !perSiteCap) || ranked.length < 2) return ranked;
    const ids = ranked.map((f) => f.id);
    const info = new Map(
      this.db
        .selectArrays(`SELECT id, url, title, domain FROM pages WHERE id IN (${placeholders(ids.length)})`, ids)
        .map(([id, url, title, domain]) => [Number(id), { key: duplicateKey(String(url), String(title ?? '')), domain: String(domain ?? '') }]),
    );
    const seen = new Set<string>();
    const perSite = new Map<string, number>();
    const out: Fused[] = [];
    for (const f of ranked) {
      const i = info.get(f.id);
      if (!i) {
        out.push(f);
        continue;
      }
      if (collapseDuplicates) {
        if (seen.has(i.key)) continue;
        seen.add(i.key);
      }
      const n = (perSite.get(i.domain) ?? 0) + 1;
      perSite.set(i.domain, n);
      out.push(perSiteCap && n > perSiteCap ? { ...f, score: f.score * PER_SITE_DECAY ** (n - perSiteCap) } : f);
    }
    // Stable: equal scores keep their earlier order.
    return out.map((f, i) => ({ f, i })).sort((a, b) => b.f.score - a.f.score || a.i - b.i).map(({ f }) => f);
  }

  /** Page rows + snippets for one page of ranked results (FTS snippet needs `match`). */
  private toHits(slice: Fused[], match: string | null): SearchHit[] {
    if (!slice.length) return [];
    const ids = slice.map((f) => f.id);
    const rows = new Map(
      this.db.selectObjects(`SELECT ${PAGE_COLS} FROM pages p WHERE p.id IN (${placeholders(ids.length)})`, ids).map((r) => [
        Number(r.id),
        r,
      ]),
    );
    const kwIds = slice.filter((f) => f.kwRank !== null).map((f) => f.id);
    const ftsSnips = new Map<number, string>();
    if (match && kwIds.length) {
      for (const [id, snip] of this.db.selectArrays(
        `SELECT rowid, snippet(pages_fts, 1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 16) FROM pages_fts
         WHERE pages_fts MATCH ? AND rowid IN (${placeholders(kwIds.length)})`,
        [match, ...kwIds],
      )) {
        if (snip != null) ftsSnips.set(Number(id), String(snip));
      }
    }
    const chunkSnips = this.chunkSnippets(slice.filter((f) => f.kwRank === null).map((f) => f.meaning!));

    const hits: SearchHit[] = [];
    for (const f of slice) {
      const r = rows.get(f.id);
      if (!r) continue;
      const page = toPage(r);
      const kw = f.kwRank !== null;
      const fts = ftsSnips.get(f.id);
      hits.push({
        ...page,
        score: f.score,
        snippet: kw
          ? page.has_text && fts != null
            ? renderSnippet(fts)
            : escapeHtml(page.url)
          : (chunkSnips.get(f.id) ?? escapeHtml(page.url)),
        match: kw ? (f.meaning ? 'both' : 'keyword') : 'meaning',
      });
    }
    return hits;
  }

  /**
   * Snippets for meaning-only hits: the best chunk's text, escaped and clipped. When the
   * best chunk is the title chunk, the page's first passage (if any) reads better.
   */
  private chunkSnippets(hits: VectorHit[]): Map<number, string> {
    const out = new Map<number, string>();
    if (!hits.length) return out;
    const rows = this.db.selectArrays(
      `SELECT c.page_id, CASE WHEN c.ord = 0
         THEN (SELECT t.text FROM chunks t WHERE t.page_id = c.page_id AND t.ord = 1) ELSE c.text END
       FROM chunks c WHERE c.id IN (${placeholders(hits.length)})`,
      hits.map((h) => h.chunkId),
    );
    for (const [pageId, text] of rows) if (text != null) out.set(Number(pageId), escapeHtml(clip(String(text), SNIPPET_CHARS)));
    return out;
  }

  /** Create chunk rows for up to `n` pages lacking them, most recently seen first. */
  private chunkPages(n: number): number {
    const pages = this.db.selectArrays(
      `SELECT id, url, domain, title, last_seen, CASE WHEN has_text THEN substr(text, 1, ?) END
       FROM pages WHERE chunked = 0 ORDER BY last_seen DESC LIMIT ?`,
      [TEXT_HEAD_CHARS, n],
    );
    if (!pages.length) return 0;
    this.db.transaction(() => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO chunks(page_id, ord, prio, text) VALUES (?, ?, ?, ?)');
      const done = this.db.prepare('UPDATE pages SET chunked = 1 WHERE id = ?');
      try {
        for (const [id, url, domain, title, lastSeen, text] of pages) {
          // OR IGNORE keeps existing (maybe embedded) chunks, e.g. text passages on a title change.
          const parts = [titleChunk(String(title ?? ''), String(domain), String(url)), ...(text ? textChunks(String(text)) : [])];
          parts.forEach((t, ord) => ins.bind([id as number, ord, lastSeen as number, t]).stepReset());
          done.bind([id as number]).stepReset();
        }
      } finally {
        ins.finalize();
        done.finalize();
      }
    });
    return pages.length;
  }

  embedPending(a: EngineOps['embedPending']['args']): EngineOps['embedPending']['result'] {
    const limit = Math.max(1, Math.min(512, Math.floor(a.limit ?? 32)));
    // Always chunk a batch first so newly visited pages jump the queue; keep going only
    // while the queue is short of `limit`.
    for (;;) {
      const made = this.chunkPages(CHUNK_BATCH);
      const rows = this.db.selectArrays(
        'SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY prio DESC, ord LIMIT ?',
        [limit],
      );
      if (rows.length >= limit || made === 0) {
        return { items: rows.map(([id, text]) => ({ chunkId: Number(id), text: String(text) })) };
      }
    }
  }

  storeEmbeddings(a: EngineOps['storeEmbeddings']['args']): EngineOps['storeEmbeddings']['result'] {
    if (a.model !== EMBED_MODEL) throw new Error(`embedding model mismatch: expected ${EMBED_MODEL}, got ${a.model}`);
    this.drainTombstones(); // before adding: chunk ids can be reused after deletes
    const done: { chunkId: number; pageId: number; v: Int8Array }[] = [];
    this.db.transaction(() => {
      this.db.exec({ sql: "INSERT OR REPLACE INTO meta(key, value) VALUES ('embed_model', ?)", bind: [EMBED_TAG] });
      const upd = this.db.prepare('UPDATE chunks SET embedding = ?, model = ? WHERE id = ? RETURNING page_id');
      try {
        for (const { chunkId, vector } of a.items ?? []) {
          if (!vector || vector.length !== EMBED_DIM || !Number.isInteger(chunkId)) continue;
          const v = quantize(vector);
          upd.bind([v, a.model, chunkId]);
          if (upd.step()) done.push({ chunkId, pageId: Number(upd.get(0)), v }); // unknown ids: no row
          upd.reset();
        }
      } finally {
        upd.finalize();
      }
    });
    // Only after commit, so a rolled-back batch never reaches the index.
    for (const d of done) this.vectors?.upsert(d.chunkId, d.pageId, d.v);
    return { stored: done.length };
  }

  indexStatus(): IndexStatus {
    const v = (sql: string) => Number(this.db.selectValue(sql));
    const pages = v('SELECT count(*) FROM pages');
    const pagesWithText = v('SELECT count(*) FROM pages WHERE has_text = 1');
    const model = this.db.selectValue('SELECT model FROM chunks WHERE embedding IS NOT NULL LIMIT 1');
    // Index-only: (last_seen, has_text) covering index + chunks_embedded partial index.
    const months = new Map<string, { month: string; pages: number; withText: number; embedded: number }>();
    this.db.exec({
      sql: `SELECT p.last_seen, p.has_text,
              EXISTS (SELECT 1 FROM chunks c WHERE c.page_id = p.id AND c.embedding IS NOT NULL)
            FROM pages p INDEXED BY pages_seen_text ORDER BY p.last_seen DESC`,
      rowMode: 'array',
      callback: (row) => {
        const [ts, hasText, embedded] = row as number[];
        const month = localDay(Number(ts)).slice(0, 7);
        let m = months.get(month);
        if (!m) {
          if (months.size >= 24) return;
          months.set(month, (m = { month, pages: 0, withText: 0, embedded: 0 }));
        }
        m.pages++;
        m.withText += Number(hasText);
        m.embedded += Number(embedded);
      },
    });
    return {
      pages,
      pagesWithText,
      titleOnlyPages: pages - pagesWithText,
      // Chunk rows are created lazily, so pages not chunked yet (e.g. right after an import)
      // count as one pending chunk each; otherwise status would read "up to date" too early.
      chunksTotal: v('SELECT count(*) FROM chunks') + v('SELECT count(*) FROM pages WHERE chunked = 0'),
      chunksEmbedded: v('SELECT count(*) FROM chunks WHERE embedding IS NOT NULL'),
      pagesEmbedded: v('SELECT count(DISTINCT page_id) FROM chunks WHERE embedding IS NOT NULL'),
      model: model == null ? null : String(model),
      byMonth: [...months.values()],
    };
  }

  timeline(a: EngineOps['timeline']['args']): EngineOps['timeline']['result'] {
    const end = a.before ?? Date.now();
    const days = Math.max(1, Math.min(366, Math.floor(a.days ?? 7)));
    // Start = local midnight of the day containing `end - 1`, then back (days - 1) days (DST-safe).
    const start = new Date(end - 1);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const rows = this.db.selectObjects(
      `SELECT v.id, v.page_id, v.ts, v.transition, v.dwell_ms, p.url, p.domain, p.title
       FROM visits v JOIN pages p ON p.id = v.page_id
       WHERE v.ts >= ? AND v.ts < ? ORDER BY v.ts ASC`,
      [start.getTime(), end],
    );

    // Bucket by local day, then split each day into sessions on 30-min gaps.
    const byDay = new Map<string, VisitRow[]>();
    for (const r of rows) {
      const v = toVisit(r);
      const key = localDay(v.ts);
      (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(v);
    }
    const out: DaySessions[] = [];
    for (const [day, visits] of byDay) {
      const sessions: DaySessions['sessions'] = [];
      let cur: VisitRow[] = [];
      const close = () => {
        if (cur.length) sessions.push({ start: cur[0]!.ts, end: cur.at(-1)!.ts, visits: cur.reverse() });
        cur = [];
      };
      for (const v of visits) {
        if (cur.length && v.ts - cur.at(-1)!.ts > SESSION_GAP_MS) close();
        cur.push(v);
      }
      close();
      out.push({ day, sessions: sessions.reverse() }); // newest session first, newest visit first
    }
    return { days: out.reverse() }; // newest day first
  }

  getPage(a: EngineOps['getPage']['args']): EngineOps['getPage']['result'] {
    const r = this.db.selectObject(`SELECT ${PAGE_COLS}, p.text FROM pages p WHERE p.id = ?`, [a.id]);
    return r ? { ...toPage(r), text: (r.text as string | null) ?? null } : null;
  }

  stats(): Stats {
    const v = (sql: string) => this.db.selectValue(sql);
    const top = this.db.selectObjects(
      `SELECT p.domain AS domain, count(*) AS visits, sum(v.dwell_ms) AS dwell_ms
       FROM visits v JOIN pages p ON p.id = v.page_id
       GROUP BY p.domain ORDER BY visits DESC, dwell_ms DESC LIMIT 20`,
    );
    const oldest = v('SELECT min(ts) FROM visits');
    return {
      pages: Number(v('SELECT count(*) FROM pages')),
      visits: Number(v('SELECT count(*) FROM visits')),
      pagesWithText: Number(v('SELECT count(*) FROM pages WHERE has_text = 1')),
      oldestVisit: oldest == null ? null : Number(oldest),
      dbBytes: Number(v('PRAGMA page_count')) * Number(v('PRAGMA page_size')),
      topDomains: top.map((r) => ({ domain: String(r.domain), visits: Number(r.visits), dwell_ms: Number(r.dwell_ms ?? 0) })),
    };
  }

  deletePage(a: EngineOps['deletePage']['args']): EngineOps['deletePage']['result'] {
    this.db.transaction(() => {
      // Explicit visit delete so we don't depend on foreign_keys being on.
      this.db.exec({ sql: 'DELETE FROM visits WHERE page_id = ?', bind: [a.id] });
      this.db.exec({ sql: 'DELETE FROM pages WHERE id = ?', bind: [a.id] }); // FTS + chunks via triggers
    });
    this.drainTombstones();
    return { ok: true };
  }

  /** Forget a site: the domain and all its subdomains (same suffix rule as site:). */
  deleteDomain(a: EngineOps['deleteDomain']['args']): EngineOps['deleteDomain']['result'] {
    const d = a.domain.trim().toLowerCase().replace(/^www\./, '');
    if (!d) return { deleted: 0 };
    const bind: BindableValue[] = [];
    const clause = siteClause([d], bind);
    let deleted = 0;
    this.db.transaction(() => {
      this.db.exec({ sql: `DELETE FROM visits WHERE page_id IN (SELECT p.id FROM pages p WHERE ${clause})`, bind });
      this.db.exec({ sql: `DELETE FROM pages AS p WHERE ${clause}`, bind }); // FTS + chunks via triggers
      deleted = this.db.changes();
    });
    this.drainTombstones();
    return { deleted };
  }

  exportDb(): EngineOps['exportDb']['result'] {
    // Base64 because runtime messaging JSON-serializes typed arrays into {0:..,1:..}.
    return { bytes: toBase64(this.exportBytes()) };
  }

  /** The whole database file as raw bytes (the worker transfers these to the offscreen page). */
  exportBytes(): Uint8Array {
    if (!this.exportDbImpl) throw new Error('exportDb not available');
    return this.exportDbImpl();
  }

  exportJson(): EngineOps['exportJson']['result'] {
    const pages = this.db.selectObjects(
      `SELECT id, url, domain, title, lang, text, first_seen, last_seen, visit_count, total_dwell_ms, promoted_at
       FROM pages ORDER BY id`,
    );
    const visits = this.db.selectObjects(
      'SELECT id, page_id, ts, transition, referrer_page_id, dwell_ms FROM visits ORDER BY ts',
    );
    return {
      json: JSON.stringify({ format: 'history++', schemaVersion: SCHEMA_VERSION, exportedAt: Date.now(), pages, visits }),
    };
  }

  /**
   * Pages closest in meaning to one page: its chunk vectors averaged into one query, scored
   * like a meaning search (centered z floor, multi-chunk correction). Skips the page itself and
   * pages with the same title (tracking-param / search-variant duplicates), one page per title.
   */
  related(a: EngineOps['related']['args']): EngineOps['related']['result'] {
    const limit = Math.max(1, Math.min(RELATED_MAX, Math.floor(a.limit ?? 10)));
    const src = this.db.selectObject('SELECT id, title FROM pages WHERE id = ?', [a.pageId]);
    if (!src) return { hits: [] };
    const sum = new Float64Array(EMBED_DIM);
    let n = 0;
    this.db.exec({
      sql: 'SELECT embedding FROM chunks WHERE page_id = ? AND embedding IS NOT NULL',
      bind: [a.pageId],
      rowMode: 'array',
      callback: (row) => {
        const v = asInt8((row as unknown[])[0]);
        if (!v) return;
        const f = dequantize(v);
        for (let j = 0; j < EMBED_DIM; j++) sum[j] = sum[j]! + f[j]!;
        n++;
      },
    });
    if (!n) return { hits: [] };
    const norm = Math.hypot(...sum) || 1;
    const qv = Float32Array.from(sum, (x) => x / norm);

    const index = this.vectorIndex();
    const found = index.search(qv, MEANING_MIN_SIM, this.tuning.meaningZ, this.tuning.chunkPenalty);
    const { mean, sd, centered } = index.lastStats;
    const floor = centered ? mean + sd * this.tuning.meaningZ : MEANING_MIN_SIM;
    const cand = found.filter((h) => h.pageId !== a.pageId && h.sim >= floor).slice(0, limit * 4);
    if (!cand.length) return { hits: [] };
    const titles = new Map(
      this.db
        .selectArrays(`SELECT id, title FROM pages WHERE id IN (${placeholders(cand.length)})`, cand.map((h) => h.pageId))
        .map(([id, t]) => [Number(id), String(t ?? '').trim().toLowerCase()]),
    );
    const seen = new Set([String(src.title ?? '').trim().toLowerCase()]);
    const picked: Fused[] = [];
    for (const h of cand) {
      const t = titles.get(h.pageId);
      if (t === undefined || (t !== '' && seen.has(t))) continue;
      seen.add(t);
      picked.push({ id: h.pageId, score: h.sim, kwRank: null, meaning: h });
      if (picked.length >= limit) break;
    }
    return { hits: this.toHits(picked, null) };
  }

  /**
   * Run `fill` with every page, visit, chunk and FTS row gone, in one transaction (any throw
   * rolls back to the current data). The `pages` triggers are dropped meanwhile and the FTS
   * index cleared/rebuilt in bulk: per-row FTS deletes would re-tokenize every stored text.
   */
  private replaceContent(fill: () => void): void {
    this.db.transaction(() => {
      const triggers = this.db
        .selectArrays("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'pages'")
        .map(([name, sql]) => ({ name: String(name), sql: String(sql) }));
      for (const t of triggers) this.db.exec(`DROP TRIGGER "${t.name.replace(/"/g, '""')}"`);
      this.db.exec(`
        DELETE FROM visits;
        DELETE FROM chunks;
        DELETE FROM pages;
        INSERT INTO pages_fts(pages_fts) VALUES ('delete-all');
      `);
      fill();
      this.db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')");
      for (const t of triggers) this.db.exec(t.sql);
    });
    // Chunk deletes queued tombstones for the old index; it is rebuilt from scratch instead.
    this.vectors = null;
  }

  /** Forget everything: pages, visits, chunks, FTS and vectors. Schema and meta stay. */
  deleteAll(): EngineOps['deleteAll']['result'] {
    this.replaceContent(() => {});
    try {
      this.db.exec('VACUUM'); // give the space back and overwrite freed pages
    } catch (e) {
      console.warn('[history++] VACUUM after deleteAll failed', e);
    }
    return { ok: true };
  }

  /**
   * Replace all data with a backup made by exportDb (base64 SQLite file). The backup is
   * opened in a separate in-memory database, checked (SQLite header, quick_check, meta
   * schema_version 1..SCHEMA_VERSION, pages + visits tables) and migrated forward there; only
   * then is it attached and copied over the live data in one transaction. Any failure leaves
   * the live data as it was. Vectors from another model/format are dropped (re-indexed later).
   */
  restoreDb(a: EngineOps['restoreDb']['args']): EngineOps['restoreDb']['result'] {
    if (!this.sqlite3) throw new Error('restoreDb not available');
    // opfsFile is read asynchronously by the engine worker, which then calls restoreBytes().
    if (a.opfsFile && !a.bytes) throw new Error('restore: opfsFile is only supported in the engine worker');
    if (typeof a.bytes !== 'string' || !a.bytes) throw new Error('restore: no data');
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(a.bytes);
    } catch {
      throw new Error('restore: data is not base64');
    }
    return this.restoreBytes(bytes);
  }

  /** restoreDb on raw file bytes (modified in place: the journal-mode header bytes). */
  restoreBytes(bytes: Uint8Array): EngineOps['restoreDb']['result'] {
    const sqlite3 = this.sqlite3;
    if (!sqlite3) throw new Error('restoreDb not available');
    if (bytes.length < 512 || new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0')
      throw new Error('restore: not a SQLite database file');
    // Deserialized databases can't open in WAL mode; the header bytes say rollback journal.
    bytes[18] = 1;
    bytes[19] = 1;

    const { capi, wasm, oo1 } = sqlite3;
    const deserialize = (db: Database, schema: string, data: Uint8Array) => {
      const p = wasm.allocFromTypedArray(data);
      const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
      db.checkRc(capi.sqlite3_deserialize(db.pointer!, schema, p, data.byteLength, data.byteLength, flags));
    };

    // 1. Validate + migrate in a throwaway connection.
    let staged: Uint8Array;
    const tmp = new oo1.DB(':memory:');
    try {
      deserialize(tmp, 'main', bytes);
      let ok: unknown;
      try {
        ok = tmp.selectValue('PRAGMA quick_check');
      } catch (e) {
        throw new Error(`restore: unreadable database (${e instanceof Error ? e.message : String(e)})`);
      }
      if (ok !== 'ok') throw new Error(`restore: database is damaged (${String(ok)})`);
      const has = (t: string) => !!tmp.selectValue("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t]);
      if (!has('meta') || !has('pages') || !has('visits')) throw new Error('restore: not a history++ backup');
      const version = Number(tmp.selectValue("SELECT value FROM meta WHERE key = 'schema_version'"));
      if (!Number.isInteger(version) || version < 1) throw new Error('restore: not a history++ backup');
      if (version > SCHEMA_VERSION)
        throw new Error(`restore: backup is from a newer history++ (schema ${version} > ${SCHEMA_VERSION}); update the extension first`);
      migrate(tmp);
      if (tmp.selectValue("SELECT value FROM meta WHERE key = 'embed_model'") !== EMBED_TAG) {
        tmp.exec("UPDATE chunks SET embedding = NULL, model = NULL WHERE embedding IS NOT NULL; DELETE FROM meta WHERE key = 'embed_model'");
      }
      staged = capi.sqlite3_js_db_export(tmp);
    } finally {
      tmp.close();
    }

    // 2. Attach the migrated copy and swap the contents.
    this.db.exec("ATTACH DATABASE ':memory:' AS restore_src");
    try {
      deserialize(this.db, 'restore_src', staged);
      const cols = (table: string) =>
        this.db
          .selectArrays(`SELECT name FROM pragma_table_info('${table}')`)
          .map(([c]) => '"' + String(c) + '"')
          .join(', ');
      this.replaceContent(() => {
        const pc = cols('pages'),
          vc = cols('visits'),
          cc = cols('chunks');
        this.db.exec(`
          INSERT INTO main.pages(${pc}) SELECT ${pc} FROM restore_src.pages;
          INSERT INTO main.visits(${vc}) SELECT ${vc} FROM restore_src.visits WHERE page_id IN (SELECT id FROM main.pages);
          INSERT INTO main.chunks(${cc}) SELECT ${cc} FROM restore_src.chunks WHERE page_id IN (SELECT id FROM main.pages);
          DELETE FROM main.meta WHERE key = 'embed_model';
          INSERT INTO main.meta(key, value) SELECT key, value FROM restore_src.meta WHERE key = 'embed_model';
        `);
      });
    } finally {
      this.db.exec('DETACH DATABASE restore_src');
    }
    return {
      pages: Number(this.db.selectValue('SELECT count(*) FROM pages')),
      visits: Number(this.db.selectValue('SELECT count(*) FROM visits')),
    };
  }

  /** Run one request; never throws. */
  handle(req: EngineRequest): EngineResponse {
    try {
      const fn = (this as unknown as Record<EngineOp, (args: unknown) => unknown>)[req?.op];
      if (typeof fn !== 'function' || !OPS.has(req.op)) return { ok: false, error: `unknown op: ${String(req?.op)}` };
      return { ok: true, result: fn.call(this, req.args ?? {}) as never };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

const OPS = new Set<EngineOp>([
  'recordVisit', 'upsertText', 'addDwell', 'importVisits', 'search', 'timeline',
  'getPage', 'stats', 'deletePage', 'deleteDomain', 'exportDb', 'exportJson',
  'indexStatus', 'embedPending', 'storeEmbeddings', 'related', 'restoreDb', 'deleteAll',
]);

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
