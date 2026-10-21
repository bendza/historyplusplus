// Toolbar popup: one search box, recent pages when empty, live hybrid results while typing.
import { h, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DaySessions } from '../shared/protocol';
import { call, downloadModel, isMock, openApp as openAppRoute, openUrl } from './api';
import { Favicon } from './common';
import { percent } from './coverage';
import { daysBetween, displayDomain, relativeTime, routeHash } from './format';
import { pointerMoved, uniquePages, useSearch } from './home-data';
import { MatchMark } from './home-parts';
import { useMeaning, type MeaningState } from './meaning';
import type { SearchHit } from '../shared/protocol';
import './tokens.css';
import './popup.css';

interface Item {
  id: number;
  url: string;
  title: string;
  domain: string;
  ts: number;
  match?: SearchHit['match'];
}

const RECENT_DAYS = 3;
const RECENT_MAX = 14;

function recentItems(days: DaySessions[]): Item[] {
  const visits = days.flatMap((d) => d.sessions.flatMap((s) => s.visits)).sort((a, b) => b.ts - a.ts);
  return uniquePages(visits.filter((v) => v.title))
    .slice(0, RECENT_MAX)
    .map((v) => ({ id: v.page_id, url: v.url, title: v.title, domain: v.domain, ts: v.ts }));
}

async function openApp(path: string) {
  await openAppRoute(path);
  if (!isMock) window.close();
}

const searchPath = (q: string) => (q.trim() ? routeHash({ view: 'search', q: q.trim() }) : '');

async function openItem(url: string, newTab: boolean) {
  await openUrl(url, newTab);
  if (!newTab && !isMock) window.close();
}

