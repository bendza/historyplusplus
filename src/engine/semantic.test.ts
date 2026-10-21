import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_DIM, EMBED_MODEL } from '../shared/protocol';
import { HistoryDb, MEANING_MIN_SIM, MEANING_REL_SIM, SCHEMA_VERSION, migrate } from './db';
import { MAX_TEXT_CHUNKS } from './chunk';
import { VectorIndex, dequantize, quantize } from './vectors';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
let sqlite3: Sqlite3;
let raw: Database;
let h: HistoryDb;

const T = (y: number, mo: number, d: number, hh = 12) => new Date(y, mo - 1, d, hh).getTime();

// ---- synthetic e5-like vectors ----
let seed = 1;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
}
function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return v.map((x) => x / n);
}
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
function randomUnit(): Float32Array {
  return normalize(Float32Array.from({ length: EMBED_DIM }, rand));
}
/** A unit vector with cosine `sim` to unit vector `q`. */
function near(q: Float32Array, sim: number): Float32Array {
  const r = randomUnit();
  const d = dot(r, q);
  const perp = normalize(r.map((x, i) => x - d * q[i]!));
  return normalize(q.map((x, i) => sim * x + Math.sqrt(1 - sim * sim) * perp[i]!));
}

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

beforeEach(() => {
  raw = new sqlite3.oo1.DB(':memory:');
  h = new HistoryDb(raw);
});

function visitWithText(url: string, title: string, text: string, ts: number) {
  h.recordVisit({ url, title, ts });
  return h.upsertText({ url, title, text, ts })!.pageId;
}
const count = (sql: string, bind?: unknown[]) => Number(raw.selectValue(sql, bind as never));
const pageOfChunk = (chunkId: number) => Number(raw.selectValue('SELECT page_id FROM chunks WHERE id = ?', [chunkId]));

/** Drain the embed queue like the offscreen embedder does; `vecFor` picks each chunk's vector. */
function embedAll(vecFor: (pageId: number, chunkId: number, text: string) => Float32Array, batch = 7): number {
  let n = 0;
  for (;;) {
    const { items } = h.embedPending({ limit: batch });
    if (!items.length) return n;
    const r = h.storeEmbeddings({
      model: EMBED_MODEL,
      items: items.map((it) => ({ chunkId: it.chunkId, vector: vecFor(pageOfChunk(it.chunkId), it.chunkId, it.text) })),
    });
    expect(r.stored).toBe(items.length);
    n += r.stored;
  }
}

