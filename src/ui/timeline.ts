import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { DaySessions, SearchHit } from '../shared/protocol';
import { call } from './api';
import { ErrorBanner, Favicon, Spinner } from './common';
import { dayLabel, dayStart, displayDomain, formatClock, formatDuration, onThisDayQueries, routeHash } from './format';

const WINDOW_DAYS = 7;
const DAY = 86_400_000;

/** Append a fetched window, merging a day that straddles the boundary. */
function mergeDays(prev: DaySessions[], next: DaySessions[]): DaySessions[] {
  const out = prev.map((d) => ({ ...d, sessions: [...d.sessions] }));
  for (const d of next) {
    const existing = out.find((x) => x.day === d.day);
    if (existing) existing.sessions.push(...d.sessions);
    else out.push(d);
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1));
}

export function TimelineView() {
  const [days, setDays] = useState<DaySessions[]>([]);
  // Upper bound (exclusive) of the next window to fetch; undefined = now.
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [emptyWindows, setEmptyWindows] = useState(0);

  const load = async (before: number | undefined) => {
    setLoading(true);
    setError(null);
    try {
      const r = await call('timeline', before == null ? { days: WINDOW_DAYS } : { before, days: WINDOW_DAYS });
      setDays((prev) => mergeDays(prev, r.days));
      const oldest = r.days.reduce<string | null>((m, d) => (m == null || d.day < m ? d.day : m), null);
      const base = before ?? Date.now();
      // Step back at least one window even if it was empty, so "Load older" always makes progress.
      setCursor(Math.min(oldest ? dayStart(oldest) : Infinity, base - WINDOW_DAYS * DAY));
      setEmptyWindows((n) => (r.days.length ? 0 : n + 1));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => void load(undefined), []);

  return h(
    'section',
    { class: 'view view-timeline' },
    h('h1', { class: 'sr-only' }, 'Timeline'),
    h(OnThisDay, null),
    h(ErrorBanner, { error, onRetry: () => void load(cursor) }),
    !loading && !error && !days.length && emptyWindows > 0 ? h('p', { class: 'empty' }, 'No visits in this range yet.') : null,
    days.map((d) => h(Day, { key: d.day, d })),
    h(
      'div',
      { class: 'load-older', 'aria-live': 'polite' },
      emptyWindows > 0 && days.length ? h('p', { class: 'muted' }, `No visits in the previous ${emptyWindows * WINDOW_DAYS} days.`) : null,
      h('button', { type: 'button', class: 'btn btn-block', disabled: loading, onClick: () => void load(cursor) }, loading ? 'Loading…' : 'Load older'),
    ),
  );
}

function Day({ d }: { d: DaySessions }) {
  const visits = d.sessions.reduce((n, s) => n + s.visits.length, 0);
  const id = `day-${d.day}`;
  return h(
    'section',
    { class: 'day', 'aria-labelledby': id },
    h('h2', { id, class: 'day-title' }, dayLabel(d.day), h('span', { class: 'muted' }, ` · ${visits} visit${visits === 1 ? '' : 's'}`)),
    d.sessions.map((s, i) => {
      const dwell = s.visits.reduce((n, v) => n + v.dwell_ms, 0);
      return h(
        'div',
        { class: 'session', key: `${s.start}-${i}` },
        h(
          'div',
          { class: 'session-head' },
          h('span', null, `${formatClock(s.start)}–${formatClock(s.end)}`),
          h('span', { class: 'muted' }, `${s.visits.length} page${s.visits.length === 1 ? '' : 's'}${dwell > 0 ? ` · ${formatDuration(dwell)}` : ''}`),
        ),
        h(
          'ul',
          { class: 'visits' },
          s.visits.map((v) =>
            h(
              'li',
              { class: 'visit', key: v.id },
              h('time', { class: 'visit-time', dateTime: new Date(v.ts).toISOString() }, formatClock(v.ts)),
              h(Favicon, { url: v.url }),
              h('a', { class: 'visit-title', href: v.url, title: v.url }, v.title || v.url),
              h('span', { class: 'domain' }, v.domain || displayDomain(v.url)),
              v.dwell_ms > 0 ? h('span', { class: 'muted dwell' }, formatDuration(v.dwell_ms)) : null,
              h('a', { class: 'details', href: routeHash({ view: 'page', id: v.page_id }), 'aria-label': `Details for ${v.title || v.url}` }, '›'),
            ),
          ),
        ),
      );
    }),
  );
}

function OnThisDay() {
  const [years, setYears] = useState<{ year: number; q: string; hits: SearchHit[]; total: number }[] | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(
      onThisDayQueries().map(async ({ year, q }) => {
        try {
          const r = await call('search', { q, limit: 4 });
          return { year, q, hits: r.hits, total: r.total };
        } catch {
          return { year, q, hits: [], total: 0 };
        }
      }),
    ).then((all) => alive && setYears(all.filter((y) => y.hits.length)));
    return () => {
      alive = false;
    };
  }, []);

  if (years == null) return h('div', { class: 'otd otd-loading' }, h(Spinner, { label: 'Loading On this day' }));
  if (!years.length) return null;
  return h(
    'aside',
    { class: 'otd', 'aria-label': 'On this day' },
    h('h2', { class: 'otd-title' }, 'On this day'),
    h(
      'div',
      { class: 'otd-years' },
      years.map((y) =>
        h(
          'div',
          { class: 'otd-year', key: y.year },
          h('a', { class: 'otd-year-label', href: routeHash({ view: 'search', q: y.q }) }, `${y.year}`, h('span', { class: 'muted' }, ` · ${y.total}`)),
          h(
            'ul',
            null,
            y.hits.map((hit) => h('li', { key: hit.id }, h(Favicon, { url: hit.url }), h('a', { href: hit.url, title: hit.url }, hit.title || hit.url))),
          ),
        ),
      ),
    ),
  );
}
