// Home, "time-first": one big search with time chips, then your days on a vertical time rail
// and a glance column on the right. With a query: the best match as a card, then the rest
// grouped by the day you last saw them.
import { h, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { DaySessions, SearchHit } from '../shared/protocol';
import { call, openUrl, useStore } from './api';
import { ErrorBanner, Favicon, Spinner } from './common';
import { percent } from './coverage';
import { dayKey, dayLabel, displayDomain, formatClock, formatDate, formatDuration, relativeTime, routeHash } from './format';
import { deltaPct, sessionActiveMs, summarize, uniquePages, useIndexStatus, useOnThisDay, useSearch, useStats, useTimeline, type SearchState, type TimeRange, type WeekSummary } from './home-data';
import { DomainBars, LoadMore, MatchMark, ModeToggle, SortToggle, NoResults, SearchErrors, SearchField, Skeleton, hitProps, hoursLabel, usefulSnippet, visitsLabel } from './home-parts';
import { useMeaning } from './meaning';
import { rememberSearch } from './nav';

const DAY = 86_400_000;

export function HomeView({ q: routeQ, nav }: { q: string; nav: number }) {
  const s = useSearch(routeQ, {
    onCommit: (input) => {
      const hash = routeHash({ view: 'search', q: input.trim() ? input : '' });
      if (location.hash !== hash) history.replaceState(null, '', hash || '#/search');
      rememberSearch(hash);
    },
  });

  // Back/forward or a link (e.g. a site: bar) changed the hash: adopt it.
  useEffect(() => {
    if (routeQ !== s.input) s.setInput(routeQ);
  }, [routeQ, nav]);

  // Best match: the card, then the rest in relevance order as one group, each row dated.
  // (Grouping them by day put a weak match from yesterday above a strong one from last week.)
  // Newest first: no card, every match grouped by the day it was last visited.
  const recent = s.sort === 'recent';
  const best = s.res && !recent ? s.res.hits[0] : undefined;
  const rest = s.res ? s.res.hits.slice(best ? 1 : 0) : [];
  const groups = s.res ? (!recent ? (rest.length ? [{ key: 'more', label: 'More matches', hits: rest }] : []) : groupByDay(rest)) : [];
  const ordered = s.res ? [...(best ? [best] : []), ...groups.flatMap((g) => g.hits)] : [];
  return h(
    'div',
    { class: 'vb', onKeyDown: (e: KeyboardEvent) => s.onKeyDown(e, ordered) },
    h(
      'div',
      { class: 'vb-hero' },
      h(SearchField, { s, size: 'lg', placeholder: 'What were you looking at?' }),
      h(TimeChips, { s }),
      s.q ? null : h(ReadyHint, null),
    ),
    s.q
      ? h(
          'div',
          { class: 'vb-results' },
          h(ResultBar, { s }),
          h(SearchErrors, { s }),
          h(NoResults, { s }),
          h(
            'div',
            { id: 'results', role: 'listbox', 'aria-label': 'Results' },
            best ? h(BestMatch, { s, hit: best }) : null,
            groups.map((g) =>
              h(
                'section',
                { class: 'vb-day', key: g.key },
                h('h2', { class: 'vb-day-title' }, g.label, h('span', { class: 'muted' }, `${g.hits.length}${s.res && g.key === 'more' && s.res.total > s.res.hits.length ? ` of ${(s.res.total - 1).toLocaleString()}` : ''} result${g.hits.length === 1 ? '' : 's'}`)),
                h('ol', { class: 'tl' }, g.hits.map((hit) => h(TimeHit, { s, hit, key: hit.id, dated: !recent }))),
              ),
            ),
          ),
          h(LoadMore, { s }),
        )
      : h(TimeHome, null),
  );
}

// ---- Search chrome ----

const CHIPS: { id: TimeRange['id']; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Pick dates' },
];

function TimeChips({ s }: { s: SearchState }) {
  const r = s.range;
  const today = dayKey(Date.now());
  return h(
    'div',
    { class: 'time-chips' },
    h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'When' },
      CHIPS.map((c) =>
        h(
          'button',
          {
            type: 'button',
            key: c.id,
            class: 'chip',
            'aria-pressed': r.id === c.id,
            onClick: () => s.setRange(c.id === 'custom' ? { id: 'custom', from: r.id === 'custom' ? r.from : dayKey(Date.now() - 7 * DAY), to: r.id === 'custom' ? r.to : today } : ({ id: c.id } as TimeRange)),
          },
          c.label,
        ),
      ),
    ),
    r.id === 'custom'
      ? h(
          'div',
          { class: 'date-range' },
          h('label', null, h('span', { class: 'sr-only' }, 'From'), h('input', { type: 'date', value: r.from, max: r.to || today, onChange: (e: Event) => s.setRange({ ...r, from: (e.currentTarget as HTMLInputElement).value }) })),
          h('span', { class: 'muted', 'aria-hidden': 'true' }, 'to'),
          h('label', null, h('span', { class: 'sr-only' }, 'To'), h('input', { type: 'date', value: r.to, min: r.from, max: today, onChange: (e: Event) => s.setRange({ ...r, to: (e.currentTarget as HTMLInputElement).value }) })),
        )
      : null,
  );
}