describe('migration v1 -> v2', () => {
  it('upgrades a v1 database with data, backfilling has_text and chunking lazily', () => {
    const db = new sqlite3.oo1.DB(':memory:');
    expect(migrate(db, 1)).toBe(1);
    db.exec(`INSERT INTO pages(id, url, domain, title, text, first_seen, last_seen, visit_count)
             VALUES (1, 'https://a.com/side-events', 'a.com', 'Side events', 'Berlin side events list.', 1, 10, 1),
                    (2, 'https://b.com/x', 'b.com', 'B', NULL, 1, 20, 1);
             INSERT INTO visits(page_id, ts) VALUES (1, 10), (2, 20);`);
    const h2 = new HistoryDb(db);
    expect(db.selectValue("SELECT value FROM meta WHERE key='schema_version'")).toBe(String(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBe(2);
    expect(db.selectArrays('SELECT id, has_text, chunked FROM pages ORDER BY id')).toEqual([[1, 1, 0], [2, 0, 0]]);
    expect(h2.search({ q: 'berlin' }).hits.map((x) => x.id)).toEqual([1]);
    expect(h2.embedPending({ limit: 10 }).items.map((x) => x.text)).toEqual([
      'B — b.com',
      'Side events — a.com side events',
      'Berlin side events list.',
    ]);
    expect(h2.stats().pagesWithText).toBe(1);
    db.close();
  });
});

describe('embedPending', () => {
  it('creates chunks lazily, most recently seen pages first, title chunk before passages', () => {
    const old = visitWithText('https://old.com/post', 'Old post', 'Old text.', T(2025, 1, 1));
    const recent = visitWithText('https://new.com/post', 'New post', 'New text one.\n\n' + 'x '.repeat(500), T(2025, 2, 1));
    h.recordVisit({ url: 'https://titleonly.com/some-page', title: 'Imported', ts: T(2025, 1, 15) });
    expect(count('SELECT count(*) FROM chunks')).toBe(0); // lazy

    const { items } = h.embedPending({ limit: 100 });
    const pages = items.map((x) => pageOfChunk(x.chunkId));
    expect(items[0]!.text).toBe('New post — new.com post');
    expect(pages.slice(0, 3)).toEqual([recent, recent, recent]);
    expect(items[3]!.text).toBe('Imported — titleonly.com some page');
    expect(pages.slice(4)).toEqual([old, old]);
    expect(items.map((x) => x.text)).not.toContainEqual(expect.stringMatching(/^passage: /));
  });

  it('is idempotent until stored, then moves on', () => {
    visitWithText('https://a.com', 'A', 'Alpha text.', 2);
    visitWithText('https://b.com', 'B', 'Beta text.', 1);
    const a = h.embedPending({ limit: 2 }).items;
    expect(h.embedPending({ limit: 2 }).items).toEqual(a);
    expect(count('SELECT count(*) FROM chunks')).toBe(4);
    h.storeEmbeddings({ model: EMBED_MODEL, items: a.map((x) => ({ chunkId: x.chunkId, vector: randomUnit() })) });
    const b = h.embedPending({ limit: 10 }).items;
    expect(b.map((x) => x.text)).toEqual(['B — b.com', 'Beta text.']);
    expect(count('SELECT count(*) FROM chunks')).toBe(4); // no duplicate chunk rows
  });

  it('caps text chunks per page', () => {
    visitWithText('https://long.com', 'Long', 'A fairly long sentence about nothing in particular. '.repeat(400), 1);
    h.embedPending({ limit: 1 });
    expect(count('SELECT count(*) FROM chunks WHERE ord > 0')).toBe(MAX_TEXT_CHUNKS);
  });

  it('chunks big histories in batches and walks the queue through indexes', () => {
    h.importVisits({ visits: Array.from({ length: 300 }, (_, i) => ({ url: `https://s${i}.com/p`, title: `P${i}`, ts: i + 1 })) });
    const first = h.embedPending({ limit: 5 }).items;
    expect(first.map((x) => x.text)).toEqual(['P299 — s299.com', 'P298 — s298.com', 'P297 — s297.com', 'P296 — s296.com', 'P295 — s295.com']);
    expect(count('SELECT count(*) FROM pages WHERE chunked = 0')).toBe(300 - 64);
    // Newly visited pages jump the queue even while older pages are still unchunked.
    h.recordVisit({ url: 'https://fresh.com', title: 'Fresh', ts: 10_000 });
    expect(h.embedPending({ limit: 1 }).items[0]!.text).toBe('Fresh — fresh.com');
    const plan = (sql: string) => raw.selectArrays('EXPLAIN QUERY PLAN ' + sql).map((r) => String(r[3])).join(' | ');
    expect(plan('SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY prio DESC, ord LIMIT 5')).toMatch(/chunks_pending/);
    expect(plan('SELECT id FROM pages WHERE chunked = 0 ORDER BY last_seen DESC LIMIT 5')).toMatch(/pages_unchunked/);
  });
});

describe('storeEmbeddings', () => {
  it('stores int8 vectors that round-trip with ~no loss, ignoring junk', () => {
    visitWithText('https://a.com', 'A', 'Alpha.', 1);
    const [c0, c1] = h.embedPending({ limit: 5 }).items;
    const v = randomUnit();
    const r = h.storeEmbeddings({
      model: EMBED_MODEL,
      items: [
        { chunkId: c0!.chunkId, vector: v },
        { chunkId: c1!.chunkId, vector: new Float32Array(10) }, // wrong dims
        { chunkId: 999_999, vector: v }, // unknown chunk
      ],
    });
    expect(r).toEqual({ stored: 1 });
    const blob = raw.selectValue('SELECT embedding FROM chunks WHERE id = ?', [c0!.chunkId]) as Uint8Array;
    expect(blob.byteLength).toBe(EMBED_DIM + 4);
    const back = dequantize(new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength));
    expect(dot(back, v)).toBeGreaterThan(0.999);
    expect(raw.selectValue('SELECT model FROM chunks WHERE id = ?', [c0!.chunkId])).toBe(EMBED_MODEL);
    expect(h.embedPending({ limit: 5 }).items.map((x) => x.chunkId)).toEqual([c1!.chunkId]);
  });

  it('quantize rounds and clamps', () => {
    const p = quantize([0.5, -0.25, 0.125, 0.001]);
    expect([...p.subarray(0, 4)]).toEqual([127, -63, 32, 0]); // max |v| maps to 127 (JS rounds -63.5 up)
    expect([...dequantize(p)].map((x) => +x.toFixed(3))).toEqual([0.5, -0.248, 0.126, 0]);
  });

  it('rejects vectors from another model', () => {
    expect(h.handle({ op: 'storeEmbeddings', args: { model: 'other/model', items: [] } })).toMatchObject({ ok: false });
  });
});

describe('hybrid search', () => {
  const q = randomUnit();
  let both: number, kwOnly: number, meaningOnly: number, far: number, belowRel: number, titleOnly: number;

  beforeEach(() => {
    kwOnly = visitWithText('https://kw.com/berlin', 'Berlin guide', 'Things to do in Berlin.', T(2025, 9, 1));
    both = visitWithText('https://both.com/events', 'Berlin side events', 'Side events around the conference in Berlin.', T(2025, 9, 2));
    meaningOnly = visitWithText('https://meaning.de/hauptstadt', 'Veranstaltungen', 'Veranstaltungen in der Hauptstadt <b>heute</b> & morgen.', T(2025, 9, 3));
    far = visitWithText('https://far.com/', 'Cooking', 'How to cook rice.', T(2025, 9, 4));
    belowRel = visitWithText('https://belowrel.com/', 'Loosely related', 'Something loosely related.', T(2025, 9, 5));
    titleOnly = h.recordVisit({ url: 'https://title-only.de/termine', title: 'Termine', ts: T(2025, 9, 6) })!.pageId;
    const sims: Record<number, number> = { [kwOnly]: 0.3, [both]: 0.885, [meaningOnly]: 0.9, [far]: 0.5, [belowRel]: 0.81, [titleOnly]: 0.875 };
    embedAll((pageId, _c, text) => {
      // Text passages carry the meaning; the title chunk a bit less (title-only page: all of it).
      const s = sims[pageId]!;
      return near(q, text.includes(' — ') && pageId !== titleOnly ? s - 0.05 : s);
    });
  });

  it('fuses keyword and meaning hits with RRF and labels them', () => {
    const r = h.search({ q: 'berlin', queryVector: q });
    const byId = new Map(r.hits.map((x) => [x.id, x]));
    expect(r.total).toBe(4);
    expect(byId.get(both)!.match).toBe('both');
    expect(byId.get(kwOnly)!.match).toBe('keyword');
    expect(byId.get(meaningOnly)!.match).toBe('meaning');
    expect(byId.get(titleOnly)!.match).toBe('meaning');
    expect(byId.has(far)).toBe(false); // below MEANING_MIN_SIM
    expect(byId.has(belowRel)).toBe(false); // above the pre-filter but > MEANING_REL_SIM below the best
    expect(0.81).toBeGreaterThan(MEANING_MIN_SIM);
    expect(0.9 - 0.81).toBeGreaterThan(MEANING_REL_SIM);
    // 'both' is in both lists: highest fused score. Scores are RRF, best first.
    expect(r.hits[0]!.id).toBe(both);
    const scores = r.hits.map((x) => x.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(r.hits[0]!.score).toBeCloseTo(1 / 62 + 1 / 62, 6); // keyword rank 2 + meaning rank 2
  });

  it('snippets: FTS marks for keyword hits, escaped best chunk for meaning hits, URL for title-only', () => {
    const r = h.search({ q: 'berlin', queryVector: q });
    const byId = new Map(r.hits.map((x) => [x.id, x]));
    expect(byId.get(both)!.snippet).toContain('<mark>Berlin</mark>');
    expect(byId.get(meaningOnly)!.snippet).toBe('Veranstaltungen in der Hauptstadt &lt;b&gt;heute&lt;/b&gt; &amp; morgen.');
    expect(byId.get(titleOnly)!.snippet).toBe('https://title-only.de/termine');
  });

  it('applies site: and date filters to meaning hits', () => {
    expect(h.search({ q: 'berlin site:meaning.de', queryVector: q }).hits.map((x) => [x.id, x.match])).toEqual([
      [meaningOnly, 'meaning'],
    ]);
    const r = h.search({ q: 'berlin before:2025-09-03', queryVector: q });
    expect(r.hits.map((x) => x.id).sort()).toEqual([kwOnly, both].sort());
    // The relative floor is computed after filtering: belowRel is the best on its own site.
    expect(h.search({ q: 'berlin site:belowrel.com', queryVector: q }).hits.map((x) => x.id)).toEqual([belowRel]);
  });

  it('paginates over the fused list', () => {
    const all = h.search({ q: 'berlin', queryVector: q }).hits.map((x) => x.id);
    const p1 = h.search({ q: 'berlin', queryVector: q, limit: 2 });
    const p2 = h.search({ q: 'berlin', queryVector: q, limit: 2, offset: 2 });
    expect([...p1.hits, ...p2.hits].map((x) => x.id)).toEqual(all);
    expect(p2.total).toBe(4);
  });

  it('keyword mode, missing vector or pure operators: keyword behavior', () => {
    for (const r of [h.search({ q: 'berlin', queryVector: q, mode: 'keyword' }), h.search({ q: 'berlin' })]) {
      expect(r.total).toBe(2);
      expect(r.hits.every((x) => x.match === 'keyword')).toBe(true);
    }
    expect(h.search({ q: 'site:meaning.de', queryVector: q }).hits.map((x) => [x.id, x.match, x.score])).toEqual([
      [meaningOnly, 'keyword', 0],
    ]);
    // Wrong-sized vector is ignored rather than failing the search.
    expect(h.search({ q: 'berlin', queryVector: new Float32Array(3) }).total).toBe(2);
  });

  it('falls back to keyword results when nothing is semantically close', () => {
    const r = h.search({ q: 'berlin', queryVector: randomUnit() });
    expect(r.hits.map((x) => x.match)).toEqual(['keyword', 'keyword']);
  });

  it('works through handle() with a structured-clone Float32Array', () => {
    const res = h.handle({ op: 'search', args: { q: 'hauptstadt', queryVector: q } });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { hits: { id: number; match: string }[] }).hits[0]).toMatchObject({ id: meaningOnly, match: 'both' });
  });
});