function Popup() {
  const s = useSearch('', { limit: 12, debounceMs: 90 });
  const [recent, setRecent] = useState<DaySessions[] | null>(null);
  const [recentErr, setRecentErr] = useState<unknown>(null);
  const [stats, setStats] = useState<{ pages: number; visits: number } | null>(null);
  const m = useMeaning();
  const idx = m.idx;
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    call('timeline', { days: RECENT_DAYS }).then((r) => setRecent(r.days), setRecentErr);
    call('stats', {}).then((r) => setStats({ pages: r.pages, visits: r.visits }), () => {});
  }, []);

  const searching = !!s.q;
  const items: Item[] = searching
    ? (s.res?.hits ?? []).map((hit) => ({ id: hit.id, url: hit.url, title: hit.title, domain: hit.domain, ts: hit.last_seen, match: hit.match }))
    : recent
      ? recentItems(recent)
      : [];

  useEffect(() => setSel(0), [s.res, recent, searching]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      e.preventDefault();
      if (e.shiftKey) return void openApp(searchPath(s.input));
      const it = items[sel];
      if (it) void openItem(it.url, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape' && s.input) {
      e.preventDefault();
      s.setInput('');
    }
  };

  const pct = idx && m.phase !== 'not-downloaded' ? percent(idx.pagesEmbedded, idx.pages) : null;
  const statLine = stats ? `${stats.pages.toLocaleString()} page${stats.pages === 1 ? '' : 's'} kept${pct != null ? `, ${pct}% by meaning` : ''}` : '';
  const isNew = !!stats && stats.visits === 0 && !!recent && !recent.length;

  let body;
  if (searching) {
    if (s.error) body = h('p', { class: 'pp-note' }, 'Search is unavailable right now. ', h('button', { type: 'button', class: 'pp-link', onClick: s.retry }, 'Try again'));
    else if (!s.res) body = h(SkeletonRows, null);
    else if (!items.length) body = h('p', { class: 'pp-note' }, 'No matches. Try other words or open history++ for filters.');
    else
      body = [
        h(Group, { key: 'best', label: 'Best match', items: items.slice(0, 1), offset: 0, sel, setSel }),
        items.length > 1 ? h(Group, { key: 'more', label: s.res.total > items.length ? `More · top ${items.length} of ${s.res.total.toLocaleString()}` : 'More', items: items.slice(1), offset: 1, sel, setSel }) : null,
      ];
  } else if (recentErr) {
    body = h('p', { class: 'pp-note' }, 'Could not load recent pages. The history engine may still be starting; reopen the popup in a moment.');
  } else if (!recent) {
    body = h(SkeletonRows, null);
  } else if (!items.length) {
    body = isNew
      ? h(
          'div',
          { class: 'pp-empty' },
          h('strong', null, 'Nothing here yet'),
          h('p', null, 'Pages you visit show up here. Bring in what your browsers already remember to search it right away.'),
          h('button', { type: 'button', class: 'pp-open', onClick: () => void openApp(routeHash({ view: 'welcome', step: 2 })) }, 'Add your history'),
        )
      : h('p', { class: 'pp-note' }, 'Nothing in the last few days. Search finds everything older.');
  } else {
    const now = Date.now();
    const groups: [string, Item[]][] = [
      ['Today', items.filter((it) => daysBetween(it.ts, now) === 0)],
      ['Yesterday', items.filter((it) => daysBetween(it.ts, now) === 1)],
      ['Earlier', items.filter((it) => daysBetween(it.ts, now) > 1)],
    ];
    let offset = 0;
    body = groups.map(([label, list]) => {
      const g = list.length ? h(Group, { key: label, label, items: list, offset, sel, setSel }) : null;
      offset += list.length;
      return g;
    });
  }

  return h(
    'div',
    { class: 'pp', onKeyDown },
    h(
      'header',
      { class: 'pp-head' },
      h('span', { class: 'pp-word' }, h('img', { src: '/icon/32.png', alt: '', width: 20, height: 20 }), 'history++'),
      isMock ? h('span', { class: 'pp-mock' }, 'Mock data') : null,
      s.semantic && (m.phase === 'ready' || m.phase === 'reading')
        ? h(
            'button',
            {
              type: 'button',
              class: 'pp-mode',
              'aria-pressed': s.mode === 'hybrid',
              title: s.mode === 'hybrid' ? 'Matching meaning and words. Click for exact words only.' : 'Matching exact words. Click to also match meaning.',
              onClick: () => s.setMode(s.mode === 'hybrid' ? 'keyword' : 'hybrid'),
            },
            s.mode === 'hybrid' ? 'Meaning + words' : 'Exact words',
          )
        : null,
    ),
    h(
      'form',
      { class: 'pp-search', role: 'search', onSubmit: (e: Event) => e.preventDefault() },
      h('svg', { class: 'pp-search-icon', viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true' }, h('circle', { cx: 8.5, cy: 8.5, r: 5.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }), h('path', { d: 'M13 13l4 4', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' })),
      h('label', { for: 'pq', class: 'sr-only' }, 'Search your history'),
      h('input', {
        id: 'pq',
        ref: s.inputRef,
        type: 'search',
        autoFocus: true,
        autoComplete: 'off',
        spellcheck: false,
        placeholder: 'Search your history',
        value: s.input,
        role: 'combobox',
        'aria-expanded': true,
        'aria-controls': 'pp-list',
        'aria-activedescendant': items[sel] ? `pp-${sel}` : undefined,
        onInput: (e: Event) => s.setInput((e.currentTarget as HTMLInputElement).value),
      }),
      s.loading ? h('span', { class: 'spinner pp-spin', role: 'status' }, h('span', { class: 'sr-only' }, 'Searching')) : null,
    ),
    h(ReadyBanner, { m }),
    h('div', { class: 'pp-body', id: 'pp-list', role: 'listbox', 'aria-label': searching ? 'Results' : 'Recent pages', ref: listRef }, body),
    h(
      'footer',
      { class: 'pp-foot' },
      h('span', { class: 'pp-stats' }, statLine),
      h('button', { type: 'button', class: 'pp-open', onClick: () => void openApp(searchPath(s.input)), title: 'Open the full app (Shift+Enter)' }, 'Open history++'),
    ),
  );
}

