// Data hooks shared by the home layouts and the popup. Everything is composed from the
// existing engine ops (search with operators, timeline, stats, indexStatus) via api.call.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DaySessions, IndexStatus, ParsedQuery, SearchHit, SearchQuery, Stats } from '../shared/protocol';
import { call, getSettings, openUrl } from './api';
import { dayKey, dayStart, onThisDayQueries, rangeOperators, type TimeRange } from './format';

export { rangeOperators, type TimeRange } from './format';
import { aggregatePages, type PageAgg } from './summary';
import { pollInterval } from './coverage';

export { aggregatePages, deltaPct, hourOfWeek, peakSlot, rediscovered, sameKey, sessionActiveMs, summarize, uniquePages, type PageAgg, type Rediscovered, type WeekSummary } from './summary';

const DAY = 86_400_000;
export const DATA_CHANGED = 'hpp:data-changed';

/** Run an async loader once (and again on DATA_CHANGED). */
function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: unknown; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    load().then(
      (d) => alive && (setData(d), setError(null)),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [nonce, ...deps]);
  useEffect(() => {
    const on = () => setNonce((n) => n + 1);
    addEventListener(DATA_CHANGED, on);
    return () => removeEventListener(DATA_CHANGED, on);
  }, []);
  return { data, error, reload: () => setNonce((n) => n + 1) };
}

export const useStats = () => useLoad<Stats>(() => call('stats', {}));

export function useTimeline(days: number) {
  return useLoad<DaySessions[]>(async () => (await call('timeline', { days })).days, [days]);
}

/** indexStatus, polled fast while the model is busy. */
export function useIndexStatus(fastMs?: number): IndexStatus | null {
  const [s, setS] = useState<IndexStatus | null>(null);
  const latest = useRef<IndexStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await call('indexStatus', {});
        if (!alive) return;
        latest.current = r;
        setS(r);
      } catch {
        // Status is decorative on the home screens; the Settings card shows errors.
      }
      if (alive) timer = setTimeout(tick, fastMs ?? pollInterval(latest.current));
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [fastMs]);
  return s;
}

// ---- Rediscover ----

export interface OnThisDayYear {
  year: number;
  q: string;
  hits: SearchHit[];
  total: number;
}

export function useOnThisDay(perYear = 4) {
  return useLoad<OnThisDayYear[]>(async () => {
    const all = await Promise.all(
      onThisDayQueries().map(async ({ year, q }) => {
        try {
          const r = await call('search', { q, limit: perYear });
          return { year, q, hits: r.hits, total: r.total };
        } catch {
          return { year, q, hits: [], total: 0 };
        }
      }),
    );
    return all.filter((y) => y.hits.length);
  });
}

// ---- Search ----

export type Mode = NonNullable<SearchQuery['mode']>;
const MODE_KEY = 'hpp.searchMode';
export type Sort = NonNullable<SearchQuery['sort']>;
const SORT_KEY = 'hpp.searchSort';

function loadSort(): Sort {
  try {
    return localStorage.getItem(SORT_KEY) === 'recent' ? 'recent' : 'relevance';
  } catch {
    return 'relevance';
  }
}
const PAGE = 24;

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'keyword' ? 'keyword' : 'hybrid';
  } catch {
    return 'hybrid';
  }
}

export interface SearchResults {
  q: string;
  hits: SearchHit[];
  total: number;
  tookMs: number;
  parsed: ParsedQuery;
  dateLabel: string | null;
}

export interface SearchState {
  input: string;
  setInput: (v: string) => void;
  q: string;
  res: SearchResults | null;
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  retry: () => void;
  loadMore: () => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  sort: Sort; // 'relevance' = best match first, 'recent' = newest visit first
  setSort: (s: Sort) => void;
  semantic: boolean | null; // null until settings load
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  sel: number; // selected page id, -1 = none
  setSel: (id: number) => void;
  /** Keyboard handling for the search box + results, over hits in display order. */
  onKeyDown: (e: KeyboardEvent, ordered: SearchHit[]) => void;
  inputRef: { current: HTMLInputElement | null };
}

/**
 * Debounced hybrid/keyword search. Empty query = no request (`res` null), the
 * layouts show their home sections instead. `onCommit` sees each settled query.
 */