describe('similarity floors (real e5-small numbers)', () => {
  it('keeps a weak cross-lingual match, drops the unrelated page', () => {
    const q = randomUnit();
    const de = visitWithText('https://wandern.de/sandstein', 'Wanderung', 'Wanderung durch die Sandsteinfelsen.', 1);
    const en = visitWithText('https://other.com/', 'Other', 'Unrelated English text.', 2);
    const sims: Record<number, number> = { [de]: 0.781, [en]: 0.744 };
    embedAll((pageId, _c, text) => near(q, text.includes(' — ') ? sims[pageId]! - 0.03 : sims[pageId]!));
    const r = h.search({ q: 'sandstone hiking trail', queryVector: q });
    expect(r.hits.map((x) => [x.id, x.match])).toEqual([[de, 'meaning']]);
  });
});

describe('per-query background floor', () => {
  it('in a large index, drops the best hit when it does not stand out from that query\'s background', () => {
    const q = randomUnit();
    // 600 unrelated pages all scoring ~0.78 +- 0.02 (like real e5 titles), none standing out.
    const ids: number[] = [];
    for (let i = 0; i < 600; i++) ids.push(h.recordVisit({ url: `https://bg${i}.com/`, title: `Background ${i}`, ts: i + 1 })!.pageId);
    const jitter = new Map(ids.map((id) => [id, 0.78 + (rand() - 0.5) * 0.06]));
    embedAll((pageId) => near(q, jitter.get(pageId)!), 64);
    expect(h.search({ q: 'quantum entanglement', queryVector: q }).hits).toEqual([]);

    // One page clearly above the background (z >> MEANING_Z) is kept, alone.
    const hit = h.recordVisit({ url: 'https://physics.org/', title: 'Quantum entanglement explained', ts: 9999 })!.pageId;
    embedAll(() => near(q, 0.87));
    expect(h.search({ q: 'zzzz', queryVector: q }).hits.map((x) => [x.id, x.match])).toEqual([[hit, 'meaning']]);
  });
});

