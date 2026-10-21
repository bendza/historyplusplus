import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { PageRow } from '../shared/protocol';
import { call, getSettings, openUrl, saveSettings } from './api';
import { ConfirmButton, ErrorBanner, Favicon, Spinner } from './common';
import { displayDomain, formatDuration, relativeTime } from './format';
import { RelatedList } from './home';
import { lastSearchHash } from './nav';

type Page = PageRow & { text: string | null };

function fullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function PageView({ id }: { id: number }) {
  const [page, setPage] = useState<Page | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    setPage(undefined);
    try {
      setPage(await call('getPage', { id }));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    setDone(null);
    void load();
  }, [id]);

  if (done) {
    return h('section', { class: 'view' }, h('div', { class: 'banner banner-ok', role: 'status' }, done), h('a', { href: lastSearchHash() }, '← Back to search'));
  }
  if (error) return h('section', { class: 'view' }, h(ErrorBanner, { error, onRetry: load }));
  if (page === undefined) return h('section', { class: 'view' }, h(Spinner, null));
  if (page === null) return h('section', { class: 'view' }, h('p', { class: 'empty' }, 'This page is not in your history (it may have been deleted).'), h('a', { href: lastSearchHash() }, '← Back to search'));

  const forgetDomain = async () => {
    const r = await call('deleteDomain', { domain: page.domain });
    const s = await getSettings();
    if (!s.denylist.includes(page.domain)) await saveSettings({ ...s, denylist: [...s.denylist, page.domain] });
    setDone(`Deleted ${r.deleted.toLocaleString()} page${r.deleted === 1 ? '' : 's'} from ${page.domain}; it is now on your denylist and won't be recorded.`);
  };

  const words = page.text ? page.text.trim().split(/\s+/).length : 0;

  return h(
    'article',
    { class: 'view view-page' },
    h('a', { class: 'back', href: lastSearchHash() }, '← Back to search'),
    h('h1', { class: 'page-title' }, h(Favicon, { url: page.url }), h('span', null, page.title || page.url)),
    h('a', { class: 'page-url break', href: page.url }, page.url),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onClick: (e: MouseEvent) => void openUrl(page.url, e.metaKey || e.ctrlKey) }, 'Open'),
      h('button', { type: 'button', class: 'btn', onClick: () => void openUrl(page.url, true) }, 'Open in new tab'),
      h(ConfirmButton, {
        label: 'Delete page',
        danger: true,
        confirmLabel: 'Delete page and its visits',
        prompt: 'Remove this page, all its visits and its saved text from history++? This cannot be undone.',
        onConfirm: async () => {
          await call('deletePage', { id: page.id });
          setDone('Page deleted.');
        },
      }),
      h(ConfirmButton, {
        label: `Forget ${page.domain || displayDomain(page.url)}`,
        danger: true,
        confirmLabel: `Forget ${page.domain}`,
        prompt: h('span', null, 'Delete every page from ', h('strong', null, page.domain), ' (including subdomains) and never record it again? This cannot be undone.'),
        onConfirm: forgetDomain,
      }),
    ),
    h(
      'dl',
      { class: 'stat-strip page-strip' },
      cell('Visits', page.visit_count.toLocaleString(), ''),
      cell('Time on page', formatDuration(page.total_dwell_ms), page.visit_count > 1 && page.total_dwell_ms ? `${formatDuration(page.total_dwell_ms / page.visit_count)} a visit` : ''),
      cell('First seen', relativeTime(page.first_seen), fullDate(page.first_seen)),
      cell('Last seen', relativeTime(page.last_seen), fullDate(page.last_seen)),
    ),
    h(
      'div',
      { class: 'page-grid' },
      h(
        'section',
        { class: 'page-main', 'aria-labelledby': 'saved-text' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'saved-text' }, 'Saved text'), page.text ? h('span', { class: 'muted small' }, `${words.toLocaleString()} words${page.lang ? `, ${page.lang}` : ''}`) : null),
        page.text
          ? h('pre', { class: 'page-text', tabIndex: 0, 'aria-label': 'Saved page text' }, page.text)
          : h('p', { class: 'muted' }, 'No text saved for this page. It was imported from browser history, you left it quickly, or saving page text is off.'),
      ),
      h(
        'aside',
        { class: 'page-side', 'aria-labelledby': 'related-h' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'related-h' }, 'Related pages'), h('span', { class: 'muted small' }, 'by meaning')),
        h(RelatedList, { pageId: page.id, limit: 8 }),
      ),
    ),
  );
}

function cell(label: string, value: string, sub: string) {
  return h('div', { class: 'stat-cell' }, h('dt', null, label), h('dd', null, value), sub ? h('dd', { class: 'stat-note' }, sub) : null);
}
