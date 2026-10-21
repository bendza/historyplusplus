// Pure summaries over timeline data for the home screens. No DOM or extension APIs (unit-tested).
import type { DaySessions, VisitRow } from '../shared/protocol';
import { dayKey } from './format';

const DAY = 86_400_000;

export interface PageAgg {
  page_id: number;
  url: string;
  title: string;
  domain: string;
  visits: number;
  dwell_ms: number;
  last: number;
}

export interface WeekSummary {
  visits: number;
  pages: number;
  activeMs: number; // time inside browsing sessions (span, or dwell when larger)
  byDay: { day: string; visits: number; activeMs: number }[]; // oldest -> newest, 7 entries
  topSites: { domain: string; url: string; visits: number }[];
  topPages: PageAgg[];
}

export function sessionActiveMs(s: DaySessions['sessions'][number]): number {
  const dwell = s.visits.reduce((n, v) => n + v.dwell_ms, 0);
  // Imported history has no dwell; a lone visit still counts for a minute.
  return Math.max(dwell, s.end - s.start, 60_000);
}

/** Same title on the same site counts as one page (feeds, inboxes and tracking variants of one URL). */
export function sameKey(v: { page_id: number; domain: string; title: string }): string {
  return v.title ? `${v.domain}|${v.title}` : `#${v.page_id}`;
}

/** Visits with repeat pages (by sameKey) removed, first occurrence kept. */
export function uniquePages<T extends VisitRow>(visits: T[]): T[] {
  const seen = new Set<string>();
  return visits.filter((v) => {
    const k = sameKey(v);
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export function aggregatePages(visits: VisitRow[]): PageAgg[] {
  const m = new Map<string, PageAgg>();
  for (const v of visits) {
    const a = m.get(sameKey(v)) ?? { page_id: v.page_id, url: v.url, title: v.title, domain: v.domain, visits: 0, dwell_ms: 0, last: 0 };
    a.visits++;
    a.dwell_ms += v.dwell_ms;
    if (v.ts > a.last) {
      a.last = v.ts;
      a.url = v.url;
      a.page_id = v.page_id;
    }
    m.set(sameKey(v), a);
  }
  return [...m.values()].sort((a, b) => b.visits - a.visits || b.last - a.last);
}

export function summarize(days: DaySessions[], span = 7, now = Date.now()): WeekSummary {
  const all = days.flatMap((d) => d.sessions.flatMap((s) => s.visits));
  const byDayMap = new Map(days.map((d) => [d.day, d]));
  const byDay = Array.from({ length: span }, (_, i) => {
    const key = dayKey(now - (span - 1 - i) * DAY);
    const d = byDayMap.get(key);
    return {
      day: key,
      visits: d ? d.sessions.reduce((n, s) => n + s.visits.length, 0) : 0,
      activeMs: d ? d.sessions.reduce((n, s) => n + sessionActiveMs(s), 0) : 0,
    };
  });
  const sites = new Map<string, { domain: string; url: string; visits: number }>();
  for (const v of all) {
    const dom = v.domain || '';
    if (!dom) continue;
    const s = sites.get(dom) ?? { domain: dom, url: v.url, visits: 0 };
    s.visits++;
    sites.set(dom, s);
  }
  return {
    visits: all.length,
    pages: new Set(all.map((v) => v.page_id)).size,
    activeMs: byDay.reduce((n, d) => n + d.activeMs, 0),
    byDay,
    topSites: [...sites.values()].sort((a, b) => b.visits - a.visits).slice(0, 8),
    topPages: aggregatePages(all),
  };
}


// ---- Insights ----

/** Visits per hour of the week: grid[weekday][hour], weekday 0 = Monday. */
export function hourOfWeek(visits: { ts: number }[]): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const v of visits) {
    const d = new Date(v.ts);
    grid[(d.getDay() + 6) % 7]![d.getHours()]!++;
  }
  return grid;
}

/** Busiest hour of the week as [weekday (0 = Monday), hour], or null without visits. */
export function peakSlot(grid: number[][]): [number, number] | null {
  let best: [number, number] | null = null;
  let max = 0;
  grid.forEach((row, d) =>
    row.forEach((n, hr) => {
      if (n > max) {
        max = n;
        best = [d, hr];
      }
    }),
  );
  return best;
}

export interface Rediscovered {
  domain: string;
  url: string;
  lastBefore: number; // last visit before the gap
  back: number; // first visit after it
  gapDays: number;
  visitsSince: number;
}

/**
 * Sites seen again after a quiet spell of `gapDays` or more, where the return happened
 * within `recentDays` of `now`. Longest gap first.
 */
export function rediscovered(visits: { ts: number; domain: string; url: string }[], now = Date.now(), gapDays = 30, recentDays = 30): Rediscovered[] {
  const byDomain = new Map<string, { ts: number; url: string }[]>();
  for (const v of visits) {
    if (!v.domain) continue;
    const list = byDomain.get(v.domain) ?? [];
    list.push({ ts: v.ts, url: v.url });
    byDomain.set(v.domain, list);
  }
  const out: Rediscovered[] = [];
  const since = now - recentDays * DAY;
  for (const [domain, list] of byDomain) {
    list.sort((a, b) => a.ts - b.ts);
    // The latest qualifying gap whose return falls in the recent window.
    for (let i = list.length - 1; i > 0; i--) {
      const back = list[i]!;
      const prev = list[i - 1]!;
      if (back.ts < since) break;
      const gap = back.ts - prev.ts;
      if (gap >= gapDays * DAY) {
        out.push({ domain, url: back.url, lastBefore: prev.ts, back: back.ts, gapDays: Math.floor(gap / DAY), visitsSince: list.length - i });
        break;
      }
    }
  }
  return out.sort((a, b) => b.gapDays - a.gapDays);
}

/** Percent change from `prev` to `cur`, rounded; null when there is nothing to compare with. */
export function deltaPct(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null;
  return Math.round(((cur - prev) / prev) * 100);
}
