// Insights: the last 30 days of browsing, composed from the timeline op (no aggregate op yet).
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { DaySessions, VisitRow } from '../shared/protocol';
import { call } from './api';
import { ErrorBanner, Favicon } from './common';
import { dayKey, dayLabel, dayStart, formatDate, formatDuration, relativeTime, routeHash } from './format';
import { DATA_CHANGED, hourOfWeek, peakSlot, rediscovered, summarize, useStats, type Rediscovered } from './home-data';
import { DomainBars, Skeleton, hoursLabel } from './home-parts';

const DAY = 86_400_000;
const SPAN = 30;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

const flat = (days: DaySessions[]): VisitRow[] => days.flatMap((d) => d.sessions.flatMap((s) => s.visits));

export function InsightsView() {
  const [recent, setRecent] = useState<DaySessions[] | null>(null);
  const [older, setOlder] = useState<VisitRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const stats = useStats();

  useEffect(() => {
    let alive = true;
    setError(null);
    call('timeline', { days: SPAN })
      .then((r) => {
        if (!alive) return;
        setRecent(r.days);
        // The 60 days before that, only to spot sites that came back after a break.
        return call('timeline', { before: dayStart(dayKey(Date.now() - (SPAN - 1) * DAY)), days: 60 }).then((o) => alive && setOlder(flat(o.days)));
      })
      .catch((e) => alive && setError(e));
    const on = () => setNonce((n) => n + 1);
    addEventListener(DATA_CHANGED, on);
    return () => {
      alive = false;
      removeEventListener(DATA_CHANGED, on);
    };
  }, [nonce]);

  const sum = recent ? summarize(recent, SPAN) : null;
  const visits = recent ? flat(recent) : [];
  const grid = recent ? hourOfWeek(visits) : null;
  const back = recent && older ? rediscovered([...visits, ...older]) : null;
  const active = sum ? sum.byDay.filter((d) => d.visits > 0).length : 0;

  return h(
    'section',
    { class: 'view view-insights' },
    h('div', { class: 'insights-head' }, h('h1', null, 'Insights'), h('span', { class: 'muted' }, sum ? `${formatDate(dayStart(sum.byDay[0]!.day))} – today` : 'Last 30 days')),
    h(ErrorBanner, { error, onRetry: () => setNonce((n) => n + 1) }),
    h(
      'dl',
      { class: 'stat-strip insights-strip' },
      stat('Visits, 30 days', sum ? sum.visits.toLocaleString() : '—', sum && active ? `${Math.round(sum.visits / active).toLocaleString()} a day` : ''),
      stat('Time on the web', sum ? hoursLabel(sum.activeMs) : '—', sum && active ? `${hoursLabel(sum.activeMs / active)} a day` : ''),
      stat('Different pages', sum ? sum.pages.toLocaleString() : '—', sum ? `${sum.topSites.length ? new Set(visits.map((v) => v.domain)).size.toLocaleString() : 0} sites` : ''),
      stat('Kept in total', stats.data ? stats.data.pages.toLocaleString() : '—', stats.data?.oldestVisit ? `pages since ${formatDate(stats.data.oldestVisit)}` : 'pages'),
    ),
    h(
      'div',
      { class: 'insights-grid' },
      h(
        'section',
        { class: 'panel span-2', 'aria-labelledby': 'ins-days' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ins-days' }, 'Visits per day'), sum ? h('span', { class: 'muted small' }, `busiest: ${busiestDay(sum.byDay)}`) : null),
        sum ? h(DayBars, { days: sum.byDay, value: (d) => d.visits, fmt: (n) => `${n.toLocaleString()} visits` }) : h(Skeleton, { rows: 4 }),
        h('div', { class: 'panel-head panel-sub' }, h('h3', { id: 'ins-time' }, 'Time on the web per day')),
        sum ? h(DayBars, { days: sum.byDay, value: (d) => d.activeMs, fmt: (n) => hoursLabel(n), small: true, tone: 'deep' }) : null,
      ),
      h(
        'section',
        { class: 'panel span-2', 'aria-labelledby': 'ins-hours' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ins-hours' }, 'When you browse'), grid ? h('span', { class: 'muted small' }, peakText(grid)) : null),
        grid ? h(Heatmap, { grid }) : h(Skeleton, { rows: 5 }),
      ),
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'ins-sites' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ins-sites' }, 'Top sites'), h('span', { class: 'muted small' }, 'visits, 30 days')),
        sum ? h(DomainBars, { items: sum.topSites, max: 8 }) : h(Skeleton, { rows: 6 }),
      ),
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'ins-back' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ins-back' }, 'Sites you came back to'), h('span', { class: 'muted small' }, 'after a month or more away')),
        back ? h(Rediscover, { items: back }) : h(Skeleton, { rows: 4 }),
      ),
      h(
        'section',
        { class: 'panel span-2', 'aria-labelledby': 'ins-pages' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'ins-pages' }, 'Pages you kept coming back to')),
        sum
          ? h(
              'ol',
              { class: 'top-pages' },
              sum.topPages.slice(0, 8).map((p) =>
                h(
                  'li',
                  { key: p.page_id },
                  h(Favicon, { url: p.url }),
                  h('a', { href: p.url, title: p.url, class: 'top-page-title' }, p.title || p.url),
                  h('span', { class: 'row-domain' }, p.domain),
                  h('span', { class: 'top-page-n' }, `${p.visits} visits`),
                  p.dwell_ms ? h('span', { class: 'muted small' }, formatDuration(p.dwell_ms)) : h('span', null),
                  h('a', { class: 'details', href: routeHash({ view: 'page', id: p.page_id }), 'aria-label': `Details for ${p.title || p.url}` }, 'Details'),
                ),
              ),
            )
          : h(Skeleton, { rows: 6 }),
      ),
    ),
  );
}

