// Pure helpers for the UI: time/duration formatting, base64 decoding, hash routing.
// No DOM or extension APIs here so everything is unit-testable in node.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else a short date. */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return formatDate(ts);
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY && sameDay(ts, now)) return `${Math.floor(diff / HOUR)} h ago`;
  const days = daysBetween(ts, now);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDate(ts, now);
}

/** Calendar days between two timestamps in local time (b >= a). */
export function daysBetween(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / DAY);
}

export function sameDay(a: number, b: number): boolean {
  return daysBetween(a, b) === 0;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mar 4" in the current year, "Mar 4, 2024" otherwise. */
export function formatDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** 24h "HH:MM" local time. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact dwell: "0s", "45s", "3m", "3m 20s" (under 10 min), "1h 5m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return m < 10 && rest ? `${m}m ${rest}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local-time YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight (epoch ms) for a YYYY-MM-DD key. */
export function dayStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).getTime();
}

/** Heading for a timeline day: "Today", "Yesterday", or "Tuesday, Mar 4[, 2024]". */
export function dayLabel(key: string, now = Date.now()): string {
  const start = dayStart(key);
  const diff = daysBetween(start, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const weekday = new Date(start).toLocaleDateString('en-US', { weekday: 'long' });
  return `${weekday}, ${formatDate(start, now)}`;
}

/**
 * Search queries for "On this day": the same calendar day 1..years back.
 * after: is inclusive and before: exclusive, so [day, day+1).
 * Feb 29 in a non-leap year is skipped.
 */
export function onThisDayQueries(now = Date.now(), years = 5): { year: number; q: string }[] {
  const d = new Date(now);
  const out: { year: number; q: string }[] = [];
  for (let i = 1; i <= years; i++) {
    const y = d.getFullYear() - i;
    const day = new Date(y, d.getMonth(), d.getDate());
    if (day.getMonth() !== d.getMonth()) continue;
    const next = new Date(y, d.getMonth(), d.getDate() + 1);
    out.push({ year: y, q: `after:${dayKey(day.getTime())} before:${dayKey(next.getTime())}` });
  }
  return out;
}

/**
 * exportDb bytes arrive as a base64 string over runtime messaging, but accept
 * a Uint8Array, a number[] or an index-keyed object (structured-clone fallout) too.
 */
export function toBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') {
    const clean = input.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input as number[]);
  if (input && typeof input === 'object') {
    const obj = input as Record<string, number>;
    const len = Object.keys(obj).length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = obj[i] ?? 0;
    return out;
  }
  throw new Error('export: unrecognised bytes payload');
}

export function exportFilename(ext: 'sqlite3' | 'json', now = Date.now()): string {
  return `history-plus-plus-${dayKey(now)}.${ext}`;
}

/** Denylist textarea -> normalised, deduped domains. */
export function parseDenylist(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,]+/)) {
    let d = raw.trim().toLowerCase();
    if (!d || d.startsWith('#')) continue;
    d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^\*\./, '').replace(/^www\./, '');
    if (d) seen.add(d);
  }
  return [...seen];
}

/** Time chip on the home search: added to the query as after:/before: operators. */
export type TimeRange = { id: 'any' } | { id: 'today' | 'week' | 'month' } | { id: 'custom'; from: string; to: string };

/** Operators for a time chip ('' for Any time). `to` is inclusive, so before: is the day after. */
export function rangeOperators(r: TimeRange, now = Date.now()): string {
  const today = dayKey(now);
  const plus = (key: string, n: number) => dayKey(dayStart(key) + n * DAY + 12 * HOUR);
  switch (r.id) {
    case 'any':
      return '';
    case 'today':
      return `after:${today}`;
    case 'week': {
      const d = new Date(now);
      return `after:${plus(today, -((d.getDay() + 6) % 7))}`;
    }
    case 'month':
      return `after:${today.slice(0, 8)}01`;
    case 'custom':
      return [r.from ? `after:${r.from}` : '', r.to ? `before:${plus(r.to, 1)}` : ''].filter(Boolean).join(' ');
  }
}

// ---- Hash routing ----

export type Route =
  | { view: 'search'; q: string }
  | { view: 'timeline' }
  | { view: 'insights' }
  | { view: 'page'; id: number }
  | { view: 'settings' }
  | { view: 'welcome'; step: number };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '');
  const [path = '', query = ''] = h.split('?', 2) as [string?, string?];
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'timeline':
      return { view: 'timeline' };
    case 'settings':
      return { view: 'settings' };
    case 'insights':
      return { view: 'insights' };
    case 'welcome': {
      const step = Number(parts[1]);
      return { view: 'welcome', step: Number.isInteger(step) && step >= 1 && step <= 4 ? step : 1 };
    }
    case 'page': {
      const id = Number(parts[1]);
      if (Number.isInteger(id) && id > 0) return { view: 'page', id };
      return { view: 'search', q: '' };
    }
    default:
      return { view: 'search', q: new URLSearchParams(query).get('q') ?? '' };
  }
}

export function routeHash(r: Route): string {
  switch (r.view) {
    case 'search':
      return r.q ? `#/search?q=${encodeURIComponent(r.q)}` : '#/search';
    case 'page':
      return `#/page/${r.id}`;
    case 'welcome':
      return `#/welcome/${r.step}`;
    default:
      return `#/${r.view}`;
  }
}

/** Hostname for display, without "www.". Falls back to the raw string. */
export function displayDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
