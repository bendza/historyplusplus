// Dev-only fake engine + fake chrome.storage for previewing the UI with `?mock=1`
// (no extension backend needed). Extra URL flags pick a state to look at:
//   fresh=1                         no history yet, onboarding not done
//   model=none|downloading|error    semantic model state (default ready)
//   backfill=running                this browser's import still running
//   backup=none|running|error       daily backup state (default: a backup this morning)
//   indexed=1                       search by meaning already finished (for screenshots)
import { BACKUP_DIR, DEFAULT_SETTINGS, EMBED_MODEL, type DaySessions, type EngineOp, type EngineOps, type IndexStatus, type ModelState, type PageRow, type ParsedQuery, type SearchHit, type VisitRow } from '../shared/protocol';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const FRESH = params.get('fresh') === '1';

const SITES: { domain: string; weight: number; titles: string[] }[] = [
  { domain: 'github.com', weight: 9, titles: ['wxt-dev/wxt: Next-gen Web Extension Framework', 'sqlite/sqlite-wasm releases', 'preactjs/preact: Fast 3kB React alternative', 'Pull request #128 · history-plus-plus', 'Issues · huggingface/transformers.js'] },
  { domain: 'developer.chrome.com', weight: 6, titles: ['chrome.offscreen API reference', 'Manifest V3 migration guide', 'chrome.history API', 'Origin Private File System'] },
  { domain: 'sqlite.org', weight: 4, titles: ['FTS5 full-text search extension', 'SQLite WASM and JavaScript', 'The SQLite query planner'] },
  { domain: 'news.ycombinator.com', weight: 7, titles: ['Show HN: I kept my browser history forever', 'Ask HN: How do you organise what you read?', 'Local-first software (2019)'] },
  { domain: 'en.wikipedia.org', weight: 4, titles: ['Okapi BM25 - Wikipedia', 'Memex - Wikipedia', 'Vannevar Bush - Wikipedia', 'As We May Think - Wikipedia'] },
  { domain: 'youtube.com', weight: 5, titles: ['How SQLite works internally - YouTube', 'Building browser extensions in 2026 - YouTube', 'Sourdough starter from scratch - YouTube'] },
  { domain: 'notion.so', weight: 8, titles: ['Launch checklist – Notion', 'Reading list – Notion'] },
  { domain: 'docs.python.org', weight: 2, titles: ['sqlite3 — DB-API 2.0 interface for SQLite databases'] },
  { domain: 'gist.github.com', weight: 1, titles: ['FTS5 snippet helper.js'] },
  { domain: 'stackoverflow.com', weight: 4, titles: ['How to use OPFS from a dedicated worker?', 'MV3 service worker keeps dying'] },
  { domain: 'theguardian.com', weight: 3, titles: ['The quiet comeback of the paper notebook', 'Why we forget most of what we read'] },
  { domain: 'kingarthurbaking.com', weight: 1, titles: ['Sourdough baking guide', 'Rye bread with caraway'] },
  { domain: 'booking.com', weight: 2, titles: ['Hotels in Lisbon · Booking.com', 'Your trip to Porto'] },
  { domain: 'figma.com', weight: 3, titles: ['history++ popup v3 – Figma', 'Settings layout – Figma'] },
];

// Sites that went quiet for a month or more and came back (for Insights "rediscovered").
const REDISCOVERED = ['kingarthurbaking.com', 'booking.com', 'en.wikipedia.org'];

const LOREM =
  'Full-text search lets you find any page you have read by the words on it. The engine tokenises text, builds an inverted index and ranks matches with BM25. ' +
  'Offscreen documents give Manifest V3 extensions a DOM and a place to run long-lived workers. SQLite compiled to WebAssembly can persist to the Origin Private File System. ';

const DAY = 86_400_000;

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

interface MockPage extends PageRow {
  text: string | null;
}

let pages: MockPage[] = [];
let visits: VisitRow[] = [];
let built = false;

