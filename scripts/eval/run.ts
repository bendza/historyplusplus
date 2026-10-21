// Search quality evaluation against a read-only copy of the real history database.
// Runs the production HistoryDb (src/engine/db.ts) in Node over sqlite-wasm, embeds queries
// with the bundled multilingual-e5-small exactly like the extension does, and scores three
// retrieval views per labelled query: keyword (FTS only), meaning (the engine's own meaning
// candidates, after floors) and hybrid (the real default). Plus two label-free sanity suites.
//
//   npm run eval                 # auto-locates and copies Edge's OPFS database
//   npm run eval -- --db x.sqlite
//   npm run eval -- --now 2026-10-14T16:00 --set meaningZ=3.2 --set chunkPenalty=0.5
//   npm run eval -- --queries other.json
//
// --now pins "today" for date phrases ("yesterday"); default: the newest visit in the database,
// so labelled temporal queries keep meaning what they meant when the snapshot was taken.
// --set overrides one HistoryDb.tuning knob (see SearchTuning in db.ts) for this run.
//
// Never writes to the browser profile: the OPFS file is copied (minus the 4 KiB SAH-pool
// header) to a temp dir and deserialized into an in-memory database.
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryDb, type SearchTuning } from '../../src/engine/db';
import { parseQuery, parseSearch } from '../../src/engine/query';
import type { VectorIndex, VectorHit } from '../../src/engine/vectors';
import { EMBED_MODEL, type SearchHit } from '../../src/shared/protocol';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const LIMIT = 20;
const SAH_HEADER = 4096;
const SEED = 20261014;
// The model downloads on demand in the extension; for dev/eval it lives in models/ (or the
// older bundled location public/models/).
const MODEL_DIRS = [join(ROOT, 'models'), join(ROOT, 'public/models')];
const MODEL_DIR = MODEL_DIRS.find((d) => existsSync(join(d, EMBED_MODEL)));

function arg(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

// ---------------------------------------------------------------- database

/** Candidate OPFS files: Edge/Chrome profile "File System" dirs, SQLite magic right after the SAH header. */
function findOpfsDb(): string | null {
  const roots = [
    join(homedir(), 'Library/Application Support/Microsoft Edge/Default/File System'),
    join(homedir(), 'Library/Application Support/Google/Chrome/Default/File System'),
  ];
  const magic = Buffer.from('SQLite format 3\0');
  let best: { path: string; size: number } | null = null;
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else if (st.size > SAH_HEADER + 4096) {
        const fd = openSync(p, 'r');
        const buf = Buffer.alloc(16);
        readSync(fd, buf, 0, 16, SAH_HEADER);
        closeSync(fd);
        if (buf.equals(magic) && (!best || st.size > best.size)) best = { path: p, size: st.size };
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return best ? (best as { path: string }).path : null;
}

function loadDbBytes(): { bytes: Uint8Array; source: string } {
  const i = process.argv.indexOf('--db');
  if (i > 0 && process.argv[i + 1]) {
    const p = resolve(process.argv[i + 1]!);
    return { bytes: new Uint8Array(readFileSync(p)), source: p };
  }
  const src = findOpfsDb();
  if (!src) throw new Error('No history++ OPFS database found; pass --db <plain sqlite file>');
  // Copy first so the live file is only ever read once, then strip the SAH header.
  const dir = join(tmpdir(), 'history-pp-eval');
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, 'opfs-copy.bin');
  copyFileSync(src, copy);
  const raw = readFileSync(copy);
  const plain = raw.subarray(SAH_HEADER);
  writeFileSync(join(dir, 'history.sqlite'), plain);
  return { bytes: new Uint8Array(plain), source: src };
}

async function openDb(): Promise<{ raw: Database; h: HistoryDb; source: string; now: number }> {
  const { bytes, source } = loadDbBytes();
  if (new TextDecoder().decode(bytes.subarray(0, 15)) !== 'SQLite format 3') throw new Error(`${source}: not a SQLite file`);
  // In-memory deserialize can't open WAL-mode headers; force rollback-journal mode bytes.
  bytes[18] = 1;
  bytes[19] = 1;
  const sqlite3 = await sqlite3InitModule();
  const raw = new sqlite3.oo1.DB(':memory:');
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const { capi } = sqlite3;
  const rc = capi.sqlite3_deserialize(
    raw.pointer!,
    'main',
    p,
    bytes.byteLength,
    bytes.byteLength,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  raw.checkRc(rc);
  const nowArg = arg('--now')[0];
  const now = nowArg ? new Date(nowArg).getTime() : Number(raw.selectValue('SELECT max(ts) FROM visits') ?? Date.now());
  if (!Number.isFinite(now)) throw new Error(`--now ${nowArg}: not a date`);
  const h = new HistoryDb(raw, undefined, { sqlite3, now: () => now });
  for (const kv of arg('--set')) {
    const [k, v] = kv.split('=') as [keyof SearchTuning, string];
    if (!(k in h.tuning) || !Number.isFinite(+v)) throw new Error(`--set ${kv}: unknown knob or bad number`);
    h.tuning[k] = +v;
  }
  return { raw, h, source, now };
}

// ---------------------------------------------------------------- embedding (mirrors embed.worker.ts + indexer.ts)

async function makeEmbedder(now: number): Promise<(q: string) => Promise<Float32Array | undefined>> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODEL_DIR + '/';
  env.useBrowserCache = false;
  env.useFSCache = false;
  const p = (await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' })) as FeatureExtractionPipeline;
  return async (q: string) => {
    // Same text the extension embeds: operators and date phrases stripped, whitespace
    // collapsed, 'query: ' prefix.
    const text = parseQuery(q, now).text.trim().replace(/\s+/g, ' ');
    if (!text) return undefined;
    const t = await p([`query: ${text}`], { pooling: 'mean', normalize: true });
    const v = (t.data as Float32Array).slice(0, t.dims.at(-1)!);
    t.dispose();
    return v;
  };
}

// ---------------------------------------------------------------- labelled queries

interface LabeledQuery {
  id: string;
  kind: string;
  query: string;
  expect: string[]; // case-insensitive substrings of url or title, any-of
  visitedBetween?: [string, string]; // local dates, [from, to): page must have a visit in range
}

interface Page {
  id: number;
  url: string;
  title: string;
}

const dayMs = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, dd).getTime();
};