function stat(label: string, value: string, sub: string) {
  return h('div', { class: 'stat-cell' }, h('dt', null, label), h('dd', null, value), sub ? h('dd', { class: 'stat-note' }, sub) : null);
}

function busiestDay(days: { day: string; visits: number }[]): string {
  const best = days.reduce((a, b) => (b.visits > a.visits ? b : a), days[0]!);
  return `${dayLabel(best.day)}, ${best.visits.toLocaleString()} visits`;
}

function peakText(grid: number[][]): string {
  const p = peakSlot(grid);
  if (!p) return '';
  return `busiest: ${WEEKDAYS_LONG[p[0]]} around ${String(p[1]).padStart(2, '0')}:00`;
}

type DayStat = { day: string; visits: number; activeMs: number };

function DayBars({ days, value, fmt, small = false, tone }: { days: DayStat[]; value: (d: DayStat) => number; fmt: (n: number) => string; small?: boolean; tone?: 'deep' }) {
  const max = Math.max(1, ...days.map(value));
  const today = dayKey(Date.now());
  return h(
    'div',
    { class: `day-bars${small ? ' day-bars-sm' : ''}${tone ? ` day-bars-${tone}` : ''}`, role: 'img', 'aria-label': days.map((d) => `${dayLabel(d.day)}: ${fmt(value(d))}`).join('; ') },
    h('span', { class: 'day-bars-max', 'aria-hidden': 'true' }, fmt(max)),
    days.map((d) => {
      const date = new Date(`${d.day}T12:00:00`);
      const monday = date.getDay() === 1;
      return h(
        'div',
        { class: `db-col${d.day === today ? ' is-today' : ''}${[0, 6].includes(date.getDay()) ? ' is-weekend' : ''}`, key: d.day, title: `${dayLabel(d.day)}: ${fmt(value(d))}` },
        h('span', { class: 'db-bar', style: { height: `${value(d) ? Math.max(2, (value(d) / max) * 100) : 0}%` } }),
        small ? null : h('span', { class: 'db-tick' }, monday || d.day === today ? (d.day === today ? 'Today' : formatDate(date.getTime())) : ''),
      );
    }),
  );
}

function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat());
  return h(
    'div',
    { class: 'heat-wrap' },
    h(
      'table',
      { class: 'heat' },
      h('caption', { class: 'sr-only' }, 'Visits by weekday and hour, last 30 days'),
      h('thead', null, h('tr', null, h('td', null), Array.from({ length: 24 }, (_, hr) => h('th', { scope: 'col', key: hr, class: 'heat-hr' }, hr % 3 === 0 ? String(hr).padStart(2, '0') : h('span', { class: 'sr-only' }, String(hr)))))),
      h(
        'tbody',
        null,
        grid.map((row, d) =>
          h(
            'tr',
            { key: d },
            h('th', { scope: 'row', class: 'heat-day' }, WEEKDAYS[d]),
            row.map((n, hr) =>
              h(
                'td',
                { key: hr, class: 'heat-cell', title: `${WEEKDAYS_LONG[d]} ${String(hr).padStart(2, '0')}:00 · ${n} visits`, style: { '--v': n ? (0.12 + 0.88 * (n / max)).toFixed(2) : '0' } },
                h('span', { class: 'sr-only' }, `${n}`),
              ),
            ),
          ),
        ),
      ),
    ),
    h('div', { class: 'heat-legend', 'aria-hidden': 'true' }, 'fewer', h('span', { class: 'heat-scale' }), 'more'),
  );
}

function Rediscover({ items }: { items: Rediscovered[] }) {
  if (!items.length) return h('p', { class: 'muted' }, 'No returns yet. Sites you come back to after a month or more show up here.');
  return h(
    'ul',
    { class: 'rediscover-list' },
    items.slice(0, 6).map((r) =>
      h(
        'li',
        { key: r.domain },
        h(Favicon, { url: r.url }),
        h('div', { class: 'rd-text' }, h('a', { href: routeHash({ view: 'search', q: `site:${r.domain}` }) }, r.domain), h('span', { class: 'muted small block' }, `Away ${r.gapDays} days, back ${relativeTime(r.back)}`)),
        h('span', { class: 'rd-gap', 'aria-hidden': 'true' }, `${r.gapDays}d`),
      ),
    ),
  );
}