export function useSearch(initial: string, opts: { onCommit?: (q: string) => void; limit?: number; debounceMs?: number } = {}): SearchState {
  const [input, setInput] = useState(initial);
  const [res, setRes] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mode, setModeState] = useState<Mode>(loadMode);
  const [sort, setSortState] = useState<Sort>(loadSort);
  const [semantic, setSemantic] = useState<boolean | null>(null);
  const [sel, setSel] = useState(-1);
  const [range, setRange] = useState<TimeRange>({ id: 'any' });
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const limit = opts.limit ?? PAGE;

  useEffect(() => {
    getSettings().then((s) => setSemantic(s.semanticSearch), () => setSemantic(false));
  }, []);

  const effMode: Mode = semantic ? mode : 'keyword';
  const ops = rangeOperators(range);
  const q = [input.trim(), ops].filter(Boolean).join(' ');

  const run = async (query: string) => {
    const my = ++seq.current;
    if (!query) {
      setRes(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await call('search', { q: query, limit, offset: 0, mode: effMode, sort });
      if (my !== seq.current) return;
      setRes({ q: query, hits: r.hits, total: r.total, tookMs: r.tookMs, parsed: r.parsed, dateLabel: r.dateLabel ?? null });
      setSel(-1);
    } catch (e) {
      if (my === seq.current) setError(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (semantic === null) return;
    const t = setTimeout(() => {
      opts.onCommit?.(input);
      void run(q);
    }, res || q ? (opts.debounceMs ?? 140) : 0);
    return () => clearTimeout(t);
  }, [q, effMode, sort, semantic]);

  // Settings (e.g. search by meaning turned on in another tab) can change under us.
  useEffect(() => {
    const on = () => getSettings().then((s) => setSemantic(s.semanticSearch), () => {});
    addEventListener(DATA_CHANGED, on);
    return () => removeEventListener(DATA_CHANGED, on);
  }, []);

  const loadMore = async () => {
    if (!res) return;
    const my = seq.current;
    setLoadingMore(true);
    try {
      const r = await call('search', { q: res.q, limit, offset: res.hits.length, mode: effMode, sort });
      if (my !== seq.current) return;
      setRes({ ...res, hits: [...res.hits, ...r.hits], total: r.total });
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Storage blocked: the choice just won't survive a reload.
    }
  };

  const setSort = (v: Sort) => {
    setSortState(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      // Storage blocked: the choice just won't survive a reload.
    }
  };

  const onKeyDown = (e: KeyboardEvent, ordered: SearchHit[]) => {
    const idx = ordered.findIndex((h) => h.id === sel);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = ordered[Math.min(ordered.length - 1, idx + 1)];
      if (next) setSel(next.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx <= 0) {
        setSel(-1);
        inputRef.current?.focus();
      } else setSel(ordered[idx - 1]!.id);
    } else if (e.key === 'Enter') {
      const target = e.target as HTMLElement;
      if (target.tagName === 'BUTTON' || (target.tagName === 'A' && idx < 0)) return;
      const hit = ordered[idx < 0 ? 0 : idx];
      if (!hit) return;
      e.preventDefault();
      void openUrl(hit.url, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape' && (input || range.id !== 'any')) {
      setInput('');
      setRange({ id: 'any' });
      inputRef.current?.focus();
    }
  };

  useEffect(() => {
    if (sel < 0) return;
    document.querySelector<HTMLElement>(`[data-hit="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  return {
    input,
    setInput,
    q,
    res: q ? res : null,
    loading,
    loadingMore,
    error,
    retry: () => void run(q),
    loadMore: () => void loadMore(),
    mode,
    setMode,
    sort,
    setSort,
    semantic,
    range,
    setRange,
    sel,
    setSel,
    onKeyDown,
    inputRef,
  };
}

// Chrome fires mousemove when content scrolls under a still pointer; only real
// pointer movement should steal the keyboard selection.
let lastPointer = '';
export function pointerMoved(e: MouseEvent): boolean {
  const key = `${e.screenX},${e.screenY}`;
  if (key === lastPointer) return false;
  lastPointer = key;
  return true;
}