function relevance(raw: Database, q: LabeledQuery): (p: Page) => boolean {
  const subs = q.expect.map((s) => s.toLowerCase());
  const cache = new Map<number, boolean>();
  return (p) => {
    let r = cache.get(p.id);
    if (r !== undefined) return r;
    const u = p.url.toLowerCase(),
      t = p.title.toLowerCase();
    r = subs.some((s) => u.includes(s) || t.includes(s));
    if (r && q.visitedBetween) {
      const [a, b] = q.visitedBetween.map(dayMs) as [number, number];
      r = !!raw.selectValue('SELECT 1 FROM visits WHERE page_id = ? AND ts >= ? AND ts < ? LIMIT 1', [p.id, a, b]);
    }
    cache.set(p.id, r);
    return r;
  };
}

/** 1-based rank of the first relevant item, or null. */
const firstRank = <T>(xs: T[], ok: (x: T) => boolean): number | null => {
  const i = xs.findIndex(ok);
  return i < 0 ? null : i + 1;
};

// Private engine internals, reached on purpose so the eval runs the production code paths.
interface EngineInternals {
  vectorIndex(): VectorIndex;
  meaningCandidates(qv: ArrayLike<number>, parsed: ReturnType<typeof parseQuery>): VectorHit[];
}

interface Row {
  q: LabeledQuery;
  kw: number | null;
  meaning: number | null; // rank in the engine's meaning candidates (after floors, <= MEANING_POOL)
  vector: number | null; // rank among ALL pages by best-chunk similarity (no floors)
  hybrid: number | null;
  browser: number | null; // browser-style: every word in title/URL, newest first, all time
  browser90: number | null; // same, but only what a browser still keeps (visits in the last 90 days)
  kwTotal: number;
  meaningTotal: number;
  top: SearchHit[]; // hybrid top 3
  vecTopTitle: string;
  dateLabel: string | null;
  bestZ: number | null; // best page's similarity in sd above this query's mean (centered index)
}

// ---------------------------------------------------------------- metrics

interface Metrics {
  n: number;
  h1: number;
  h5: number;
  h10: number;
  mrr: number;
}
function metrics(ranks: (number | null)[], cutoff = LIMIT): Metrics {
  const n = ranks.length;
  const c = (k: number) => ranks.filter((r) => r !== null && r <= k).length / (n || 1);
  const mrr = ranks.reduce<number>((a, r) => a + (r !== null && r <= cutoff ? 1 / r : 0), 0) / (n || 1);
  return { n, h1: c(1), h5: c(5), h10: c(10), mrr };
}
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
const fmtM = (m: Metrics) => `${pct(m.h1)} ${pct(m.h5)} ${pct(m.h10)}  ${m.mrr.toFixed(2)}`;
const fmtR = (r: number | null) => (r === null ? '-' : String(r));
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