describe('index consistency', () => {
  const q = randomUnit();
  const meaningIds = (query = 'zzzz') => h.search({ q: query, queryVector: q }).hits.filter((x) => x.match !== 'keyword').map((x) => x.id);

  it('text change drops and re-queues passages (and their cached vectors); title chunk stays', () => {
    const id = visitWithText('https://a.com/p', 'Page', 'Original body about the topic.', 1);
    embedAll((_p, _c, text) => (text.startsWith('Original') ? near(q, 0.95) : randomUnit()));
    expect(meaningIds()).toEqual([id]); // loads the cache
    const titleChunkId = Number(raw.selectValue('SELECT id FROM chunks WHERE page_id = ? AND ord = 0', [id]));

    h.upsertText({ url: 'https://a.com/p', title: 'Page', text: 'Completely different body.', ts: 2 });
    expect(count('SELECT count(*) FROM chunks WHERE page_id = ? AND ord > 0', [id])).toBe(0);
    expect(meaningIds()).toEqual([]); // stale passage vector is gone from the cache too
    const pending = h.embedPending({ limit: 10 }).items;
    expect(pending.map((x) => x.text)).toEqual(['Completely different body.']);
    expect(count('SELECT count(*) FROM chunks WHERE id = ? AND embedding IS NOT NULL', [titleChunkId])).toBe(1);
  });

  it('title change re-queues only the title chunk', () => {
    const id = visitWithText('https://a.com/p', 'Old title', 'Body.', 1);
    embedAll(() => randomUnit());
    h.recordVisit({ url: 'https://a.com/p', title: 'New title', ts: 5 });
    h.recordVisit({ url: 'https://a.com/p', title: 'New title', ts: 6 }); // same title: no churn
    expect(h.embedPending({ limit: 10 }).items.map((x) => x.text)).toEqual(['New title — a.com']);
    expect(count('SELECT count(*) FROM chunks WHERE page_id = ? AND ord = 1 AND embedding IS NOT NULL', [id])).toBe(1);
  });

  it('deletePage / deleteDomain remove chunks and cached vectors', () => {
    const a = visitWithText('https://a.com/p', 'A', 'Alpha.', 1);
    const b = visitWithText('https://sub.b.com/p', 'B', 'Beta.', 2);
    const c = visitWithText('https://c.com/p', 'C', 'Gamma.', 3);
    embedAll(() => near(q, 0.95));
    expect(meaningIds().sort()).toEqual([a, b, c].sort());
    h.deletePage({ id: a });
    expect(meaningIds().sort()).toEqual([b, c].sort());
    h.deleteDomain({ domain: 'b.com' });
    expect(meaningIds()).toEqual([c]);
    expect(raw.selectValues('SELECT DISTINCT page_id FROM chunks')).toEqual([c]);
    // Chunk ids freed by deletes may be reused; the cache must not confuse them.
    const d = visitWithText('https://d.com/p', 'D', 'Delta.', 4);
    embedAll(() => near(q, 0.97));
    expect(meaningIds()).toEqual([d, c]);
  });

  it('model change invalidates every vector on open', () => {
    visitWithText('https://a.com/p', 'A', 'Alpha.', 1);
    expect(embedAll(() => near(q, 0.95))).toBe(2);
    expect(h.indexStatus()).toMatchObject({ chunksEmbedded: 2, model: EMBED_MODEL });
    new HistoryDb(raw); // same model: nothing happens
    expect(h.indexStatus().chunksEmbedded).toBe(2);
    raw.exec("UPDATE chunks SET model = 'old/model'; UPDATE meta SET value = 'old/model' WHERE key = 'embed_model'");
    const h2 = new HistoryDb(raw);
    expect(h2.indexStatus()).toMatchObject({ chunksTotal: 2, chunksEmbedded: 0, pagesEmbedded: 0, model: null });
    expect(h2.embedPending({ limit: 10 }).items).toHaveLength(2);
  });
});

