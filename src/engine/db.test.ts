import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS } from '../shared/protocol';
import { HistoryDb, SCHEMA_VERSION, migrate } from './db';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
let sqlite3: Sqlite3;
let raw: Database;
let h: HistoryDb;

const T = (y: number, mo: number, d: number, hh = 12, mm = 0) => new Date(y, mo - 1, d, hh, mm).getTime();
const ids = (r: { hits: { url: string }[] }) => r.hits.map((x) => x.url).sort();
const ftsCount = (q: string) => Number(raw.selectValue('SELECT count(*) FROM pages_fts WHERE pages_fts MATCH ?', [q]));

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

beforeEach(() => {
  raw = new sqlite3.oo1.DB(':memory:');
  h = new HistoryDb(raw, () => sqlite3.capi.sqlite3_js_db_export(raw));
});

function visitWithText(url: string, title: string, text: string, ts: number) {
  h.recordVisit({ url, title, ts });
  return h.upsertText({ url, title, text, ts });
}

describe('schema', () => {
  it('has FTS5 and records schema_version; migrate is idempotent', () => {
    expect(raw.selectValue("SELECT sqlite_compileoption_used('ENABLE_FTS5')")).toBe(1);
    expect(raw.selectValue("SELECT value FROM meta WHERE key='schema_version'")).toBe(String(SCHEMA_VERSION));
    expect(migrate(raw)).toBe(SCHEMA_VERSION);
  });
});

describe('recordVisit', () => {
  it('normalizes the URL and upserts the page, bumping counters', () => {
    const a = h.recordVisit({ url: 'https://WWW.Example.com/a?utm_source=x#frag', title: 'A', ts: 1000, transition: 'link' })!;
    const b = h.recordVisit({ url: 'https://www.example.com/a', title: 'A2', ts: 2000 })!;
    expect(a.pageId).toBe(b.pageId);
    expect(a.visitId).not.toBe(b.visitId);
    const p = h.getPage({ id: a.pageId })!;
    expect(p).toMatchObject({ url: 'https://www.example.com/a', domain: 'example.com', title: 'A2', visit_count: 2, first_seen: 1000, last_seen: 2000, has_text: false, text: null });
  });

  it('returns null for non-web URLs', () => {
    expect(h.recordVisit({ url: 'chrome://settings', ts: 1 })).toBeNull();
    expect(h.recordVisit({ url: 'file:///etc/passwd', ts: 1 })).toBeNull();
  });

  it('is idempotent on (page, ts)', () => {
    const a = h.recordVisit({ url: 'https://a.com', ts: 5 })!;
    const b = h.recordVisit({ url: 'https://a.com/', ts: 5 })!;
    expect(b).toEqual(a);
    expect(h.getPage({ id: a.pageId })!.visit_count).toBe(1);
  });

  it('does not let an older visit overwrite a newer title', () => {
    const { pageId } = h.recordVisit({ url: 'https://a.com', title: 'New', ts: 2000 })!;
    h.recordVisit({ url: 'https://a.com', title: 'Old', ts: 1000 });
    expect(h.getPage({ id: pageId })!.title).toBe('New');
  });
});

describe('upsertText', () => {
  it('dedupes by hash and caps length', () => {
    h.recordVisit({ url: 'https://a.com/x', ts: 1 });
    const r1 = h.upsertText({ url: 'https://a.com/x', title: 'X', text: 'hello world', lang: 'en', ts: 2 })!;
    const r2 = h.upsertText({ url: 'https://a.com/x', title: 'X', text: 'hello world', ts: 3 })!;
    expect(r1.changed).toBe(true);
    expect(r2).toEqual({ pageId: r1.pageId, changed: false });
    const r3 = h.upsertText({ url: 'https://a.com/x', title: 'X', text: 'z'.repeat(MAX_TEXT_CHARS + 500), ts: 4 })!;
    expect(r3.changed).toBe(true);
    const p = h.getPage({ id: r1.pageId })!;
    expect(p.text!.length).toBe(MAX_TEXT_CHARS);
    expect(p.lang).toBe('en');
    expect(p.has_text).toBe(true);
  });

  it('creates the page if no visit was recorded yet', () => {
    const r = h.upsertText({ url: 'https://new.com', title: 'N', text: 't', ts: 1 })!;
    expect(h.getPage({ id: r.pageId })!.visit_count).toBe(0);
  });
});