/** Under the empty search: keyboard hints, or what search by meaning is doing right now. */
function ReadyHint() {
  const m = useMeaning();
  if (m.phase === 'downloading' || m.phase === 'reading') {
    const label =
      m.phase === 'downloading'
        ? `Getting search by meaning ready: downloading${m.model?.total ? ` ${percent(m.model.loaded, m.model.total)}%` : ''}`
        : `Getting search by meaning ready: read ${m.idx ? percent(m.idx.pagesEmbedded, m.idx.pages) : 0}% of your pages`;
    return h('p', { class: 'vb-hint vb-ready', role: 'status' }, h('span', { class: 'dot dot-busy', 'aria-hidden': 'true' }), label, '. Word search works now.');
  }
  if (m.phase === 'not-downloaded') {
    return h('p', { class: 'vb-hint' }, 'Searching by words. ', h('a', { href: routeHash({ view: 'welcome', step: 3 }) }, 'Turn on search by meaning'), ' to also find pages by what they are about.');
  }
  return h('p', { class: 'vb-hint' }, 'Words, a topic, or a time like "last week". ', h('kbd', null, '↑'), h('kbd', null, '↓'), ' to move, ', h('kbd', null, '↵'), ' to open.');
}

function ResultBar({ s }: { s: SearchState }) {
  const r = s.res;
  const text = r ? `${r.total.toLocaleString()} result${r.total === 1 ? '' : 's'} in ${r.tookMs} ms` : s.loading ? 'Searching…' : '';
  return h(
    'div',
    { class: 'result-bar' },
    h('div', { class: 'result-count', 'aria-live': 'polite' }, text),
    r?.dateLabel
      ? h(
          'span',
          { class: 'date-chip' },
          h('span', null, r.dateLabel),
          h(
            'button',
            {
              type: 'button',
              'aria-label': `Remove date ${r.dateLabel}`,
              title: 'Search any time',
              onClick: () => s.setInput([r.parsed.text, ...r.parsed.site.map((d) => `site:${d}`)].filter(Boolean).join(' ')),
            },
            '×',
          ),
        )
      : null,
    h('span', { class: 'result-spacer' }),
    h(SortToggle, { s }),
    h(ModeToggle, { s }),
  );
}

// ---- Results ----

interface HitGroup {
  key: string;
  label: string;
  hits: SearchHit[];
}

/** Hits by the day they were last visited (newest day first). */
function groupByDay(hits: SearchHit[]): HitGroup[] {
  const byDay = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const k = dayKey(hit.last_seen);
    byDay.set(k, [...(byDay.get(k) ?? []), hit]);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([k, hs]) => ({ key: k, label: dayLabel(k), hits: hs.sort((a, b) => b.last_seen - a.last_seen) }));
}