describe('indexStatus', () => {
  it('counts pages, chunks and vectors, by month newest first', () => {
    visitWithText('https://a.com/1', 'A1', 'Text one.', T(2025, 9, 10));
    visitWithText('https://a.com/2', 'A2', 'Text two.', T(2025, 9, 20));
    h.recordVisit({ url: 'https://a.com/3', title: 'A3', ts: T(2025, 10, 1) });
    h.recordVisit({ url: 'https://a.com/4', title: 'A4', ts: T(2025, 8, 1) });
    const empty = h.indexStatus();
    expect(empty).toMatchObject({ pages: 4, pagesWithText: 2, titleOnlyPages: 2, chunksTotal: 4, chunksEmbedded: 0, pagesEmbedded: 0, model: null }); // 4 unchunked pages count as pending
    expect(empty.embedder).toBeUndefined();

    // Embed just the newest two pages' chunks.
    const items = h.embedPending({ limit: 3 }).items; // A3 title, A2 title, A2 text
    h.storeEmbeddings({ model: EMBED_MODEL, items: items.map((x) => ({ chunkId: x.chunkId, vector: randomUnit() })) });
    const s = h.indexStatus();
    expect(s).toMatchObject({ chunksTotal: 6, chunksEmbedded: 3, pagesEmbedded: 2, model: EMBED_MODEL });
    expect(s.byMonth).toEqual([
      { month: '2025-10', pages: 1, withText: 0, embedded: 1 },
      { month: '2025-09', pages: 2, withText: 2, embedded: 1 },
      { month: '2025-08', pages: 1, withText: 0, embedded: 0 },
    ]);
  });

  it('keeps at most 24 months', () => {
    h.importVisits({ visits: Array.from({ length: 30 }, (_, i) => ({ url: `https://m${i}.com`, ts: T(2023, 1 + i, 5) })) });
    const s = h.indexStatus();
    expect(s.byMonth).toHaveLength(24);
    expect(s.byMonth[0]!.month).toBe('2025-06');
  });
});

