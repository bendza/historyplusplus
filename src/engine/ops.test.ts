import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_DIM, EMBED_MODEL } from '../shared/protocol';
import { HistoryDb, SCHEMA_VERSION, migrate } from './db';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
let sqlite3: Sqlite3;
let raw: Database;
let h: HistoryDb;

// Wednesday 2026-10-14 15:00 local.
const NOW = new Date(2026, 9, 14, 15).getTime();
const T = (y: number, mo: number, d: number, hh = 12) => new Date(y, mo - 1, d, hh).getTime();

let seed = 7;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
}
function normalize(v: Float32Array): Float32Array {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const randomUnit = () => normalize(Float32Array.from({ length: EMBED_DIM }, rand));
/** A unit vector with cosine `sim` to unit vector `q`. */
function near(q: Float32Array, sim: number): Float32Array {
  const r = randomUnit();
  const d = r.reduce((a, x, i) => a + x * q[i]!, 0);
  const perp = normalize(r.map((x, i) => x - d * q[i]!));
  return normalize(q.map((x, i) => sim * x + Math.sqrt(1 - sim * sim) * perp[i]!));
}

function open(): { raw: Database; h: HistoryDb } {
  const r = new sqlite3.oo1.DB(':memory:');
  return { raw: r, h: new HistoryDb(r, () => sqlite3.capi.sqlite3_js_db_export(r), { sqlite3, now: () => NOW }) };
}

function visitWithText(db: HistoryDb, url: string, title: string, text: string, ts: number): number {
  db.recordVisit({ url, title, ts });
  return db.upsertText({ url, title, text, ts })!.pageId;
}

function embedAll(db: HistoryDb, r: Database, vecFor: (pageId: number) => Float32Array): void {
  for (;;) {
    const { items } = db.embedPending({ limit: 64 });
    if (!items.length) return;
    db.storeEmbeddings({
      model: EMBED_MODEL,
      items: items.map((x) => ({
        chunkId: x.chunkId,
        vector: vecFor(Number(r.selectValue('SELECT page_id FROM chunks WHERE id = ?', [x.chunkId]))),
      })),
    });
  }
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const count = (r: Database, sql: string) => Number(r.selectValue(sql));

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

beforeEach(() => {
  ({ raw, h } = open());
});

describe('search with plain-language dates', () => {
  beforeEach(() => {
    h.recordVisit({ url: 'https://chess.com/game/1', title: 'Chess game', ts: T(2026, 10, 6) });
    h.recordVisit({ url: 'https://chess.com/game/2', title: 'Chess game two', ts: T(2026, 9, 20) });
    h.recordVisit({ url: 'https://news.com/a', title: 'News', ts: T(2026, 10, 13) });
  });

  it('filters by the phrase, strips it from the keyword query and returns dateLabel', () => {
    const r = h.search({ q: 'chess games I played last week' });
    expect(r.dateLabel).toBe('Last week · Oct 5–11');
    expect(r.parsed).toMatchObject({ text: 'chess games I played', after: T(2026, 10, 5, 0), before: T(2026, 10, 12, 0) });
    expect(r.hits.map((x) => x.url)).toEqual(['https://chess.com/game/1']);
  });

  it('date-only query lists the period newest first', () => {
    const r = h.search({ q: 'yesterday' });
    expect(r.dateLabel).toBe('Yesterday · Oct 13');
    expect(r.hits.map((x) => x.url)).toEqual(['https://news.com/a']);
  });

  it('dateLabel is null without a phrase, and through handle()', () => {
    expect(h.search({ q: 'chess' }).dateLabel).toBeNull();
    const res = h.handle({ op: 'search', args: { q: 'chess u septembru' } });
    expect(res.ok && res.result).toMatchObject({ dateLabel: 'September 2026', total: 1 });
  });

  it('a phrase that leaves nothing is searched as plain words instead', () => {
    visitWithText(h, 'https://jobs.com/1', 'Engineer', 'Netconomy GmbH Belgrade, posted 4 months ago, hybrid.', T(2026, 10, 10));
    const r = h.search({ q: 'posted 4 months ago' });
    expect(r.dateLabel).toBeNull();
    expect(r.parsed.after).toBeNull();
    expect(r.hits.map((x) => x.url)).toEqual(['https://jobs.com/1']);
  });
});

describe('keyword: stopwords and the loose fallback', () => {
  it('long questions still find pages with most of their words, exact matches first', () => {
    const exact = visitWithText(h, 'https://a.com/', 'Window cleaning robot', 'A robot that cleans windows on tall buildings.', 1);
    const most = visitWithText(h, 'https://b.com/', 'Robot for buildings', 'Robots that wash facades of tall buildings.', 2);
    visitWithText(h, 'https://c.com/', 'Tall tales', 'Nothing relevant here at all.', 3);
    const r = h.search({ q: 'the robot that cleans windows of tall buildings' });
    expect(r.hits[0]!.id).toBe(exact);
    expect(r.hits.map((x) => x.id)).toContain(most);
    expect(r.total).toBe(2); // c.com only has "tall"
  });

  it('enough strict matches: no loose expansion', () => {
    for (let i = 0; i < 3; i++) visitWithText(h, `https://s${i}.com/`, `Berlin side events ${i}`, 'Side events in Berlin.', i + 1);
    visitWithText(h, 'https://x.com/', 'Berlin', 'Only Berlin and events.', 9);
    expect(h.search({ q: 'berlin side events' }).total).toBe(3);
  });
});

describe('related', () => {
  const q = randomUnit();
  let src: number, close: number, dup: number, far: number, closeDup: number;

  beforeEach(() => {
    src = h.recordVisit({ url: 'https://a.com/kite', title: 'Kitesurf jumps', ts: 1 })!.pageId;
    dup = h.recordVisit({ url: 'https://a.com/kite?utm=x2', title: 'Kitesurf jumps', ts: 2 })!.pageId;
    close = h.recordVisit({ url: 'https://b.com/wind', title: 'Wind forecast Ulcinj', ts: 3 })!.pageId;
    closeDup = h.recordVisit({ url: 'https://b.com/wind?x=1', title: 'Wind forecast Ulcinj', ts: 4 })!.pageId;
    far = h.recordVisit({ url: 'https://c.com/tax', title: 'Tax return', ts: 5 })!.pageId;
    const sims: Record<number, number> = { [src]: 1, [dup]: 0.99, [close]: 0.93, [closeDup]: 0.92, [far]: 0.1 };
    embedAll(h, raw, (p) => near(q, sims[p]!));
  });

  it('nearest pages by meaning, without itself, same-title duplicates or far pages', () => {
    const r = h.related({ pageId: src });
    expect(r.hits.map((x) => x.id)).toEqual([close]);
    expect(r.hits[0]).toMatchObject({ match: 'meaning', title: 'Wind forecast Ulcinj', url: 'https://b.com/wind' });
    expect(typeof r.hits[0]!.snippet).toBe('string');
  });

  it('empty for unknown or not-yet-embedded pages; via handle()', () => {
    expect(h.related({ pageId: 999 }).hits).toEqual([]);
    const fresh = h.recordVisit({ url: 'https://new.com/', title: 'New', ts: 9 })!.pageId;
    expect(h.related({ pageId: fresh }).hits).toEqual([]);
    const res = h.handle({ op: 'related', args: { pageId: src, limit: 1 } });
    expect(res.ok && (res.result as { hits: unknown[] }).hits.length).toBe(1);
  });
});

describe('deleteAll', () => {
  it('wipes pages, visits, chunks, FTS and vectors; keeps schema/meta; db stays usable', () => {
    const q = randomUnit();
    visitWithText(h, 'https://a.com/', 'Berlin', 'Berlin side events', 1);
    h.recordVisit({ url: 'https://b.com/', title: 'Munich', ts: 2 });
    embedAll(h, raw, () => near(q, 0.95));
    expect(h.search({ q: 'berlin', queryVector: q }).hits.length).toBeGreaterThan(0); // loads the vector cache

    expect(h.handle({ op: 'deleteAll', args: {} })).toEqual({ ok: true, result: { ok: true } });
    for (const t of ['pages', 'visits', 'chunks']) expect(count(raw, `SELECT count(*) FROM ${t}`)).toBe(0);
    expect(count(raw, "SELECT count(*) FROM pages_fts WHERE pages_fts MATCH 'berlin'")).toBe(0);
    expect(raw.selectValue("SELECT value FROM meta WHERE key = 'schema_version'")).toBe(String(SCHEMA_VERSION));
    expect(h.search({ q: 'berlin', queryVector: q }).hits).toEqual([]);

    // Triggers are back: new data is indexed and chunked as usual.
    visitWithText(h, 'https://c.com/', 'Berlin again', 'More Berlin', 3);
    expect(h.search({ q: 'berlin' }).hits.map((x) => x.url)).toEqual(['https://c.com']);
    embedAll(h, raw, () => near(q, 0.95));
    expect(h.search({ q: 'zzz', queryVector: q }).hits.map((x) => [x.url, x.match])).toEqual([['https://c.com', 'meaning']]);
  });
});

describe('restoreDb', () => {
  function backupOf(fill: (db: HistoryDb, r: Database) => void): string {
    const o = open();
    fill(o.h, o.raw);
    const bytes = o.h.exportDb().bytes;
    o.raw.close();
    return bytes;
  }

  it('replaces all data with the backup: pages, visits, text, FTS, vectors', () => {
    const q = randomUnit();
    const backup = backupOf((b, r) => {
      visitWithText(b, 'https://kept.com/', 'Lisbon apartment', 'Flat near tram 28 in Lisbon.', T(2026, 10, 1));
      b.recordVisit({ url: 'https://kept.com/', title: 'Lisbon apartment', ts: T(2026, 10, 2) });
      b.recordVisit({ url: 'https://other.com/', title: 'Other', ts: T(2026, 9, 1) });
      embedAll(b, r, () => near(q, 0.95));
    });
    visitWithText(h, 'https://gone.com/', 'Old data', 'Should disappear', 1);
    h.search({ q: 'old', queryVector: q }); // load the vector cache before the swap

    const res = h.handle({ op: 'restoreDb', args: { bytes: backup } });
    expect(res).toEqual({ ok: true, result: { pages: 2, visits: 3 } });
    expect(h.search({ q: 'disappear' }).total).toBe(0);
    const hit = h.search({ q: 'tram lisbon' }).hits[0]!;
    expect(hit).toMatchObject({ url: 'https://kept.com', visit_count: 2, has_text: true });
    expect(h.getPage({ id: hit.id })!.text).toBe('Flat near tram 28 in Lisbon.');
    expect(h.indexStatus()).toMatchObject({ pages: 2, chunksEmbedded: count(raw, 'SELECT count(*) FROM chunks'), pagesEmbedded: 2 });
    expect(h.search({ q: 'zzz', queryVector: q }).hits.map((x) => x.match)).toEqual(['meaning', 'meaning']);
    // Still a live, trigger-maintained database.
    h.upsertText({ url: 'https://kept.com/', title: 'Lisbon apartment', text: 'Now about Porto.', ts: T(2026, 10, 3) });
    expect(h.search({ q: 'porto' }).total).toBe(1);
    expect(h.search({ q: 'tram' }).total).toBe(0);
  });

  it('migrates an older (v1) backup forward', () => {
    const o = new sqlite3.oo1.DB(':memory:');
    migrate(o, 1);
    o.exec(`INSERT INTO pages(id, url, domain, title, text, first_seen, last_seen, visit_count)
            VALUES (1, 'https://v1.com/', 'v1.com', 'Old schema page', 'Sandstone climbing', 5, 5, 1);
            INSERT INTO visits(page_id, ts) VALUES (1, 5);`);
    const backup = b64(sqlite3.capi.sqlite3_js_db_export(o));
    o.close();
    expect(h.restoreDb({ bytes: backup })).toEqual({ pages: 1, visits: 1 });
    expect(h.search({ q: 'sandstone' }).hits[0]).toMatchObject({ url: 'https://v1.com/', has_text: true });
    expect(h.embedPending({ limit: 10 }).items.length).toBe(2); // title chunk + one passage, created lazily
  });

  it('drops vectors made with another model (they get re-embedded)', () => {
    const backup = backupOf((b, r) => {
      b.recordVisit({ url: 'https://a.com/', title: 'A', ts: 1 });
      embedAll(b, r, () => randomUnit());
      r.exec("UPDATE meta SET value = 'other-model' WHERE key = 'embed_model'");
    });
    h.restoreDb({ bytes: backup });
    expect(h.indexStatus().chunksEmbedded).toBe(0);
    expect(h.embedPending({ limit: 10 }).items.length).toBe(1);
  });

  it('rejects bad input and leaves the current data untouched', () => {
    visitWithText(h, 'https://mine.com/', 'Mine', 'precious data', 1);
    const plain = new sqlite3.oo1.DB(':memory:');
    plain.exec('CREATE TABLE foo(x); INSERT INTO foo VALUES (1);');
    const notOurs = b64(sqlite3.capi.sqlite3_js_db_export(plain));
    plain.close();
    const newer = backupOf((_b, r) => r.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`));
    const truncated = backupOf((b) => b.recordVisit({ url: 'https://x.com/', ts: 1 })).slice(0, 2000);
    const cases: [string, RegExp][] = [
      ['', /no data/],
      ['%%%not base64', /not base64/],
      [btoa('hello world, definitely not sqlite'.repeat(30)), /not a SQLite database/],
      [notOurs, /not a history\+\+ backup/],
      [newer, /newer history\+\+/],
      [truncated, /damaged|unreadable|not a history/],
    ];
    for (const [bytes, err] of cases) {
      const res = h.handle({ op: 'restoreDb', args: { bytes } });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(err);
    }
    expect(h.search({ q: 'precious' }).hits.map((x) => x.url)).toEqual(['https://mine.com']);
    expect(count(raw, 'SELECT count(*) FROM pages')).toBe(1);
    expect(count(raw, "SELECT count(*) FROM pragma_database_list WHERE name = 'restore_src'")).toBe(0);
  });

  it('restoreBytes takes raw file bytes; opfsFile alone is left to the worker', () => {
    const o = open();
    o.h.recordVisit({ url: 'https://raw.com/', title: 'Raw', ts: 1 });
    expect(h.restoreBytes(o.h.exportBytes())).toEqual({ pages: 1, visits: 1 });
    o.raw.close();
    expect(h.handle({ op: 'restoreDb', args: { opfsFile: 'restore-upload.sqlite3' } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only supported in the engine worker/),
    });
  });

  it('needs the sqlite3 module', () => {
    const r = new sqlite3.oo1.DB(':memory:');
    const bare = new HistoryDb(r);
    expect(bare.handle({ op: 'restoreDb', args: { bytes: 'AA==' } })).toEqual({ ok: false, error: 'restoreDb not available' });
  });
});

describe('upsertText with empty text', () => {
  it('updates only the title and keeps stored text', async () => {
    const sqlite3 = await (await import('@sqlite.org/sqlite-wasm')).default();
    const { HistoryDb } = await import('./db');
    const h = new HistoryDb(new sqlite3.oo1.DB(':memory:'));
    h.recordVisit({ url: 'https://portal.example.com/login', ts: 1 });
    h.upsertText({ url: 'https://portal.example.com/login', title: 'Sign in', text: '', ts: 2 });
    expect(h.search({ q: 'sign' }).hits.map((x) => [x.title, x.has_text])).toEqual([['Sign in', false]]);
    h.upsertText({ url: 'https://news.example.com/a', title: 'A', text: 'body words here', ts: 3 });
    expect(h.upsertText({ url: 'https://news.example.com/a', title: 'A2', text: '', ts: 4 })).toMatchObject({ changed: false });
    expect(h.search({ q: 'body words' }).hits[0]).toMatchObject({ title: 'A2', has_text: true });
  });
});

describe('search sort', () => {
  it("sort 'recent' returns the same matches, newest visit first", async () => {
    const sqlite3 = await (await import('@sqlite.org/sqlite-wasm')).default();
    const { HistoryDb } = await import('./db');
    const h = new HistoryDb(new sqlite3.oo1.DB(':memory:'));
    // The best keyword match is the oldest page.
    h.upsertText({ url: 'https://a.example.com/old', title: 'Lisbon apartments Lisbon', text: 'lisbon lisbon lisbon apartments', ts: 1_000 });
    h.upsertText({ url: 'https://b.example.com/mid', title: 'Travel notes', text: 'a weekend in lisbon', ts: 2_000 });
    h.upsertText({ url: 'https://c.example.com/new', title: 'Flights', text: 'cheap flights to lisbon', ts: 3_000 });
    const rel = h.search({ q: 'lisbon' }).hits.map((x) => x.url);
    const rec = h.search({ q: 'lisbon', sort: 'recent' }).hits.map((x) => x.url);
    expect(rel[0]).toContain('/old');
    expect(rec).toEqual(['https://c.example.com/new', 'https://b.example.com/mid', 'https://a.example.com/old']);
    expect([...rec].sort()).toEqual([...rel].sort());
  });
});
