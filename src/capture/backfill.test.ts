import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/protocol';
import { BACKFILL_CHUNK, chunk, isBackfillRunning, mapHistoryItem, runBackfill, type BackfillState, type ImportVisit } from './backfill';

describe('mapHistoryItem', () => {
  it('maps each visit and drops denied URLs', () => {
    const item = { url: 'https://example.com/a', title: 'A', lastVisitTime: 3 };
    expect(mapHistoryItem(item, [{ visitTime: 1.4, transition: 'link' }, { visitTime: 2, transition: 'typed' }], DEFAULT_SETTINGS)).toEqual([
      { url: 'https://example.com/a', title: 'A', ts: 1, transition: 'link' },
      { url: 'https://example.com/a', title: 'A', ts: 2, transition: 'typed' },
    ]);
    expect(mapHistoryItem({ url: 'https://mail.google.com/x' }, [{ visitTime: 1 }], DEFAULT_SETTINGS)).toEqual([]);
    expect(mapHistoryItem({ url: 'https://example.com/' }, [{ visitTime: 1 }], { denylist: ['example.com'] })).toEqual([]);
  });

  it('falls back to lastVisitTime when there are no visits', () => {
    expect(mapHistoryItem({ url: 'https://example.com/', title: '', lastVisitTime: 9 }, [], DEFAULT_SETTINGS)).toEqual([
      { url: 'https://example.com/', title: undefined, ts: 9 },
    ]);
  });
});

describe('chunk / isBackfillRunning', () => {
  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('treats stale running state as not running', () => {
    const s = { status: 'running', updatedAt: 0 } as BackfillState;
    expect(isBackfillRunning(s, 1000)).toBe(true);
    expect(isBackfillRunning(s, 10 * 60_000)).toBe(false);
    expect(isBackfillRunning({ ...s, status: 'done' }, 1000)).toBe(false);
    expect(isBackfillRunning(undefined)).toBe(false);
  });
});

describe('runBackfill', () => {
  it('imports in chunks and records progress', async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ url: `https://site${i}.com/`, title: `t${i}` }));
    items.push({ url: 'chrome://settings', title: 'x' });
    const batches: ImportVisit[][] = [];
    const states: BackfillState[] = [];
    const final = await runBackfill({
      searchHistory: async () => items,
      getVisits: async () => [{ visitTime: 1, transition: 'link' }, { visitTime: 2, transition: 'link' }],
      importVisits: async (v) => {
        batches.push(v);
        return { inserted: v.length };
      },
      getSettings: async () => DEFAULT_SETTINGS,
      saveState: async (s) => void states.push(s),
      now: () => 42,
    });
    expect(batches.every((b) => b.length <= BACKFILL_CHUNK)).toBe(true);
    expect(batches.flat().length).toBe(600);
    expect(final).toMatchObject({ status: 'done', imported: 600, inserted: 600, total: 301, scanned: 301, finishedAt: 42 });
    expect(states[0]!.status).toBe('running');
    expect(states.at(-1)!.status).toBe('done');
  });

  it('imports nothing while paused, and nothing from before the last resume', async () => {
    const run = async (paused: boolean, since?: number) => {
      const got: ImportVisit[] = [];
      let searchedFrom: number | null = null;
      await runBackfill({
        since,
        searchHistory: async (startTime) => {
          searchedFrom = startTime;
          return [{ url: 'https://a.com/', lastVisitTime: 30 }, { url: 'https://b.com/', lastVisitTime: 5 }];
        },
        getVisits: async (url) => (url === 'https://a.com/' ? [{ visitTime: 5 }, { visitTime: 30 }] : []),
        importVisits: async (v) => {
          got.push(...v);
          return { inserted: v.length };
        },
        getSettings: async () => ({ ...DEFAULT_SETTINGS, paused }),
        saveState: async () => {},
      });
      return { ts: got.map((v) => `${v.url}@${v.ts}`), searchedFrom };
    };
    expect(await run(true)).toEqual({ ts: [], searchedFrom: null });
    expect(await run(false, 10)).toEqual({ ts: ['https://a.com/@30'], searchedFrom: 10 });
    expect((await run(false)).ts).toEqual(['https://a.com/@5', 'https://a.com/@30', 'https://b.com/@5']);
  });

  it('reports errors in state', async () => {
    const final = await runBackfill({
      searchHistory: async () => [{ url: 'https://a.com/' }],
      getVisits: async () => [{ visitTime: 1 }],
      importVisits: async () => {
        throw new Error('engine down');
      },
      getSettings: async () => DEFAULT_SETTINGS,
      saveState: async () => {},
    });
    expect(final.status).toBe('error');
    expect(final.error).toContain('engine down');
  });
});