/** A plausible local time of day: mornings and afternoons on weekdays, later on weekends. */
function timeOfDay(rand: () => number, weekend: boolean): number {
  const r = rand();
  const hour = weekend ? 10 + Math.floor(r * 13) : r < 0.08 ? 7 + Math.floor(rand() * 2) : r < 0.75 ? 9 + Math.floor(rand() * 9) : 19 + Math.floor(rand() * 5);
  return hour * 3_600_000 + Math.floor(rand() * 3_600_000);
}

function build() {
  built = true;
  if (FRESH) return;
  const rand = rng(42);
  const now = Date.now();
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  let pid = 0;
  let vid = 0;
  const byDomain = new Map<string, MockPage[]>();
  for (const site of SITES) {
    for (const title of site.titles) {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const page: MockPage = { id: ++pid, url: `https://${site.domain}/${slug}`, domain: site.domain, title, lang: 'en', first_seen: 0, last_seen: 0, visit_count: 0, total_dwell_ms: 0, has_text: rand() > 0.2, text: null };
      page.text = page.has_text ? `${title}\n\n${LOREM.repeat(3 + Math.floor(rand() * 5))}` : null;
      pages.push(page);
      byDomain.set(site.domain, [...(byDomain.get(site.domain) ?? []), page]);
    }
  }
  const weighted = SITES.flatMap((s) => Array.from({ length: s.weight }, () => s.domain));
  const push = (page: MockPage, ts: number) => {
    if (ts > now) return;
    const dwell = Math.round(rand() * rand() * 900_000);
    visits.push({ id: ++vid, page_id: page.id, ts, transition: rand() > 0.7 ? 'typed' : 'link', dwell_ms: dwell, url: page.url, domain: page.domain, title: page.title });
  };
  // 75 days of browsing; this week is a bit busier than last week.
  for (let d = 0; d < 75; d++) {
    const dayStart = midnight - d * DAY;
    const weekend = [0, 6].includes(new Date(dayStart).getDay());
    const n = Math.round((weekend ? 9 : 22) * (d < 7 ? 1.25 : 1) * (0.6 + rand() * 0.8));
    for (let i = 0; i < n; i++) {
      let domain = weighted[Math.floor(rand() * weighted.length)]!;
      // Rediscovered sites: visited 44-75 days ago and again in the last 9 days, never in between.
      if (REDISCOVERED.includes(domain) && d >= 9 && d < 44) domain = 'github.com';
      const list = byDomain.get(domain)!;
      push(list[Math.floor(rand() * list.length)]!, dayStart + timeOfDay(rand, weekend));
    }
  }
  // A few visits a year or more back for "On this day".
  for (let i = 0; i < 40; i++) {
    const back = (1 + Math.floor(rand() * 3)) * 365 * DAY + (rand() - 0.5) * 3 * DAY;
    push(pages[Math.floor(rand() * pages.length)]!, Math.round(now - back));
  }
  visits.sort((a, b) => b.ts - a.ts);
  recompute();
}

