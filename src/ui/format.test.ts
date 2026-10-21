import { describe, expect, it } from 'vitest';
import {
  dayKey,
  dayLabel,
  dayStart,
  exportFilename,
  formatBytes,
  formatDuration,
  onThisDayQueries,
  parseDenylist,
  parseRoute,
  relativeTime,
  routeHash,
  toBytes,
} from './format';

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('relativeTime', () => {
  const now = at(2026, 10, 13, 15, 0);
  it('covers the buckets', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(at(2026, 10, 13, 12, 0), now)).toBe('3 h ago');
    expect(relativeTime(at(2026, 10, 12, 23, 0), now)).toBe('yesterday');
    expect(relativeTime(at(2026, 10, 9), now)).toBe('4 days ago');
    expect(relativeTime(at(2026, 3, 4), now)).toBe('Mar 4');
    expect(relativeTime(at(2024, 3, 4), now)).toBe('Mar 4, 2024');
  });
  it('treats late last night as yesterday, not hours ago', () => {
    expect(relativeTime(at(2026, 10, 12, 23, 30), at(2026, 10, 13, 1, 0))).toBe('yesterday');
  });
});

describe('formatDuration', () => {
  it('formats', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(200_000)).toBe('3m 20s');
    expect(formatDuration(180_000)).toBe('3m');
    expect(formatDuration(12 * 60_000 + 5000)).toBe('12m');
    expect(formatDuration(65 * 60_000)).toBe('1h 5m');
    expect(formatDuration(2 * 3600_000)).toBe('2h');
  });
});

describe('formatBytes', () => {
  it('formats', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
});

describe('days', () => {
  it('round-trips day keys', () => {
    const ts = at(2026, 3, 4, 18);
    expect(dayKey(ts)).toBe('2026-03-04');
    expect(dayStart('2026-03-04')).toBe(at(2026, 3, 4, 0));
  });
  it('labels days', () => {
    const now = at(2026, 10, 13, 9);
    expect(dayLabel('2026-10-13', now)).toBe('Today');
    expect(dayLabel('2026-10-12', now)).toBe('Yesterday');
    expect(dayLabel('2026-10-06', now)).toBe('Tuesday, Oct 6');
    expect(dayLabel('2025-10-06', now)).toBe('Monday, Oct 6, 2025');
  });
  it('builds on-this-day queries', () => {
    const q = onThisDayQueries(at(2026, 10, 13), 2);
    expect(q).toEqual([
      { year: 2025, q: 'after:2025-10-13 before:2025-10-14' },
      { year: 2024, q: 'after:2024-10-13 before:2024-10-14' },
    ]);
    // Feb 29 only exists in leap years; Dec 31 rolls into next year.
    expect(onThisDayQueries(at(2028, 2, 29), 4).map((x) => x.year)).toEqual([2024]);
    expect(onThisDayQueries(at(2026, 12, 31), 1)[0]!.q).toBe('after:2025-12-31 before:2026-01-01');
  });
});

describe('toBytes', () => {
  it('decodes base64 strings and passes arrays through', () => {
    expect([...toBytes('U1FM')]).toEqual([83, 81, 76]);
    expect([...toBytes('data:application/octet-stream;base64,U1FM')]).toEqual([83, 81, 76]);
    expect([...toBytes([1, 2, 3])]).toEqual([1, 2, 3]);
    expect([...toBytes(new Uint8Array([9]))]).toEqual([9]);
    expect([...toBytes({ 0: 7, 1: 8 })]).toEqual([7, 8]);
    expect(() => toBytes(null)).toThrow();
  });
  it('names exports', () => {
    expect(exportFilename('sqlite3', at(2026, 1, 2))).toBe('history-plus-plus-2026-01-02.sqlite3');
  });
});

describe('parseDenylist', () => {
  it('normalises', () => {
    expect(parseDenylist(' Bank.com\nhttps://www.mail.example.org/inbox\n\n# comment\n*.ads.net, bank.com')).toEqual([
      'bank.com',
      'mail.example.org',
      'ads.net',
    ]);
  });
});

describe('routes', () => {
  it('parses', () => {
    expect(parseRoute('')).toEqual({ view: 'search', q: '' });
    expect(parseRoute('#/search?q=site%3Agithub.com%20foo')).toEqual({ view: 'search', q: 'site:github.com foo' });
    expect(parseRoute('#/timeline')).toEqual({ view: 'timeline' });
    expect(parseRoute('#/page/42')).toEqual({ view: 'page', id: 42 });
    expect(parseRoute('#/page/abc')).toEqual({ view: 'search', q: '' });
    expect(parseRoute('#/settings')).toEqual({ view: 'settings' });
  });
  it('round-trips', () => {
    for (const r of [
      { view: 'search', q: 'a "b c" before:2024-01-01' },
      { view: 'search', q: '' },
      { view: 'page', id: 7 },
      { view: 'timeline' },
      { view: 'settings' },
    ] as const) {
      expect(parseRoute(routeHash(r))).toEqual(r);
    }
  });
});

describe('rangeOperators', () => {
  it('turns time chips into after:/before: operators', async () => {
    const { rangeOperators } = await import('./format');
    const now = new Date(2026, 9, 14, 15, 0).getTime(); // Wednesday
    expect(rangeOperators({ id: 'any' }, now)).toBe('');
    expect(rangeOperators({ id: 'today' }, now)).toBe('after:2026-10-14');
    expect(rangeOperators({ id: 'week' }, now)).toBe('after:2026-10-12');
    expect(rangeOperators({ id: 'month' }, now)).toBe('after:2026-10-01');
    expect(rangeOperators({ id: 'custom', from: '2026-09-01', to: '2026-09-30' }, now)).toBe('after:2026-09-01 before:2026-10-01');
  });
});