function BestMatch({ s, hit }: { s: SearchState; hit: SearchHit }) {
  const [showRelated, setShowRelated] = useState(false);
  useEffect(() => setShowRelated(false), [hit.id]);
  const domain = hit.domain || displayDomain(hit.url);
  const snippet = usefulSnippet(hit);
  return h(
    'section',
    { class: 'best', 'aria-label': 'Best match' },
    h(
      'div',
      { ...hitProps(s, hit, 'best-card'), role: 'option' },
      h('div', { class: 'best-label' }, 'Best match', h(MatchMark, { match: hit.match })),
      h('a', { class: 'best-title', href: hit.url, tabIndex: -1 }, h(Favicon, { url: hit.url }), h('span', null, hit.title || hit.url)),
      h(
        'div',
        { class: 'hit-meta' },
        h('span', { class: 'domain' }, domain),
        h('span', null, `${relativeTime(hit.last_seen)}, ${formatClock(hit.last_seen)}`),
        h('span', null, visitsLabel(hit.visit_count)),
        hit.total_dwell_ms > 0 ? h('span', null, `${formatDuration(hit.total_dwell_ms)} on page`) : null,
      ),
      snippet ? h('p', { class: 'snippet best-snippet', dangerouslySetInnerHTML: { __html: snippet } }) : null,
      h(
        'div',
        { class: 'best-actions' },
        h('button', { type: 'button', class: 'btn btn-primary btn-small', onClick: (e: MouseEvent) => void openUrl(hit.url, e.metaKey || e.ctrlKey) }, 'Open'),
        h('button', { type: 'button', class: 'btn btn-small', 'aria-expanded': showRelated, onClick: () => setShowRelated((v) => !v) }, showRelated ? 'Hide related pages' : 'Related pages'),
        h('a', { class: 'btn btn-small btn-quiet', href: routeHash({ view: 'page', id: hit.id }) }, 'Details'),
      ),
    ),
    showRelated ? h(RelatedList, { pageId: hit.id, limit: 6 }) : null,
  );
}

/** Pages close in meaning to one page (the `related` op). */
export function RelatedList({ pageId, limit = 8 }: { pageId: number; limit?: number }) {
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    setError(null);
    setHits(null);
    call('related', { pageId, limit }).then((r) => setHits(r.hits), setError);
  };
  useEffect(load, [pageId, limit]);
  if (error) return h(ErrorBanner, { error, onRetry: load });
  if (!hits) return h('div', { class: 'related' }, h(Spinner, { label: 'Finding related pages' }));
  if (!hits.length)
    return h('p', { class: 'related related-empty muted' }, 'No related pages yet. Pages become comparable once search by meaning has read them.');
  return h(
    'ul',
    { class: 'related', 'aria-label': 'Related pages' },
    hits.map((r) =>
      h(
        'li',
        { key: r.id },
        h(Favicon, { url: r.url }),
        h('a', { href: r.url, title: r.url, class: 'related-title' }, r.title || r.url),
        h('span', { class: 'row-domain' }, r.domain || displayDomain(r.url)),
        h('span', { class: 'muted small' }, relativeTime(r.last_seen)),
        h('a', { class: 'details', href: routeHash({ view: 'page', id: r.id }), 'aria-label': `Details for ${r.title || r.url}` }, 'Details'),
      ),
    ),
  );
}

function TimeHit({ s, hit, dated = false }: { s: SearchState; hit: SearchHit; dated?: boolean }) {
  const domain = hit.domain || displayDomain(hit.url);
  return h(
    'li',
    hitProps(s, hit, 'tl-item tl-hit'),
    h('time', { class: 'tl-time', dateTime: new Date(hit.last_seen).toISOString(), title: dated ? 'Last visit' : undefined }, dated ? formatDate(hit.last_seen) : formatClock(hit.last_seen)),
    h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'tl-body' },
      h('div', { class: 'hit-line' }, h(Favicon, { url: hit.url }), h('a', { class: 'hit-title', href: hit.url, tabIndex: -1 }, hit.title || hit.url), h(MatchMark, { match: hit.match })),
      h(
        'div',
        { class: 'hit-meta' },
        h('span', { class: 'domain' }, domain),
        h('span', null, visitsLabel(hit.visit_count)),
        hit.total_dwell_ms > 0 ? h('span', null, formatDuration(hit.total_dwell_ms)) : null,
        h('a', { class: 'details', href: routeHash({ view: 'page', id: hit.id }) }, 'Details'),
      ),
      usefulSnippet(hit) ? h('p', { class: 'snippet', dangerouslySetInnerHTML: { __html: usefulSnippet(hit) } }) : null,
    ),
  );
}

// ---- Home (no query) ----