// ---------------------------------------------------------------- sanity suites

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample<T>(xs: T[], n: number, rand: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const STOP = new Set(
  (
    'a an the and or of to in on for with at by from is are was be it this that as your you our my we ' +
    'how what why who new vs not no all can get com www http https html ' +
    'i u na za od do se je da sa po iz su ili ' +
    'google search pretraži linkedin youtube jobless reddit dashboard home page'
  ).split(' '),
);

async function sanity(h: HistoryDb, raw: Database, embed: (q: string) => Promise<Float32Array | undefined>, now: number) {
  const rand = rng(SEED);
  // (a) distinctive phrase from the middle of captured text -> keyword search, expect #1.
  const textPages = raw
    .selectObjects("SELECT id, url, title, text FROM pages WHERE text IS NOT NULL AND length(text) > 400")
    .map((r) => ({ id: Number(r.id), text: String(r.text) }));
  const normTexts = new Map(textPages.map((p) => [p.id, ' ' + norm(p.text) + ' ']));
  const phraseRanks: { kw: number | null; hy: number | null }[] = [];
  for (const p of sample(textPages, 30, rand)) {
    const words = p.text
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter(Boolean); // keep digits: dropping "13" from "Oct 13 2026" would break the phrase
    if (words.length < 30) continue;
    const len = 6 + Math.floor(rand() * 5);
    const start = Math.floor(words.length * (0.3 + rand() * 0.4));
    const phrase = words.slice(start, start + len).join(' ');
    const np = ' ' + norm(phrase) + ' ';
    const ok = (hit: { id: number }) => normTexts.get(hit.id)?.includes(np) ?? false;
    const kw = h.search({ q: phrase, limit: LIMIT, mode: 'keyword' }).hits;
    const hy = h.search({ q: phrase, limit: LIMIT, queryVector: await embed(phrase) }).hits;
    phraseRanks.push({ kw: firstRank(kw, ok), hy: firstRank(hy, ok) });
  }
  // (b) 3-5 shuffled content words from a title -> where does the page land?
  const titled = raw
    .selectObjects("SELECT id, title FROM pages WHERE title <> ''")
    .map((r) => ({ id: Number(r.id), title: String(r.title) }))
    .map((p) => ({ ...p, words: [...new Set(norm(p.title).split(' '))].filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) }))
    .filter((p) => p.words.length >= 3);
  const seenTitles = new Set<string>();
  const uniq = sample(titled, titled.length, rand).filter((p) => !seenTitles.has(p.title) && seenTitles.add(p.title));
  const titleRanks: { kw: number | null; hy: number | null; meaning: number | null }[] = [];
  for (const p of uniq.slice(0, 50)) {
    const k = Math.min(p.words.length, 3 + Math.floor(rand() * 3));
    const q = sample(p.words, k, rand).join(' ');
    const ok = (hit: { title: string }) => hit.title === p.title;
    const qv = await embed(q);
    const kw = h.search({ q, limit: LIMIT, mode: 'keyword' }).hits;
    const hy = h.search({ q, limit: LIMIT, queryVector: qv }).hits;
    const internals = h as unknown as EngineInternals;
    const titleOf = new Map<number, string>();
    const mc = internals.meaningCandidates(qv!, parseQuery(q, now));
    if (mc.length)
      for (const r of raw.selectArrays(`SELECT id, title FROM pages WHERE id IN (${mc.map(() => '?').join(',')})`, mc.map((m) => m.pageId)))
        titleOf.set(Number(r[0]), String(r[1] ?? ''));
    titleRanks.push({
      kw: firstRank(kw, ok),
      hy: firstRank(hy, ok),
      meaning: firstRank(mc, (m) => titleOf.get(m.pageId) === p.title),
    });
  }
  return { phraseRanks, titleRanks };
}

// ---------------------------------------------------------------- browser-style baseline

const DAY = 86_400_000;

/**
 * How browsers' own history search behaves: every typed word must appear in the title or URL,
 * results newest first, no page text, no meaning, no date phrases. Slightly kinder than Chrome
 * (any substring counts, not just word prefixes). `windowDays` limits it to recent visits, the
 * way Chrome/Edge drop history after 90 days.
 */