describe('addDwell', () => {
  it('adds to latest visit and page total; ignores unknown pages', () => {
    const v1 = h.recordVisit({ url: 'https://a.com', ts: 1000 })!;
    const v2 = h.recordVisit({ url: 'https://a.com', ts: 5000 })!;
    h.addDwell({ url: 'https://a.com/#x', dwellMs: 1500 });
    h.addDwell({ url: 'https://a.com', dwellMs: 500 });
    expect(h.addDwell({ url: 'https://nope.com', dwellMs: 10 })).toEqual({ ok: true });
    expect(h.getPage({ id: v1.pageId })!.total_dwell_ms).toBe(2000);
    expect(raw.selectValue('SELECT dwell_ms FROM visits WHERE id = ?', [v2.visitId])).toBe(2000);
    expect(raw.selectValue('SELECT dwell_ms FROM visits WHERE id = ?', [v1.visitId])).toBe(0);
  });
});

describe('importVisits', () => {
  it('is idempotent and skips junk', () => {
    const visits = [
      { url: 'https://a.com/1', title: 'One', ts: 1, transition: 'typed' },
      { url: 'https://a.com/1', title: 'One', ts: 2 },
      { url: 'https://b.com/', title: 'B', ts: 3 },
      { url: 'chrome://newtab', ts: 4 },
    ];
    expect(h.importVisits({ visits })).toEqual({ inserted: 3 });
    expect(h.importVisits({ visits })).toEqual({ inserted: 0 });
    const s = h.stats();
    expect(s.pages).toBe(2);
    expect(s.visits).toBe(3);
    expect(Number(raw.selectValue("SELECT visit_count FROM pages WHERE url = 'https://a.com/1'"))).toBe(2);
  });
});