function TimeHome() {
  const fortnight = useTimeline(14);
  const stats = useStats();
  const now = Date.now();
  const cut = dayKey(now - 6 * DAY);
  const thisWeek = fortnight.data?.filter((d) => d.day >= cut) ?? null;
  const lastWeek = fortnight.data?.filter((d) => d.day < cut) ?? null;
  const sum = thisWeek ? summarize(thisWeek) : null;
  const prev = lastWeek ? summarize(lastWeek, 7, now - 7 * DAY) : null;

  if (stats.data && stats.data.visits === 0 && fortnight.data && !fortnight.data.length) return h(EmptyHome, null);

  return h(
    'div',
    { class: 'vb-grid' },
    h(
      'div',
      { class: 'vb-days' },
      h(ErrorBanner, { error: fortnight.error, onRetry: fortnight.reload }),
      thisWeek ? (thisWeek.length ? thisWeek.slice(0, 4).map((d) => h(DayRail, { d, key: d.day })) : h('p', { class: 'empty-note' }, 'No visits in the last 7 days.')) : h(Skeleton, { rows: 8 }),
      thisWeek?.length ? h('a', { class: 'btn btn-quiet btn-block', href: '#/timeline' }, 'Open the full timeline') : null,
    ),
    h('aside', { class: 'vb-aside', 'aria-label': 'This week' }, h(Glance, { sum, prev }), h(TopSites, { sum }), h(OnThisDayMini, null)),
  );
}

function EmptyHome() {
  return h(
    'div',
    { class: 'empty-home' },
    h('h2', null, 'Nothing here yet'),
    h('p', { class: 'muted' }, 'Pages you visit from now on show up here. Bring in what this browser and others already remember to start with a full history.'),
    h('div', { class: 'inline' }, h('a', { class: 'btn btn-primary', href: routeHash({ view: 'welcome', step: 2 }) }, 'Add your history'), h('a', { class: 'btn', href: '#/settings' }, 'Settings')),
  );
}

function DayRail({ d }: { d: DaySessions }) {
  const visits = d.sessions.reduce((n, x) => n + x.visits.length, 0);
  const active = d.sessions.reduce((n, x) => n + sessionActiveMs(x), 0);
  const label = dayLabel(d.day);
  return h(
    'section',
    { class: 'vb-day', 'aria-label': label },
    h('h2', { class: 'vb-day-title' }, label.replace(/, \w+ \d+$/, ''), h('span', { class: 'muted' }, `${visits.toLocaleString()} visits, ${hoursLabel(active)}`)),
    h(
      'ol',
      { class: 'tl' },
      d.sessions.slice(0, 5).map((sess) => {
        const pages = uniquePages(sess.visits);
        return h(
          'li',
          { class: 'tl-item tl-session', key: sess.start },
          h('time', { class: 'tl-time', dateTime: new Date(sess.start).toISOString() }, formatClock(sess.start)),
          h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
          h(
            'div',
            { class: 'tl-body' },
            h('div', { class: 'tl-head' }, `${formatClock(sess.start)}–${formatClock(sess.end)}`, h('span', { class: 'muted' }, `${pages.length} page${pages.length === 1 ? '' : 's'}, ${formatDuration(sessionActiveMs(sess))}`)),
            h(
              'ul',
              { class: 'tl-pages' },
              pages.slice(0, 4).map((v) => h('li', { key: v.page_id }, h(Favicon, { url: v.url }), h('a', { href: v.url, title: v.url }, v.title || v.url), h('span', { class: 'row-domain' }, v.domain || displayDomain(v.url)))),
            ),
            pages.length > 4 ? h('a', { class: 'more-link', href: '#/timeline' }, `${pages.length - 4} more`) : null,
          ),
        );
      }),
    ),
    d.sessions.length > 5 ? h('a', { class: 'more-link tl-more', href: '#/timeline' }, `${d.sessions.length - 5} earlier sessions`) : null,
  );
}

function Delta({ cur, prev, unit }: { cur: number; prev: number; unit: string }) {
  const d = deltaPct(cur, prev);
  if (d == null) return null;
  const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const text = d === 0 ? 'same as last week' : `${Math.abs(d)}% vs last week`;
  return h('span', { class: `delta delta-${dir}`, title: `Last week: ${unit}`, 'aria-label': d === 0 ? 'Same as last week' : `${Math.abs(d)}% ${d > 0 ? 'more' : 'less'} than last week (${unit})` }, h('span', { 'aria-hidden': 'true' }, d > 0 ? '▲ ' : d < 0 ? '▼ ' : ''), text);
}