function recompute() {
  for (const p of pages) {
    const vs = visits.filter((v) => v.page_id === p.id);
    p.visit_count = vs.length;
    p.total_dwell_ms = vs.reduce((s, v) => s + v.dwell_ms, 0);
    p.last_seen = vs.length ? Math.max(...vs.map((v) => v.ts)) : 0;
    p.first_seen = vs.length ? Math.min(...vs.map((v) => v.ts)) : 0;
  }
  pages = pages.filter((p) => p.visit_count > 0);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (t: number) => `${MONTHS[new Date(t).getMonth()]} ${new Date(t).getDate()}`;
function rangeLabel(from: number, to: number): string {
  const a = new Date(from);
  const b = new Date(to - 1);
  return a.getMonth() === b.getMonth() ? `${md(from)}–${b.getDate()}` : `${md(from)}–${md(to - 1)}`;
}

/** The engine understands a few date phrases in plain words; mimic the common ones. */
function naturalDate(text: string, now = Date.now()): { text: string; after: number; before: number; label: string } | null {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const monday = midnight - ((d.getDay() + 6) % 7) * DAY;
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const phrases: [RegExp, () => { after: number; before: number; label: string }][] = [
    [/\byesterday\b/i, () => ({ after: midnight - DAY, before: midnight, label: `Yesterday · ${md(midnight - DAY)}` })],
    [/\btoday\b/i, () => ({ after: midnight, before: midnight + DAY, label: `Today · ${md(midnight)}` })],
    [/\blast week\b/i, () => ({ after: monday - 7 * DAY, before: monday, label: `Last week · ${rangeLabel(monday - 7 * DAY, monday)}` })],
    [/\bthis week\b/i, () => ({ after: monday, before: midnight + DAY, label: `This week · ${rangeLabel(monday, midnight + DAY)}` })],
    [/\blast month\b/i, () => {
      const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
      return { after: prev, before: month, label: `Last month · ${MONTHS[new Date(prev).getMonth()]}` };
    }],
  ];
  for (const [re, f] of phrases) {
    if (re.test(text)) return { text: text.replace(re, ' ').replace(/\s+/g, ' ').trim(), ...f() };
  }
  return null;
}

function parse(q: string): { parsed: ParsedQuery; dateLabel: string | null } {
  const parsed: ParsedQuery = { text: '', site: [], before: null, after: null };
  const rest = q.replace(/\b(site|before|after):(\S+)/g, (_m, k: string, v: string) => {
    if (k === 'site') parsed.site.push(v.toLowerCase());
    else {
      const t = new Date(`${v}T00:00:00`).getTime();
      if (!Number.isNaN(t)) parsed[k as 'before' | 'after'] = t;
    }
    return ' ';
  });
  parsed.text = rest.replace(/\s+/g, ' ').trim();
  let dateLabel: string | null = null;
  if (parsed.after == null && parsed.before == null) {
    const nat = naturalDate(parsed.text);
    if (nat) {
      parsed.text = nat.text;
      parsed.after = nat.after;
      parsed.before = nat.before;
      dateLabel = nat.label;
    }
  }
  return { parsed, dateLabel };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Words that "mean" something close to a page without appearing on it, for fake meaning hits.
const RELATED: Record<string, string[]> = {
  database: ['sqlite', 'fts5'],
  db: ['sqlite'],
  ranking: ['bm25', 'fts5'],
  memory: ['memex', 'as we may think', 'kept my browser history', 'forget'],
  notes: ['organise what you read', 'memex', 'notebook'],
  plugin: ['extension', 'wxt', 'manifest v3'],
  addon: ['extension', 'wxt'],
  storage: ['origin private file system', 'opfs', 'sqlite'],
  video: ['youtube'],
  email: ['gmail'],
  bread: ['sourdough', 'rye', 'baking'],
  travel: ['lisbon', 'porto', 'trip'],
};

function toHit(p: MockPage, terms: string[], match: SearchHit['match'], score: number): SearchHit {
  const { text, ...row } = p;
  const src = text ?? p.title;
  const first = terms.length ? src.toLowerCase().indexOf(terms[0]!) : 0;
  const start = Math.max(0, first - 60);
  let snippet = esc(src.slice(start, start + 180).replace(/\s+/g, ' '));
  for (const t of terms) snippet = snippet.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  return { ...row, score, match, snippet: (start > 0 ? '… ' : '') + snippet + ' …' };
}

function search(args: EngineOps['search']['args']): EngineOps['search']['result'] {
  const t0 = performance.now();
  const { parsed, dateLabel } = parse(args.q);
  const terms = parsed.text.replace(/"/g, '').toLowerCase().split(/\s+/).filter(Boolean);
  const inRange = (p: MockPage) => visits.some((v) => v.page_id === p.id && (parsed.after == null || v.ts >= parsed.after) && (parsed.before == null || v.ts < parsed.before));
  const hybrid = (args.mode ?? 'hybrid') === 'hybrid' && terms.length > 0 && modelState.status === 'ready';
  const related = terms.flatMap((t) => Object.entries(RELATED).filter(([k]) => k.startsWith(t) || t.startsWith(k)).flatMap(([, v]) => v));
  const byWords = (p: MockPage) => terms.every((t) => `${p.title} ${p.url} ${p.text ?? ''}`.toLowerCase().includes(t));
  const byMeaning = (p: MockPage) => hybrid && related.some((r) => p.title.toLowerCase().includes(r));
  let hits: SearchHit[] = pages
    .filter((p) => !parsed.site.length || parsed.site.some((s) => p.domain === s || p.domain.endsWith(`.${s}`)))
    .filter((p) => (parsed.after == null && parsed.before == null) || inRange(p))
    .filter((p) => byWords(p) || byMeaning(p))
    .map((p) => {
      const words = byWords(p);
      // Title hits count as found by both retrievers; body-only hits as keyword only.
      const match: SearchHit['match'] = !words ? 'meaning' : hybrid && terms.some((t) => p.title.toLowerCase().includes(t)) ? 'both' : 'keyword';
      return toHit(p, terms, match, (match === 'both' ? 3 : match === 'keyword' ? 2 : 1) + p.visit_count / 1e3 + p.last_seen / 1e14);
    });
  hits.sort((a, b) => (terms.length && args.sort !== 'recent' ? b.score - a.score : b.last_seen - a.last_seen));
  const total = hits.length;
  hits = hits.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 20));
  return { hits, total, parsed, tookMs: Math.max(1, Math.round(performance.now() - t0)), dateLabel };
}

function related(args: EngineOps['related']['args']): EngineOps['related']['result'] {
  const me = pages.find((p) => p.id === args.pageId);
  if (!me || indexStatus().pagesEmbedded === 0) return { hits: [] };
  const words = new Set(me.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const scored = pages
    .filter((p) => p.id !== me.id)
    .map((p) => {
      const overlap = p.title.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
      const sameSite = p.domain === me.domain ? 0.6 : 0;
      const topical = /sqlite|fts5|bm25|search/i.test(me.title) && /sqlite|fts5|bm25|search/i.test(p.title) ? 1 : 0;
      return { p, s: overlap + sameSite + topical };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, args.limit ?? 8);
  return { hits: scored.map(({ p, s }) => toHit(p, [], 'meaning', s)) };
}

function dayKeyOf(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeline(args: EngineOps['timeline']['args']): EngineOps['timeline']['result'] {
  const before = args.before ?? Date.now();
  const days = args.days ?? 7;
  const end = new Date(before);
  const from = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days + (args.before ? 0 : 1)).getTime();
  const window = visits.filter((v) => v.ts < before && v.ts >= from);
  const byDay = new Map<string, VisitRow[]>();
  for (const v of window) {
    const k = dayKeyOf(v.ts);
    byDay.set(k, [...(byDay.get(k) ?? []), v]);
  }
  const out: DaySessions[] = [];
  for (const [day, vs] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const asc = [...vs].sort((a, b) => a.ts - b.ts);
    const sessions: DaySessions['sessions'] = [];
    for (const v of asc) {
      const cur = sessions[sessions.length - 1];
      if (cur && v.ts - cur.end < 30 * 60_000) {
        cur.visits.push(v);
        cur.end = Math.max(cur.end, v.ts + v.dwell_ms);
      } else sessions.push({ start: v.ts, end: v.ts + v.dwell_ms, visits: [v] });
    }
    for (const s of sessions) s.visits.reverse();
    out.push({ day, sessions: sessions.reverse() });
  }
  return { days: out };
}

// ---- Fake model + background indexing ----
// Imported history (title-only) plus a few hundred pages with text. Once the model is ready it
// "loads" for 3 s, then embeds ~60 passages/s until done.

const MODEL_BYTES = 118 * 1024 * 1024;
const initialModel = params.get('model');
let modelState: ModelState =
  initialModel === 'none' || FRESH
    ? { status: 'not-downloaded', loaded: 0, total: 0, downloadedAt: null }
    : initialModel === 'downloading'
      ? { status: 'downloading', loaded: Math.round(MODEL_BYTES * 0.42), total: MODEL_BYTES, downloadedAt: null }
      : initialModel === 'error'
        ? { status: 'error', loaded: Math.round(MODEL_BYTES * 0.3), total: MODEL_BYTES, downloadedAt: null, error: 'The download stopped (network changed). Nothing was saved yet.' }
        : { status: 'ready', loaded: MODEL_BYTES, total: MODEL_BYTES, downloadedAt: Date.now() - 9 * DAY };

const IDX = { pages: FRESH ? 0 : 11_734, withText: FRESH ? 0 : 412, chunksPerTextPage: 6, startedAt: Date.now(), startEmbedded: modelState.status !== 'ready' ? 0 : params.get('indexed') === '1' ? 1e9 : 7_900, perSecond: 60 };
let mockSemantic = true;

/** Called by api.ts when mock settings change, so the fake embedder can show "Off". */
export function mockSetSemantic(on: boolean) {
  if (on && !mockSemantic) IDX.startedAt = Date.now();
  if (!on && mockSemantic) IDX.startEmbedded = indexStatus().chunksEmbedded;
  mockSemantic = on;
}

function indexStatus(): IndexStatus {
  const titleOnly = IDX.pages - IDX.withText;
  const chunksTotal = titleOnly + IDX.withText * IDX.chunksPerTextPage;
  const ready = modelState.status === 'ready';
  const running = mockSemantic && ready;
  const elapsed = (Date.now() - IDX.startedAt) / 1000;
  const loading = running && elapsed < 3;
  const chunksEmbedded = running ? Math.min(chunksTotal, Math.round(IDX.startEmbedded + Math.max(0, elapsed - 3) * IDX.perSecond)) : IDX.startEmbedded;
  const done = chunksEmbedded >= chunksTotal;
  const frac = chunksTotal ? chunksEmbedded / chunksTotal : 0;
  // 24 months, newest first; recent months are denser and the only ones with text.
  const now = new Date();
  const weights = Array.from({ length: 24 }, (_, i) => (i === 0 ? 0.5 : 1) * (1.6 - i / 24) * (0.8 + ((i * 37) % 10) / 25));
  const wsum = weights.reduce((a, b) => a + b, 0);
  let left = Math.round(IDX.pages * frac);
  const byMonth = IDX.pages
    ? weights.map((w, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const pagesInMonth = Math.round((IDX.pages * w) / wsum);
        const withText = i === 0 ? Math.round(IDX.withText * 0.55) : i === 1 ? IDX.withText - Math.round(IDX.withText * 0.55) : 0;
        const embedded = Math.min(pagesInMonth, left);
        left -= embedded;
        return { month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, pages: pagesInMonth, withText, embedded };
      })
    : [];
  const state: NonNullable<IndexStatus['embedder']>['state'] = !mockSemantic
    ? 'disabled'
    : modelState.status === 'not-downloaded'
      ? 'not-downloaded'
      : modelState.status === 'downloading'
        ? 'downloading'
        : modelState.status === 'error'
          ? 'error'
          : loading
            ? 'loading'
            : done
              ? 'ready'
              : 'indexing';
  return {
    pages: IDX.pages,
    pagesWithText: IDX.withText,
    titleOnlyPages: titleOnly,
    chunksTotal,
    chunksEmbedded,
    pagesEmbedded: Math.round(IDX.pages * frac),
    model: chunksEmbedded ? EMBED_MODEL : null,
    byMonth,
    embedder: {
      state,
      download: modelState.status === 'downloading' ? { loaded: modelState.loaded, total: modelState.total } : undefined,
      backend: state === 'indexing' || state === 'ready' ? 'webgpu' : null,
      error: modelState.status === 'error' ? modelState.error : undefined,
      perSecond: state === 'indexing' ? IDX.perSecond : undefined,
    },
  };
}

// ---- Fake chrome.storage.local ----

const store: Record<string, unknown> = {
  settings: { ...DEFAULT_SETTINGS, denylist: ['bank.example.com', 'mail.example.org'] },
  model: modelState,
  backup:
    params.get('backup') === 'none' || FRESH
      ? { lastAt: null, lastBytes: 0, lastFile: null, running: false }
      : {
          lastAt: Date.now() - 5 * 3_600_000,
          lastBytes: 18_734_592,
          lastFile: `${BACKUP_DIR}/history-plus-plus-${dayKeyOf(Date.now())}.sqlite3`,
          running: params.get('backup') === 'running',
          error: params.get('backup') === 'error' ? 'Downloads folder is not writable.' : undefined,
        },
  sync: FRESH ? null : { lastCatchUpAt: Date.now() - 42 * 60_000, added: 37 },
  onboarding: FRESH ? { completedAt: null, step: 1 } : { completedAt: Date.now() - 9 * DAY, step: 4 },
  backfill:
    params.get('backfill') === 'running' || FRESH
      ? { status: 'running', imported: 1_840, inserted: 1_840, total: 4_211, scanned: 1_310, startedAt: Date.now() - 20_000, updatedAt: Date.now(), finishedAt: null }
      : { status: 'done', imported: 9_412, inserted: 9_412, total: 4_211, scanned: 4_211, startedAt: Date.now() - 9 * DAY, updatedAt: Date.now() - 9 * DAY, finishedAt: Date.now() - 9 * DAY },
  imports: FRESH ? [] : [{ browser: 'Safari', file: 'History.db', visits: 6_120, inserted: 5_877, at: Date.now() - 9 * DAY }],
};
const listeners = new Map<string, Set<(v: unknown) => void>>();

export function mockGetStore(key: string): unknown {
  const v = store[key];
  return v == null ? null : structuredClone(v);
}
export function mockSetStore(key: string, value: unknown) {
  store[key] = structuredClone(value);
  if (key === 'model') modelState = store[key] as ModelState;
  listeners.get(key)?.forEach((l) => l(structuredClone(value)));
}
export function mockOnStore(key: string, cb: (v: unknown) => void): () => void {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(cb);
  return () => listeners.get(key)!.delete(cb);
}

let modelTimer: ReturnType<typeof setTimeout> | undefined;
function runModelDownload() {
  clearTimeout(modelTimer);
  let loaded = modelState.status === 'downloading' ? modelState.loaded : 0;
  const tick = () => {
    loaded = Math.min(MODEL_BYTES, loaded + 3.1 * 1024 * 1024);
    if (loaded < MODEL_BYTES) {
      mockSetStore('model', { status: 'downloading', loaded, total: MODEL_BYTES, downloadedAt: null });
      modelTimer = setTimeout(tick, 250);
    } else {
      IDX.startedAt = Date.now();
      mockSetStore('model', { status: 'ready', loaded, total: MODEL_BYTES, downloadedAt: Date.now() });
    }
  };
  tick();
}
// A download already in progress when the page opens keeps going.
if (modelState.status === 'downloading') setTimeout(runModelDownload, 500);

export async function mockBg(msg: { kind: string; action?: string }): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120));
  switch (msg.kind) {
    case 'model':
      if (msg.action === 'remove') {
        clearTimeout(modelTimer);
        IDX.startEmbedded = 0;
        mockSetStore('model', { status: 'not-downloaded', loaded: 0, total: 0, downloadedAt: null });
      } else {
        IDX.startEmbedded = 0;
        runModelDownload();
      }
      break;
    case 'backupNow': {
      const prev = store.backup as Record<string, unknown>;
      mockSetStore('backup', { ...prev, running: true, error: undefined });
      setTimeout(() => mockSetStore('backup', { lastAt: Date.now(), lastBytes: 18_734_592, lastFile: `${BACKUP_DIR}/history-plus-plus-${dayKeyOf(Date.now())}.sqlite3`, running: false }), 1800);
      break;
    }
    case 'backfill': {
      const total = 4211;
      let scanned = 0;
      const startedAt = Date.now();
      const tick = () => {
        scanned = Math.min(total, scanned + 400);
        const imported = Math.round(scanned * 2.2);
        const done = scanned >= total;
        mockSetStore('backfill', { status: done ? 'done' : 'running', imported, inserted: imported, total, scanned, startedAt, updatedAt: Date.now(), finishedAt: done ? Date.now() : null });
        if (!done) setTimeout(tick, 350);
      };
      tick();
      break;
    }
  }
  return { ok: true };
}

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60 + Math.random() * 120));