describe('search', () => {
  beforeEach(() => {
    visitWithText('https://food.rs/cevapi', 'Najbolji ćevapi u Beogradu', 'Ćevapčići sa lukom i kajmakom. Šabac, Niš.', T(2025, 9, 10));
    visitWithText('https://github.com/x/react', 'React hooks guide', 'useState and useEffect explained in depth.', T(2025, 9, 20));
    visitWithText('https://gist.github.com/y', 'Snippet', 'a gist about reactivity', T(2025, 8, 5));
    visitWithText('https://evilgithub.com/', 'React phishing', 'react react react', T(2025, 9, 21));
    visitWithText('https://xss.test/', 'Sneaky', 'before <script>alert("x")</script> & reaction after', T(2025, 10, 1));
    h.recordVisit({ url: 'https://notext.com/react?a=1&b=<b>', title: 'React no text', ts: T(2025, 10, 2) });
  });

  it('matches without diacritics, and with them', () => {
    expect(ids(h.search({ q: 'cevapi' }))).toEqual(['https://food.rs/cevapi']);
    expect(ids(h.search({ q: 'ćevapi' }))).toEqual(['https://food.rs/cevapi']);
    expect(ids(h.search({ q: 'sabac' }))).toEqual(['https://food.rs/cevapi']);
    expect(ids(h.search({ q: 'cevapcici' }))).toEqual(['https://food.rs/cevapi']);
  });

  it('prefix-matches the last token', () => {
    const r = h.search({ q: 'reac' });
    expect(r.total).toBe(5);
    expect(ids(h.search({ q: 'useEff' }))).toEqual(['https://github.com/x/react']);
  });

  it('weights title above body', () => {
    // "hooks" only in title for github; "gist" page has "reactivity" only in body.
    const r = h.search({ q: 'react site:github.com' });
    expect(r.hits[0]!.url).toBe('https://github.com/x/react');
  });

  it('site: suffix-matches subdomains, not lookalikes', () => {
    expect(ids(h.search({ q: 'reac site:github.com' }))).toEqual(['https://gist.github.com/y', 'https://github.com/x/react']);
    expect(ids(h.search({ q: 'site:github.com site:food.rs' }))).toHaveLength(3);
  });

  it('before/after filter on visit time', () => {
    expect(ids(h.search({ q: 'reac after:2025-09 before:2025-10' }))).toEqual(['https://evilgithub.com', 'https://github.com/x/react']);
    expect(ids(h.search({ q: 'reac before:2025-09' }))).toEqual(['https://gist.github.com/y']);
    expect(ids(h.search({ q: 'after:2025-10-02' }))).toEqual(['https://notext.com/react?a=1&b=%3Cb%3E']);
  });

  it('operator-only queries list most recent pages', () => {
    const r = h.search({ q: '', limit: 2 });
    expect(r.total).toBe(6);
    expect(r.hits.map((x) => x.url)).toEqual(['https://notext.com/react?a=1&b=%3Cb%3E', 'https://xss.test']);
  });

  it('paginates with stable total', () => {
    const a = h.search({ q: 'reac', limit: 2, offset: 0 });
    const b = h.search({ q: 'reac', limit: 2, offset: 2 });
    expect(a.total).toBe(5);
    expect(b.total).toBe(5);
    expect(new Set([...a.hits, ...b.hits].map((x) => x.id)).size).toBe(4);
  });

  it('escapes snippets and marks matches', () => {
    const hit = h.search({ q: "alert" }).hits[0]!;
    expect(hit.snippet).toContain('&lt;script&gt;<mark>alert</mark>(&quot;x&quot;)&lt;/script&gt; &amp;');
    expect(hit.snippet).not.toMatch(/<script/);
    expect(hit.snippet.replace(/<\/?mark>/g, '')).not.toMatch(/[<>]/);
  });

  it('uses the escaped URL as snippet for pages without text', () => {
    const hit = h.search({ q: 'react site:notext.com' }).hits[0]!;
    expect(hit.has_text).toBe(false);
    expect(hit.snippet).toBe('https://notext.com/react?a=1&amp;b=%3Cb%3E');
  });

  it('survives hostile input', () => {
    for (const q of ['foo" OR bar*', 'NEAR(', '-', '"', '*', 'AND', 'a OR', '^title', 'title:react', '(((', "'; DROP TABLE pages; --", 'site:%', 'site:_']) {
      const r = h.search({ q });
      expect(r.total).toBeGreaterThanOrEqual(0);
    }
    expect(h.search({ q: 'site:%' }).total).toBe(0);
    expect(h.stats().pages).toBe(6);
  });

  it('returns parsed query and timing', () => {
    const r = h.search({ q: 'react site:github.com' });
    expect(r.parsed).toMatchObject({ text: 'react', site: ['github.com'] });
    expect(r.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('keyword hits: match=keyword, score = -bm25 (higher is better), sorted best-first', () => {
    const r = h.search({ q: 'reac' });
    expect(r.hits.every((x) => x.match === 'keyword')).toBe(true);
    const scores = r.hits.map((x) => x.score);
    expect(scores.every((x) => x > 0)).toBe(true);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(h.search({ q: 'site:github.com' }).hits.every((x) => x.score === 0 && x.match === 'keyword')).toBe(true);
  });
});

describe('deletes keep FTS consistent', () => {
  it('deletePage removes page, visits and FTS entries', () => {
    const { pageId } = visitWithText('https://a.com', 'Alpha', 'unique-word-zebra', 1)!;
    visitWithText('https://b.com', 'Beta', 'zebra too', 2);
    expect(ftsCount('zebra')).toBe(2);
    h.deletePage({ id: pageId });
    expect(ftsCount('zebra')).toBe(1);
    expect(h.search({ q: 'zebra' }).total).toBe(1);
    expect(h.getPage({ id: pageId })).toBeNull();
    expect(raw.selectValue('SELECT count(*) FROM visits WHERE page_id = ?', [pageId])).toBe(0);
    raw.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)");
  });

  it('text updates replace old FTS terms', () => {
    visitWithText('https://a.com', 'T', 'oldterm', 1);
    h.upsertText({ url: 'https://a.com', title: 'T', text: 'newterm', ts: 2 });
    expect(ftsCount('oldterm')).toBe(0);
    expect(ftsCount('newterm')).toBe(1);
    raw.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)");
  });

  it('deleteDomain removes domain + subdomains only', () => {
    visitWithText('https://github.com/a', 'A', 'zebra', 1);
    visitWithText('https://gist.github.com/b', 'B', 'zebra', 2);
    visitWithText('https://notgithub.com/c', 'C', 'zebra', 3);
    expect(h.deleteDomain({ domain: 'www.GitHub.com' })).toEqual({ deleted: 2 });
    expect(ftsCount('zebra')).toBe(1);
    expect(h.stats()).toMatchObject({ pages: 1, visits: 1 });
    raw.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)");
  });

  it('leaves no trace of a forgotten site in the database file (which backups copy)', () => {
    const fileHas = (s: string) => new TextDecoder('latin1').decode(sqlite3.capi.sqlite3_js_db_export(raw)).includes(s);
    const forget = () => {
      visitWithText('https://keep.com/', 'Keep', 'ordinary page about gardens', 1);
      visitWithText('https://private-clinic.com/r', 'Results', 'quokkadiagnosis '.repeat(400), 2);
      expect(fileHas('quokkadiagnosis')).toBe(true);
      h.deleteDomain({ domain: 'private-clinic.com' });
    };
    forget();
    expect(fileHas('quokkadiagnosis')).toBe(false);
    expect(fileHas('private-clinic.com')).toBe(false);
    expect(fileHas('gardens')).toBe(true);

    // Control: without secure delete the bytes would still be there.
    raw = new sqlite3.oo1.DB(':memory:');
    h = new HistoryDb(raw, () => sqlite3.capi.sqlite3_js_db_export(raw));
    raw.exec("PRAGMA secure_delete = OFF; INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 0);");
    forget();
    expect(fileHas('quokkadiagnosis')).toBe(true);
  });
});

