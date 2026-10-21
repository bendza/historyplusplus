import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/protocol';
import { CATCHUP_DEFAULT_LOOKBACK_MS, CATCHUP_OVERLAP_MS, catchUpSince, runCatchUp, type CatchUpDeps } from './catchup';
import type { ImportVisit } from './backfill';

describe('catchUpSince', () => {
  it('starts an overlap before the last sync, else the backfill, else a week back', () => {
    const now = 100 * CATCHUP_OVERLAP_MS;
    expect(catchUpSince({ lastCatchUpAt: 50 * CATCHUP_OVERLAP_MS }, 1, now)).toBe(49 * CATCHUP_OVERLAP_MS);
    expect(catchUpSince(undefined, 10 * CATCHUP_OVERLAP_MS, now)).toBe(9 * CATCHUP_OVERLAP_MS);
    expect(catchUpSince({ lastCatchUpAt: 50 * CATCHUP_OVERLAP_MS }, 1, now, 49.5 * CATCHUP_OVERLAP_MS)).toBe(49.5 * CATCHUP_OVERLAP_MS);
    expect(catchUpSince(undefined, undefined, now)).toBe(Math.max(0, now - CATCHUP_DEFAULT_LOOKBACK_MS - CATCHUP_OVERLAP_MS));
  });
});

describe('runCatchUp', () => {
  const history = [
    { url: 'https://a.example/', title: 'A', lastVisitTime: 300 },
    { url: 'https://mail.google.com/x', title: 'mail', lastVisitTime: 300 },
    { url: 'https://old.example/', title: 'Old', lastVisitTime: 50 },
  ];
  const visits: Record<string, { visitTime: number; transition?: string }[]> = {
    'https://a.example/': [{ visitTime: 10 }, { visitTime: 200, transition: 'typed' }, { visitTime: 300 }],
    'https://mail.google.com/x': [{ visitTime: 250 }],
  };

  function deps(over: Partial<CatchUpDeps> = {}) {
    const imported: ImportVisit[] = [];
    let startTime = -1;
    const d: CatchUpDeps = {
      searchHistory: async (t) => ((startTime = t), history),
      getVisits: async (url) => visits[url] ?? [],
      importVisits: async (v) => (imported.push(...v), { inserted: v.length - 1 }),
      getSettings: async () => DEFAULT_SETTINGS,
      now: () => 1000,
      ...over,
    };
    return { d, imported, startTime: () => startTime };
  }

  it('imports only visits in the window, applying privacy rules', async () => {
    const { d, imported, startTime } = deps();
    const s = await runCatchUp(100, d);
    expect(startTime()).toBe(100);
    expect(imported).toEqual([
      { url: 'https://a.example/', title: 'A', ts: 200, transition: 'typed' },
      { url: 'https://a.example/', title: 'A', ts: 300, transition: undefined },
    ]);
    expect(s).toEqual({ lastCatchUpAt: 1000, added: 1 });
  });

  it('skips everything while paused but advances the window', async () => {
    const { d, imported } = deps({ getSettings: async () => ({ ...DEFAULT_SETTINGS, paused: true }) });
    expect(await runCatchUp(100, d)).toEqual({ lastCatchUpAt: 1000, added: 0 });
    expect(imported).toEqual([]);
  });
});
