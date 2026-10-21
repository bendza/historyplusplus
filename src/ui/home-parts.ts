// Building blocks shared by the home screen, results and insights.
import { h, type ComponentChildren } from 'preact';
import type { SearchHit } from '../shared/protocol';
import { useStore } from './api';
import { ErrorBanner, Favicon, Spinner } from './common';
import { displayDomain, formatDuration, relativeTime, routeHash } from './format';
import { pointerMoved, type SearchState } from './home-data';

export function SearchField({ s, size = 'md', placeholder = 'Search everything you have visited' }: { s: SearchState; size?: 'md' | 'lg'; placeholder?: string }) {
  return h(
    'form',
    { class: `search-field search-${size}`, role: 'search', onSubmit: (e: Event) => e.preventDefault() },
    h(
      'svg',
      { class: 'search-icon', viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': 'true' },
      h('circle', { cx: 8.5, cy: 8.5, r: 5.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }),
      h('path', { d: 'M13 13l4 4', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
    ),
    h('label', { for: 'q', class: 'sr-only' }, 'Search your history'),
    h('input', {
      id: 'q',
      ref: s.inputRef,
      type: 'search',
      autoFocus: true,
      autoComplete: 'off',
      spellcheck: false,
      placeholder,
      value: s.input,
      'aria-controls': 'results',
      onInput: (e: Event) => s.setInput((e.currentTarget as HTMLInputElement).value),
    }),
    s.loading ? h(Spinner, { label: 'Searching' }) : s.input ? null : h('kbd', { class: 'search-kbd', title: 'Press / to search from anywhere' }, '/'),
  );
}

export function ModeToggle({ s }: { s: SearchState }) {
  const model = useStore('model');
  // Meaning search needs the downloaded model (older backends don't report it: assume ready).
  if (!s.semantic || (model && model.status !== 'ready')) return null;
  return h(
    'span',
    { class: 'mode-switch', role: 'group', 'aria-label': 'Match' },
    (
      [
        ['keyword', 'Exact words', 'Only pages containing your words'],
        ['hybrid', 'Meaning + words', 'Also pages about what you typed, found on this device by meaning'],
      ] as const
    ).map(([m, label, hint]) => h('button', { type: 'button', key: m, title: hint, 'aria-pressed': s.mode === m, onClick: () => s.setMode(m) }, label)),
  );
}

export function SortToggle({ s }: { s: SearchState }) {
  return h(
    'span',
    { class: 'mode-switch', role: 'group', 'aria-label': 'Order' },
    (
      [
        ['relevance', 'Best match', 'Most relevant first'],
        ['recent', 'Newest first', 'The same matches, most recently visited first'],
      ] as const
    ).map(([v, label, hint]) => h('button', { type: 'button', key: v, title: hint, 'aria-pressed': s.sort === v, onClick: () => s.setSort(v) }, label)),
  );
}

export function MatchMark({ match }: { match: SearchHit['match'] }) {
  if (match === 'meaning') return h('span', { class: 'match-pill', title: 'Found by meaning, not exact words' }, 'related');
  if (match === 'both') return h('span', { class: 'match-both', title: 'Matches your words and their meaning', role: 'img', 'aria-label': 'Matches words and meaning' });
  return null;
}

export function NoResults({ s }: { s: SearchState }) {
  if (!s.res || s.res.hits.length || s.error) return null;
  return h(
    'div',
    { class: 'empty' },
    h('p', null, 'No matches for ', h('strong', null, s.res.q)),
    h(
      'ul',
      null,
      h('li', null, 'Try fewer or different words, or switch to Meaning + words.'),
      h('li', null, 'Drop a site:, before: or after: filter to widen the range.'),
      h('li', null, 'Imported history only has titles and URLs, not page text.'),
    ),
  );
}

export function SearchErrors({ s }: { s: SearchState }) {
  return h(ErrorBanner, { error: s.error, onRetry: s.retry });
}

export function LoadMore({ s }: { s: SearchState }) {
  const r = s.res;
  if (!r || r.hits.length >= r.total) return null;
  return h(
    'button',
    { type: 'button', class: 'btn btn-quiet btn-block', onClick: s.loadMore, disabled: s.loadingMore },
    s.loadingMore ? 'Loading…' : `Show more (${(r.total - r.hits.length).toLocaleString()} left)`,
  );
}

/** Props for an element representing one hit in a keyboard-navigable list. */
export function hitProps(s: SearchState, hit: SearchHit, cls: string) {
  const selected = s.sel === hit.id;
  return {
    key: hit.id,
    id: `hit-${hit.id}`,
    'data-hit': hit.id,
    role: 'option',
    'aria-selected': selected,
    class: `${cls}${selected ? ' selected' : ''}`,
    onMouseMove: selected ? undefined : (e: MouseEvent) => pointerMoved(e) && s.setSel(hit.id),
  };
}

/** One result as a list row: favicon, title, meta line, snippet. */
export function HitRow({ s, hit, showSnippet = true }: { s: SearchState; hit: SearchHit; showSnippet?: boolean }) {
  const domain = hit.domain || displayDomain(hit.url);
  return h(
    'li',
    hitProps(s, hit, 'hit'),
    h(Favicon, { url: hit.url }),
    h(
      'div',
      { class: 'hit-body' },
      h('div', { class: 'hit-line' }, h('a', { class: 'hit-title', href: hit.url, tabIndex: -1 }, hit.title || hit.url), h(MatchMark, { match: hit.match })),
      h(
        'div',
        { class: 'hit-meta' },
        h('span', { class: 'domain' }, domain),
        h('span', null, relativeTime(hit.last_seen)),
        h('span', null, `${hit.visit_count} visit${hit.visit_count === 1 ? '' : 's'}`),
        hit.total_dwell_ms > 0 ? h('span', null, formatDuration(hit.total_dwell_ms)) : null,
        h('a', { class: 'details', href: routeHash({ view: 'page', id: hit.id }), 'aria-label': `Details for ${hit.title || domain}` }, 'Details'),
      ),
      showSnippet && usefulSnippet(hit) ? h('p', { class: 'snippet', dangerouslySetInnerHTML: { __html: usefulSnippet(hit) } }) : null,
    ),
  );
}

export function Section({ title, aside, children, id, class: cls }: { title: ComponentChildren; aside?: ComponentChildren; children?: ComponentChildren; id?: string; class?: string }) {
  const hid = id ? `${id}-title` : undefined;
  return h(
    'section',
    { class: `home-section${cls ? ` ${cls}` : ''}`, 'aria-labelledby': hid },
    h('div', { class: 'section-head' }, h('h2', { id: hid }, title), aside ? h('div', { class: 'section-aside' }, aside) : null),
    children,
  );
}

export function Skeleton({ rows = 4, class: cls = '' }: { rows?: number; class?: string }) {
  return h(
    'div',
    { class: `skel-rows ${cls}`, 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: rows }, (_, i) => h('div', { class: 'skel-row', key: i }, h('span', { class: 'skel skel-icon' }), h('span', { class: 'skel skel-line', style: { width: `${55 + ((i * 17) % 35)}%` } }))),
  );
}

export interface StatItem {
  label: string;
  value: string;
  sub?: string;
}

export function StatStrip({ items, class: cls = '' }: { items: StatItem[]; class?: string }) {
  return h(
    'dl',
    { class: `stat-strip ${cls}` },
    items.map((it) => h('div', { class: 'stat-cell', key: it.label }, h('dt', null, it.label), h('dd', null, it.value, it.sub ? h('span', { class: 'stat-sub' }, it.sub) : null))),
  );
}

export function DomainBars({ items, max: maxN = 8 }: { items: { domain: string; visits: number; note?: string }[]; max?: number }) {
  const list = items.slice(0, maxN);
  const max = Math.max(1, ...list.map((d) => d.visits));
  return h(
    'ol',
    { class: 'domain-bars' },
    list.map((d) =>
      h(
        'li',
        { key: d.domain },
        h('a', { class: 'db-label', href: routeHash({ view: 'search', q: `site:${d.domain} ` }) }, h(Favicon, { url: `https://${d.domain}/` }), h('span', null, d.domain)),
        h('span', { class: 'db-track', 'aria-hidden': 'true' }, h('span', { class: 'db-fill', style: { width: `${Math.max(2, (d.visits / max) * 100)}%` } })),
        h('span', { class: 'db-value' }, d.note ?? d.visits.toLocaleString()),
      ),
    ),
  );
}

/** The engine falls back to the URL as snippet for title-only pages; that adds nothing under the title. */
export function usefulSnippet(hit: SearchHit): string {
  const plain = hit.snippet.replace(/<\/?mark>/g, '').trim();
  if (!plain || /^(https?:\/\/|www\.)\S*$/.test(plain) || plain === hit.title) return '';
  return hit.snippet;
}

/** Compact "visited N times" etc. */
export function visitsLabel(n: number): string {
  return `${n.toLocaleString()} visit${n === 1 ? '' : 's'}`;
}

/** Hours with one decimal under 10 h: "3.4 h", "26 h"; minutes under an hour. */
export function hoursLabel(ms: number): string {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const hrs = ms / 3_600_000;
  return hrs < 10 ? `${hrs.toFixed(1)} h` : `${Math.round(hrs)} h`;
}