describe('timeline', () => {
  it('groups by local day, splits sessions on >30 min gaps, newest first', () => {
    h.recordVisit({ url: 'https://a.com/1', ts: T(2025, 10, 1, 9, 0) });
    h.recordVisit({ url: 'https://a.com/2', ts: T(2025, 10, 1, 9, 20) });
    h.recordVisit({ url: 'https://a.com/3', ts: T(2025, 10, 1, 9, 50) }); // 30 min gap: same session
    h.recordVisit({ url: 'https://a.com/4', ts: T(2025, 10, 1, 10, 21) }); // 31 min: new session
    h.recordVisit({ url: 'https://a.com/5', ts: T(2025, 10, 2, 8, 0) });
    h.recordVisit({ url: 'https://a.com/old', ts: T(2025, 9, 1) }); // outside window
    h.recordVisit({ url: 'https://a.com/future', ts: T(2025, 10, 3, 1) }); // after `before`

    const { days } = h.timeline({ before: T(2025, 10, 3, 0, 0), days: 7 });
    expect(days.map((d) => d.day)).toEqual(['2025-10-02', '2025-10-01']);
    const oct1 = days[1]!.sessions;
    expect(oct1).toHaveLength(2);
    expect(oct1[0]!.visits.map((v) => v.url)).toEqual(['https://a.com/4']);
    expect(oct1[1]!.visits.map((v) => v.url)).toEqual(['https://a.com/3', 'https://a.com/2', 'https://a.com/1']);
    expect(oct1[1]).toMatchObject({ start: T(2025, 10, 1, 9, 0), end: T(2025, 10, 1, 9, 50) });
    expect(oct1[1]!.visits[0]).toMatchObject({ domain: 'a.com', title: '', transition: null, dwell_ms: 0 });
  });
});

describe('stats / export / handle', () => {
  it('stats counts and top domains', () => {
    h.recordVisit({ url: 'https://a.com/1', ts: 10 });
    h.recordVisit({ url: 'https://a.com/2', ts: 20 });
    h.recordVisit({ url: 'https://b.com', ts: 5 });
    h.addDwell({ url: 'https://b.com', dwellMs: 700 });
    const s = h.stats();
    expect(s).toMatchObject({ pages: 3, visits: 3, pagesWithText: 0, oldestVisit: 5 });
    expect(s.dbBytes).toBeGreaterThan(0);
    expect(s.topDomains).toEqual([
      { domain: 'a.com', visits: 2, dwell_ms: 0 },
      { domain: 'b.com', visits: 1, dwell_ms: 700 },
    ]);
  });

  it('exportJson and exportDb', async () => {
    visitWithText('https://a.com', 'A', 'body', 1);
    const j = JSON.parse(h.exportJson().json);
    expect(j.pages).toHaveLength(1);
    expect(j.pages[0].text).toBe('body');
    expect(j.visits).toHaveLength(1);
    const bytes = Uint8Array.from(atob(h.exportDb().bytes), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe('SQLite format 3');
    // Round-trip: the exported file opens and is searchable.
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const db2 = new sqlite3.oo1.DB();
    const rc = sqlite3.capi.sqlite3_deserialize(db2.pointer!, 'main', p, bytes.length, bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    expect(rc).toBe(0);
    expect(db2.selectValue("SELECT count(*) FROM pages_fts WHERE pages_fts MATCH 'body'")).toBe(1);
    db2.close();
  });

  it('handle() never throws and reports errors', () => {
    expect(h.handle({ op: 'nope' as never, args: {} as never })).toMatchObject({ ok: false });
    expect(h.handle({ op: 'constructor' as never, args: {} as never })).toMatchObject({ ok: false });
    expect(h.handle({ op: 'getPage', args: { id: 999 } })).toEqual({ ok: true, result: null });
    raw.exec('DROP TABLE visits');
    const r = h.handle({ op: 'stats', args: {} });
    expect(r.ok).toBe(false);
  });
});