function Group({ label, items, offset, sel, setSel }: { label: string; items: Item[]; offset: number; sel: number; setSel: (i: number) => void }) {
  return h(
    'div',
    { class: 'pp-group', role: 'group', 'aria-label': label },
    h('div', { class: 'pp-group-label' }, label),
    items.map((it, k) => {
      const i = offset + k;
      return h(
        'a',
        {
          key: it.id,
          id: `pp-${i}`,
          'data-i': i,
          role: 'option',
          'aria-selected': sel === i,
          class: `pp-item${sel === i ? ' selected' : ''}`,
          href: it.url,
          tabIndex: -1,
          onMouseMove: (e: MouseEvent) => pointerMoved(e) && setSel(i),
          onClick: (e: MouseEvent) => {
            e.preventDefault();
            void openItem(it.url, e.metaKey || e.ctrlKey || e.button === 1);
          },
        },
        h('span', { class: 'pp-fav' }, h(Favicon, { url: it.url })),
        h(
          'span',
          { class: 'pp-text' },
          h('span', { class: 'pp-title' }, it.title || it.url),
          h('span', { class: 'pp-meta' }, h('span', { class: 'pp-domain' }, it.domain || displayDomain(it.url)), h('span', null, relativeTime(it.ts)), it.match ? h(MatchMark, { match: it.match }) : null),
        ),
        sel === i ? h('kbd', { class: 'pp-enter', 'aria-hidden': 'true' }, '↵') : null,
      );
    }),
  );
}

/** Search by meaning not ready yet: what is happening, and that word search already works. */
function ReadyBanner({ m }: { m: MeaningState }) {
  const [starting, setStarting] = useState(false);
  if (m.phase === 'not-downloaded') {
    return h(
      'div',
      { class: 'pp-banner' },
      h('span', { class: 'pp-banner-text' }, 'Searching by words. ', h('button', { type: 'button', class: 'pp-link', onClick: () => void openApp(routeHash({ view: 'welcome', step: 3 })) }, 'What is search by meaning?')),
      h('button', { type: 'button', class: 'pp-cta', disabled: starting, onClick: () => (setStarting(true), void downloadModel().finally(() => setStarting(false))) }, starting ? 'Starting…' : 'Turn on'),
    );
  }
  if (m.phase === 'error') {
    return h('div', { class: 'pp-banner pp-banner-error' }, h('span', { class: 'pp-banner-text' }, 'Search by meaning could not download. Word search works.'), h('button', { type: 'button', class: 'pp-cta', onClick: () => void downloadModel() }, 'Retry'));
  }
  if (m.phase !== 'downloading' && m.phase !== 'reading') return null;
  const pct = m.phase === 'downloading' ? (m.model?.total ? percent(m.model.loaded, m.model.total) : 0) : m.idx ? percent(m.idx.chunksEmbedded, m.idx.chunksTotal) : 0;
  const text = m.phase === 'downloading' ? `Getting search by meaning ready · downloading ${pct}%` : `Getting search by meaning ready · reading pages ${pct}%`;
  return h(
    'div',
    { class: 'pp-banner pp-banner-busy', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'pp-banner-text' }, text, h('span', { class: 'pp-banner-sub' }, 'Word search works now.')),
    h('span', { class: 'pp-banner-meter', 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } })),
  );
}

function SkeletonRows() {
  return h(
    'div',
    { class: 'pp-group', 'aria-busy': 'true', 'aria-label': 'Loading' },
    h('div', { class: 'pp-group-label' }, h('span', { class: 'skel', style: { width: '48px', height: '10px' } })),
    Array.from({ length: 7 }, (_, i) =>
      h(
        'div',
        { class: 'pp-item pp-skel', key: i },
        h('span', { class: 'pp-fav skel' }),
        h('span', { class: 'pp-text' }, h('span', { class: 'skel', style: { width: `${60 + ((i * 23) % 30)}%`, height: '12px' } }), h('span', { class: 'skel', style: { width: `${30 + ((i * 13) % 20)}%`, height: '10px' } })),
      ),
    ),
  );
}

export function mount(el: HTMLElement) {
  render(h(Popup, null), el);
}