describe('performance', () => {
  const q0 = randomUnit();

  it('brute-force scans 100k vectors fast', () => {
    const N = 100_000;
    const idx = new VectorIndex();
    const pool = Array.from({ length: 1000 }, () => quantize(randomUnit()));
    for (let i = 0; i < N; i++) idx.upsert(i + 1, (i >> 3) + 1, pool[i % pool.length]!);
    const target = randomUnit();
    idx.upsert(N + 1, 999_999, quantize(target));
    idx.search(target, 0.8); // warm up the JIT
    const t0 = performance.now();
    const hits = idx.search(target, 0.8);
    const ms = performance.now() - t0;
    console.info(`[perf] vector search over ${N} x ${EMBED_DIM} int8: ${ms.toFixed(1)} ms`);
    expect(hits[0]).toMatchObject({ pageId: 999_999, chunkId: N + 1 });
    expect(hits[0]!.sim).toBeGreaterThan(0.99);
    expect(ms).toBeLessThan(300);
  });

  it('tombstones and compaction keep results right', () => {
    const idx = new VectorIndex();
    const vs = Array.from({ length: 3000 }, () => randomUnit());
    vs.forEach((v, i) => idx.upsert(i + 1, i + 1, quantize(v)));
    for (let i = 1; i <= 2000; i++) idx.remove(i); // triggers compaction
    expect(idx.size).toBe(1000);
    expect(idx.has(1)).toBe(false);
    expect(idx.search(vs[2500]!, 0.9, 6)[0]).toMatchObject({ pageId: 2501 });
    expect(idx.search(vs[10]!, 0.9, 6)).toEqual([]);
  });

  it('indexStatus, embedPending and hybrid search stay fast on 12k pages', () => {
    const N = 12_000;
    const body = 'Some readable page text about a topic. '.repeat(60);
    for (let i = 0; i < N; i++) {
      const url = `https://site${i % 300}.com/article-${i}`;
      h.recordVisit({ url, title: `Article ${i}`, ts: T(2024, 1, 1) + i * 3_600_000 });
      if (i % 2 === 0) h.upsertText({ url, title: `Article ${i}`, text: body + i, ts: T(2024, 1, 1) + i * 3_600_000 });
    }
    let t0 = performance.now();
    const items = h.embedPending({ limit: 32 }).items;
    const pendingMs = performance.now() - t0;
    expect(items).toHaveLength(32);
    // Embed a few thousand chunks so the vector path has something to scan.
    for (let k = 0; k < 100; k++) {
      const batch = h.embedPending({ limit: 64 }).items;
      const vector = (i: number) => (i % 40 === 0 ? near(q0, 0.85 + (i % 7) / 100) : randomUnit());
      h.storeEmbeddings({ model: EMBED_MODEL, items: batch.map((x, i) => ({ chunkId: x.chunkId, vector: vector(i) })) });
    }
    t0 = performance.now();
    const s = h.indexStatus();
    const statusMs = performance.now() - t0;
    expect(s.pages).toBe(N);
    expect(s.chunksEmbedded).toBe(6400);
    h.search({ q: 'article', queryVector: q0 }); // loads the cache
    t0 = performance.now();
    const r = h.search({ q: 'readable topic', queryVector: q0 });
    const searchMs = performance.now() - t0;
    expect(r.hits.some((x) => x.match !== 'keyword')).toBe(true);
    console.info(`[perf] 12k pages: embedPending ${pendingMs.toFixed(1)} ms, indexStatus ${statusMs.toFixed(1)} ms, hybrid search ${searchMs.toFixed(1)} ms`);
    expect(statusMs).toBeLessThan(300);
    expect(searchMs).toBeLessThan(500);
  }, 60_000);
});