function Glance({ sum, prev }: { sum: WeekSummary | null; prev: WeekSummary | null }) {
  const stats = useStats();
  const idx = useIndexStatus();
  const backup = useStore('backup');
  const max = Math.max(1, ...(sum?.byDay.map((d) => d.visits) ?? []));
  const since = stats.data?.oldestVisit ? `since ${formatDate(stats.data.oldestVisit)}` : '';
  return h(
    'div',
    { class: 'aside-block glance-block' },
    h('h2', null, 'This week at a glance'),
    h(
      'dl',
      { class: 'glance' },
      cell('Visits', sum ? sum.visits.toLocaleString() : '—', sum && prev ? h(Delta, { cur: sum.visits, prev: prev.visits, unit: prev.visits.toLocaleString() }) : null),
      cell('Time on the web', sum ? hoursLabel(sum.activeMs) : '—', sum && prev ? h(Delta, { cur: sum.activeMs, prev: prev.activeMs, unit: hoursLabel(prev.activeMs) }) : null),
      cell('Pages kept', stats.data ? stats.data.pages.toLocaleString() : '—', since ? h('span', { class: 'glance-sub' }, since) : null),
      cell('Searchable by meaning', idx ? `${percent(idx.pagesEmbedded, idx.pages)}%` : '—', idx ? h('span', { class: 'glance-sub' }, `${idx.pagesEmbedded.toLocaleString()} of ${idx.pages.toLocaleString()}`) : null),
    ),
    sum
      ? h(
          'div',
          { class: 'spark', role: 'img', 'aria-label': `Visits per day: ${sum.byDay.map((d) => `${dayLabel(d.day)} ${d.visits}`).join(', ')}` },
          sum.byDay.map((d) =>
            h(
              'div',
              { class: 'spark-col', key: d.day, title: `${dayLabel(d.day)}: ${d.visits} visits, ${hoursLabel(d.activeMs)}` },
              h('span', { class: 'spark-n' }, d.visits ? d.visits.toLocaleString() : ''),
              h('span', { class: 'spark-bar', style: { height: `${Math.max(3, (d.visits / max) * 100)}%` } }),
              h('span', { class: 'spark-label' }, new Date(`${d.day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'narrow' })),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'glance-foot' },
      h('span', { class: `dot ${backup?.error ? 'dot-error' : backup?.lastAt ? 'dot-ok' : ''}`, 'aria-hidden': 'true' }),
      backup === undefined
        ? ' '
        : backup?.running
          ? 'Backing up now…'
          : backup?.error
            ? h('a', { href: '#/settings', class: 'error-text' }, 'Last backup failed')
            : backup?.lastAt
              ? `Backed up ${relativeTime(backup.lastAt)}`
              : h('a', { href: '#/settings' }, 'No backup yet'),
      h('a', { class: 'glance-more', href: '#/insights' }, 'More insights'),
    ),
  );
}

function cell(label: string, value: string, sub?: ComponentChildren) {
  return h('div', { class: 'glance-cell' }, h('dt', null, label), h('dd', null, value), sub ? h('dd', { class: 'glance-note' }, sub) : null);
}

function TopSites({ sum }: { sum: WeekSummary | null }) {
  return h('div', { class: 'aside-block' }, h('h2', null, 'Top sites this week'), sum ? h(DomainBars, { items: sum.topSites, max: 6 }) : h(Skeleton, { rows: 4 }));
}

function OnThisDayMini() {
  const otd = useOnThisDay(3);
  if (!otd.data?.length) return null;
  return h(
    'div',
    { class: 'aside-block' },
    h('h2', null, 'On this day'),
    otd.data.slice(0, 2).map((y) =>
      h(
        'div',
        { class: 'otd-mini', key: y.year },
        h('a', { class: 'otd-mini-year', href: routeHash({ view: 'search', q: y.q }) }, `${y.year}`, h('span', { class: 'muted' }, `${y.total} pages`)),
        h('ul', null, y.hits.map((hit) => h('li', { key: hit.id }, h(Favicon, { url: hit.url }), h('a', { href: hit.url, title: hit.url }, hit.title || hit.url)))),
      ),
    ),
  );
}
