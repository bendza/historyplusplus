import { describe, expect, it } from 'vitest';
import type { DaySessions, VisitRow } from '../shared/protocol';
import { aggregatePages, sessionActiveMs, summarize } from './summary';
import { dayKey } from './format';

const NOW = new Date(2026, 9, 14, 15, 0).getTime();
const MIN = 60_000;

function visit(id: number, page: number, ts: number, domain = 'a.com', dwell = 0): VisitRow {
  return { id, page_id: page, ts, transition: 'link', dwell_ms: dwell, url: `https://${domain}/${page}`, domain, title: `P${page}` };
}

describe('sessionActiveMs', () => {
  it('uses the larger of span and dwell, at least a minute', () => {
    expect(sessionActiveMs({ start: 0, end: 10 * MIN, visits: [visit(1, 1, 0)] })).toBe(10 * MIN);
    expect(sessionActiveMs({ start: 0, end: 0, visits: [visit(1, 1, 0, 'a.com', 3 * MIN)] })).toBe(3 * MIN);
    expect(sessionActiveMs({ start: 0, end: 0, visits: [visit(1, 1, 0)] })).toBe(MIN);
  });
});

describe('aggregatePages', () => {
  it('counts visits per page, most visited first', () => {
    const agg = aggregatePages([visit(1, 1, 10), visit(2, 2, 20), visit(3, 2, 30, 'a.com', 5)]);
    expect(agg.map((a) => [a.page_id, a.visits, a.last, a.dwell_ms])).toEqual([
      [2, 2, 30, 5],
      [1, 1, 10, 0],
    ]);
  });
});

describe('summarize', () => {
  it('builds 7 days oldest-first with zero days filled, plus top sites', () => {
    const today = dayKey(NOW);
    const twoAgo = dayKey(NOW - 2 * 86_400_000);
    const days: DaySessions[] = [
      { day: today, sessions: [{ start: NOW - 30 * MIN, end: NOW - 10 * MIN, visits: [visit(1, 1, NOW - 10 * MIN, 'b.com'), visit(2, 2, NOW - 30 * MIN, 'b.com')] }] },
      { day: twoAgo, sessions: [{ start: NOW - 2 * 86_400_000, end: NOW - 2 * 86_400_000, visits: [visit(3, 1, NOW - 2 * 86_400_000, 'a.com')] }] },
    ];
    const s = summarize(days, 7, NOW);
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay[6]).toEqual({ day: today, visits: 2, activeMs: 20 * MIN });
    expect(s.byDay[4]!.visits).toBe(1);
    expect(s.byDay[5]!.visits).toBe(0);
    expect(s.visits).toBe(3);
    expect(s.pages).toBe(2);
    expect(s.activeMs).toBe(21 * MIN);
    expect(s.topSites.map((t) => [t.domain, t.visits])).toEqual([
      ['b.com', 2],
      ['a.com', 1],
    ]);
  });
});

describe('insights helpers', () => {
  it('buckets visits by weekday (Monday first) and hour', async () => {
    const { hourOfWeek, peakSlot } = await import('./summary');
    const mon9 = new Date(2026, 9, 12, 9, 30).getTime(); // Monday
    const sun23 = new Date(2026, 9, 18, 23, 5).getTime(); // Sunday
    const grid = hourOfWeek([{ ts: mon9 }, { ts: mon9 + 60_000 }, { ts: sun23 }]);
    expect(grid[0]![9]).toBe(2);
    expect(grid[6]![23]).toBe(1);
    expect(peakSlot(grid)).toEqual([0, 9]);
    expect(peakSlot(hourOfWeek([]))).toBeNull();
  });

  it('finds sites that came back after a long gap', async () => {
    const { rediscovered } = await import('./summary');
    const D = 86_400_000;
    const v = (domain: string, daysAgo: number) => ({ domain, url: `https://${domain}/`, ts: NOW - daysAgo * D });
    const r = rediscovered([v('a.com', 70), v('a.com', 5), v('a.com', 2), v('b.com', 40), v('b.com', 20), v('c.com', 90), v('c.com', 45)], NOW);
    expect(r.map((x) => [x.domain, x.gapDays, x.visitsSince])).toEqual([['a.com', 65, 2]]);
  });

  it('computes week-over-week change', async () => {
    const { deltaPct } = await import('./summary');
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
    expect(deltaPct(5, 0)).toBeNull();
  });
});