export async function mockEngine<K extends EngineOp>(op: K, args: EngineOps[K]['args']): Promise<EngineOps[K]['result']> {
  if (!built) build();
  const a = args as never;
  let result: unknown;
  switch (op) {
    case 'search':
      if ((args as EngineOps['search']['args']).q.includes('__error')) throw new Error('engine search: mock failure (offscreen document not responding)');
      result = search(a);
      break;
    case 'related':
      result = related(a);
      break;
    case 'timeline':
      result = timeline(a);
      break;
    case 'getPage': {
      const p = pages.find((x) => x.id === (args as { id: number }).id);
      result = p ? { ...p } : null;
      break;
    }
    case 'stats': {
      const byDomain = new Map<string, { visits: number; dwell_ms: number }>();
      for (const v of visits) {
        const d = byDomain.get(v.domain) ?? { visits: 0, dwell_ms: 0 };
        d.visits++;
        d.dwell_ms += v.dwell_ms;
        byDomain.set(v.domain, d);
      }
      result = {
        pages: FRESH ? 0 : IDX.pages,
        visits: FRESH ? 0 : visits.length + 38_000,
        pagesWithText: IDX.withText,
        oldestVisit: visits.length ? visits[visits.length - 1]!.ts : null,
        dbBytes: FRESH ? 98_304 : 18_734_592,
        topDomains: [...byDomain.entries()]
          .map(([domain, s]) => ({ domain, ...s }))
          .sort((x, y) => y.visits - x.visits)
          .slice(0, 10),
      };
      break;
    }
    case 'deletePage': {
      const id = (args as { id: number }).id;
      visits = visits.filter((v) => v.page_id !== id);
      pages = pages.filter((p) => p.id !== id);
      result = { ok: true };
      break;
    }
    case 'deleteDomain': {
      const dom = (args as { domain: string }).domain;
      const match = (d: string) => d === dom || d.endsWith(`.${dom}`);
      const n = pages.filter((p) => match(p.domain)).length;
      visits = visits.filter((v) => !match(v.domain));
      pages = pages.filter((p) => !match(p.domain));
      result = { deleted: n };
      break;
    }
    case 'deleteAll':
      visits = [];
      pages = [];
      IDX.pages = IDX.withText = IDX.startEmbedded = 0;
      result = { ok: true };
      break;
    case 'restoreDb': {
      const a = args as EngineOps['restoreDb']['args'];
      let head = a.bytes ? atob(a.bytes.slice(0, 24)) : '';
      if (a.opfsFile) {
        const f = await (await (await navigator.storage.getDirectory()).getFileHandle(a.opfsFile)).getFile();
        head = await f.slice(0, 16).text();
      }
      if (!head.startsWith('SQLite format 3')) throw new Error('engine restoreDb: this file is not a history++ backup');
      pages = [];
      visits = [];
      build();
      IDX.pages = 11_734;
      IDX.withText = 412;
      result = { pages: IDX.pages, visits: visits.length + 38_000 };
      break;
    }
    case 'exportDb':
      // Real engine sends base64 over messaging; mimic that. "SQLite format 3\0".
      result = { bytes: btoa('SQLite format 3\u0000') };
      break;
    case 'indexStatus':
      result = indexStatus();
      break;
    case 'exportJson':
      result = { json: JSON.stringify({ pages, visits }, null, 2) };
      break;
    default:
      throw new Error(`mock: op ${op} not supported`);
  }
  return delay(result as EngineOps[K]['result']);
}