describe('result diversity', () => {
  it('shows one of each duplicate page, caps one site, and ranks search-result pages lower', () => {
    const q = randomUnit();
    const other = randomUnit();
    const ids: Record<string, number> = {};
    // One job-board dashboard visited under five query strings, all matching the query words.
    for (let i = 0; i < 5; i++) ids[`dash${i}`] = visitWithText(`https://board.example/matches?tab=${i}`, 'Board | Matches', 'quokka quokka island notes', T(2025, 9, 1, 8 + i));
    // Three different pages on that site.
    for (let i = 0; i < 3; i++) ids[`board${i}`] = visitWithText(`https://board.example/job/${i}`, `Job ${i}`, 'quokka listing', T(2025, 9, 2, 8 + i));
    ids.serp = visitWithText('https://www.google.com/search?q=quokka', 'quokka - Google Search', 'quokka quokka quokka island', T(2025, 9, 3));
    ids.real = visitWithText('https://en.wikipedia.org/wiki/Quokka', 'Quokka', 'small marsupial on rottnest island', T(2025, 8, 1));
    embedAll((pageId) => (pageId === ids.real ? near(q, 0.95) : near(other, 0.9)));

    const hits = h.search({ q: 'quokka island', queryVector: q }).hits;
    const top = hits.map((x) => x.url);
    expect(top.filter((u) => u.includes('/matches')).length).toBe(1);
    expect(top.slice(0, 4).filter((u) => u.includes('board.example')).length).toBeLessThanOrEqual(2);
    expect(top[0]).toBe('https://en.wikipedia.org/wiki/Quokka');
    expect(top.indexOf('https://www.google.com/search?q=quokka')).toBeGreaterThan(0);

    // All switches off: the old behaviour (every duplicate listed).
    h.tuning.collapseDuplicates = 0;
    h.tuning.perSiteCap = 0;
    h.tuning.serpWeight = 1;
    expect(h.search({ q: 'quokka island', queryVector: q }).hits.filter((x) => x.url.includes('/matches')).length).toBe(5);
  });

  it('recognises search-engine result pages only', async () => {
    const { isSearchResultsPage } = await import('./db');
    for (const u of ['https://www.google.com/search?q=x', 'https://www.google.com/sorry/index?continue=x', 'https://www.google.co.uk/search?q=x', 'https://www.bing.com/search?q=x', 'https://duckduckgo.com/?q=x', 'https://search.brave.com/search?q=x']) {
      expect(isSearchResultsPage(u), u).toBe(true);
    }
    for (const u of ['https://www.google.com/maps', 'https://docs.google.com/document/d/1', 'https://duckduckgo.com/about', 'https://example.com/search?q=x']) {
      expect(isSearchResultsPage(u), u).toBe(false);
    }
  });
});