function browserSearch(raw: Database, q: string, now: number, windowDays?: number): Page[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const where = words.map(() => "instr(lower(p.title || ' ' || p.url), ?) > 0").join(' AND ');
  const since = windowDays ? now - windowDays * DAY : -Infinity;
  return raw
    .selectObjects(
      `SELECT p.id, p.url, p.title, max(v.ts) AS last FROM pages p JOIN visits v ON v.page_id = p.id
       WHERE v.ts >= ? AND v.ts <= ? AND ${where} GROUP BY p.id ORDER BY last DESC LIMIT ${LIMIT}`,
      [since, now, ...words],
    )
    .map((r) => ({ id: Number(r.id), url: String(r.url), title: String(r.title ?? '') }));
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = performance.now();
  const { raw, h, source, now } = await openDb();
  const stats = {
    pages: Number(raw.selectValue('SELECT count(*) FROM pages')),
    withText: Number(raw.selectValue("SELECT count(*) FROM pages WHERE text IS NOT NULL AND text <> ''")),
    chunks: Number(raw.selectValue('SELECT count(*) FROM chunks')),
    embedded: Number(raw.selectValue('SELECT count(*) FROM chunks WHERE embedding IS NOT NULL')),
  };
  console.log(`db: ${source}\n    ${stats.pages} pages, ${stats.withText} with text, ${stats.embedded}/${stats.chunks} chunks embedded`);
  console.log(`    now ${new Date(now).toString().slice(0, 21)}; tuning ${JSON.stringify(h.tuning)}`);
  const embed = await makeEmbedder(now);
  const internals = h as unknown as EngineInternals;

  const queries = JSON.parse(readFileSync(arg('--queries')[0] ?? join(HERE, 'queries.json'), 'utf8')) as LabeledQuery[];
  const rows: Row[] = [];
  for (const q of queries) {
    const ok = relevance(raw, q);
    const qv = await embed(q.query);
    const kwRes = h.search({ q: q.query, limit: LIMIT, mode: 'keyword' });
    const hyRes = h.search({ q: q.query, limit: LIMIT, queryVector: qv });
    const { parsed, dateLabel } = parseSearch(q.query, now);
    const mc = qv ? internals.meaningCandidates(qv, parsed) : [];
    const all = qv ? internals.vectorIndex().search(qv, -Infinity) : [];
    const st = internals.vectorIndex().lastStats;
    const bestZ = all[0] && st.sd ? (all[0].sim - st.mean) / st.sd : null;
    const pageOf = (id: number): Page => {
      const r = raw.selectObject('SELECT id, url, title FROM pages WHERE id = ?', [id])!;
      return { id, url: String(r.url), title: String(r.title ?? '') };
    };
    // Full vector ranking: only resolve page rows until the first relevant one.
    let vector: number | null = null;
    if (q.expect.length)
      for (let i = 0; i < all.length; i++)
        if (ok(pageOf(all[i]!.pageId))) {
          vector = i + 1;
          break;
        }
    rows.push({
      q,
      kw: q.expect.length ? firstRank(kwRes.hits, ok) : null,
      meaning: q.expect.length ? firstRank(mc, (m) => ok(pageOf(m.pageId))) : null,
      vector,
      hybrid: q.expect.length ? firstRank(hyRes.hits, ok) : null,
      browser: q.expect.length ? firstRank(browserSearch(raw, q.query, now), ok) : null,
      browser90: q.expect.length ? firstRank(browserSearch(raw, q.query, now, 90), ok) : null,
      kwTotal: kwRes.total,
      meaningTotal: mc.length,
      top: hyRes.hits.slice(0, 3),
      vecTopTitle: all[0] ? pageOf(all[0].pageId).title : '',
      dateLabel,
      bestZ,
    });
  }

  const labelled = rows.filter((r) => r.q.expect.length);
  const negatives = rows.filter((r) => !r.q.expect.length);
  const kinds = [...new Set(labelled.map((r) => r.q.kind))];

  const out: string[] = [];
  const log = (s = '') => {
    console.log(s);
    out.push(s);
  };
  const md: string[] = [];

  log(`\nLABELLED QUERIES (${labelled.length}, limit ${LIMIT})    hit@1 hit@5 hit@10 MRR`);
  const modes: [string, (r: Row) => number | null][] = [
    ['browser', (r) => r.browser],
    ['brows90', (r) => r.browser90],
    ['keyword', (r) => r.kw],
    ['meaning', (r) => r.meaning],
    ['vector*', (r) => r.vector],
    ['hybrid', (r) => r.hybrid],
  ];
  for (const [name, f] of modes) log(`  ${name.padEnd(8)} all            ${fmtM(metrics(labelled.map(f)))}`);
  log('  (* vector = rank over ALL pages by raw best-chunk similarity, no floors/pool cap)');
  log('  (browser = every word in title/URL, newest first, like Chrome/Edge history; brows90 = only the last 90 days, what they still keep)');
  log('\nHYBRID / KEYWORD / MEANING / BROWSER by kind hybrid               keyword              meaning              browser');
  for (const k of kinds) {
    const rs = labelled.filter((r) => r.q.kind === k);
    log(
      `  ${(k + ` (${rs.length})`).padEnd(24)} ${fmtM(metrics(rs.map((r) => r.hybrid)))}   ${fmtM(metrics(rs.map((r) => r.kw)))}   ${fmtM(metrics(rs.map((r) => r.meaning)))}   ${fmtM(metrics(rs.map((r) => r.browser)))}`,
    );
  }

  log('\nPER QUERY (rank of first expected page; - = not in list)');
  const fz = (z: number | null) => (z === null ? '  -' : z.toFixed(1)).padStart(4);
  log(`  ${'id'.padEnd(24)} ${'kw'.padStart(3)} ${'mean'.padStart(4)} ${'vec'.padStart(5)} ${'hyb'.padStart(3)}  kwN mN  bestZ  hybrid #1 when it missed`);
  for (const r of labelled) {
    const miss = r.hybrid === 1 ? '' : r.top[0] ? `${r.top[0].match}: ${clip(r.top[0].title || r.top[0].url, 48)}` : '(no results)';
    log(
      `  ${r.q.id.padEnd(24)} ${fmtR(r.kw).padStart(3)} ${fmtR(r.meaning).padStart(4)} ${fmtR(r.vector).padStart(5)} ${fmtR(r.hybrid).padStart(3)}  ${String(r.kwTotal).padStart(3)} ${String(r.meaningTotal).padStart(2)}  ${fz(r.bestZ)}   ${miss}`,
    );
  }

  const dated = rows.filter((r) => r.dateLabel);
  if (dated.length) {
    log('\nDATE PHRASES UNDERSTOOD');
    for (const r of dated) log(`  ${r.q.id.padEnd(24)} ${r.dateLabel}`);
  }

  log('\nNEGATIVE (topic absent; pass = no meaning-retrieved hit in hybrid top 3)');
  let negPass = 0;
  for (const r of negatives) {
    const bad = r.top.filter((x) => x.match !== 'keyword');
    if (!bad.length) negPass++;
    log(`  ${r.q.id.padEnd(24)} ${bad.length ? 'FAIL' : 'pass'}  kwN ${r.kwTotal}, meaningN ${r.meaningTotal}, bestZ ${fz(r.bestZ).trim()}${r.top[0] ? `, #1 ${r.top[0].match}: ${clip(r.top[0].title || r.top[0].url, 48)}` : ''}`);
  }
  log(`  ${negPass}/${negatives.length} pass`);

  const { phraseRanks, titleRanks } = await sanity(h, raw, embed, now);
  const pm = (rs: (number | null)[]) => {
    const m = metrics(rs);
    return `hit@1 ${pct(m.h1)}  hit@5 ${pct(m.h5)}`;
  };
  log('\nSANITY (unlabelled)');
  log(`  (a) text phrase, ${phraseRanks.length} pages     keyword ${pm(phraseRanks.map((r) => r.kw))}   hybrid ${pm(phraseRanks.map((r) => r.hy))}`);
  log(`  (b) shuffled title words, ${titleRanks.length} pages  keyword ${pm(titleRanks.map((r) => r.kw))}   hybrid ${pm(titleRanks.map((r) => r.hy))}   meaning ${pm(titleRanks.map((r) => r.meaning))}`);
  log(`\n${((performance.now() - t0) / 1000).toFixed(1)} s`);

  // Markdown report: same numbers plus the hybrid top 3 per query (local only, gitignored).
  md.push('# history++ search eval', '', `Generated ${new Date().toISOString()} from \`${source}\`.`, '');
  md.push(`${stats.pages} pages, ${stats.withText} with captured text, ${stats.embedded}/${stats.chunks} chunks embedded.`, '');
  md.push('```', ...out, '```', '', '## Hybrid top 3 per query', '');
  md.push('| id | query | kw | meaning | vector | hybrid | hybrid top 3 |', '|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const top = r.top.map((x, i) => `${i + 1}. [${x.match}] ${clip(x.title || x.url, 60)}`.replace(/\|/g, '\\|')).join('<br>');
    md.push(`| ${r.q.id} | ${r.q.query} | ${fmtR(r.kw)} | ${fmtR(r.meaning)} | ${fmtR(r.vector)} | ${fmtR(r.hybrid)} | ${top || '(none)'} |`);
  }
  writeFileSync(join(HERE, 'report.md'), md.join('\n') + '\n');
  console.log(`\nwrote ${join(HERE, 'report.md')}`);
  raw.close();
}

if (!MODEL_DIR) {
  console.error(`model ${EMBED_MODEL} missing under models/ or public/models/; run npm run fetch-model`);
  process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
