import { h, render, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { isMock, useStore } from './api';
import { parseRoute, routeHash, type Route } from './format';
import { HomeView } from './home';
import { InsightsView } from './insights';
import { rememberSearch } from './nav';
import { PageView } from './page';
import { SettingsView } from './settings';
import { TimelineView } from './timeline';
import { WelcomeView } from './welcome';
import './tokens.css';
import './styles.css';

const NAV: { view: Route['view']; label: string; href: string }[] = [
  { view: 'search', label: 'Search', href: '#/search' },
  { view: 'timeline', label: 'Timeline', href: '#/timeline' },
  { view: 'insights', label: 'Insights', href: '#/insights' },
  { view: 'settings', label: 'Settings', href: '#/settings' },
];

function useRoute(): [Route, number] {
  const [state, setState] = useState(() => ({ route: parseRoute(location.hash), nav: 0 }));
  useEffect(() => {
    const on = () => setState((s) => ({ route: parseRoute(location.hash), nav: s.nav + 1 }));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (state.route.view === 'search') rememberSearch(routeHash(state.route));
  }, [state.route]);
  return [state.route, state.nav];
}

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

const MockBadge = () => (isMock ? h('span', { class: 'mock-badge', title: 'Showing fake data (?mock=1)' }, 'Mock data') : null);

function NavLinks({ route }: { route: Route }) {
  return h(
    'nav',
    { 'aria-label': 'Main', class: 'nav' },
    NAV.map((n) => {
      const active = route.view === n.view || (route.view === 'page' && n.view === 'search');
      return h('a', { key: n.view, href: n.href, class: active ? 'active' : '', 'aria-current': active ? 'page' : undefined }, n.label);
    }),
  );
}

/** Shown on every screen until the welcome flow is finished. */
function SetupBanner({ route }: { route: Route }) {
  const ob = useStore('onboarding');
  if (!ob || ob.completedAt != null || route.view === 'welcome') return null;
  const step = Math.min(4, Math.max(1, ob.step || 1));
  return h(
    'div',
    { class: 'setup-banner', role: 'region', 'aria-label': 'Setup' },
    h('span', null, h('strong', null, 'Finish setting up history++.'), ` Step ${step} of 4.`),
    h('a', { class: 'btn btn-small btn-primary', href: routeHash({ view: 'welcome', step }) }, 'Continue setup'),
  );
}

function Shell({ route, children }: { route: Route; children?: ComponentChildren }) {
  const skip = h('a', { class: 'skip', href: '#main', onClick: (e: MouseEvent) => (e.preventDefault(), document.getElementById('main')?.focus()) }, 'Skip to content');
  return h(
    'div',
    { class: 'shell shell-top' },
    skip,
    h(
      'header',
      { class: 'topbar' },
      h('a', { class: 'wordmark', href: '#/search', 'aria-label': 'history++ home' }, h('img', { class: 'wordmark-mark', src: '/icon/48.png', alt: '', width: 24, height: 24 }), 'history++'),
      h(MockBadge, null),
      h('div', { class: 'topbar-end' }, h(NavLinks, { route })),
    ),
    h(SetupBanner, { route }),
    h('main', { id: 'main', tabIndex: -1, class: 'main-b' }, children),
  );
}

const TITLES: Record<Route['view'], string> = { search: 'Search', timeline: 'Timeline', insights: 'Insights', page: 'Page', settings: 'Settings', welcome: 'Welcome' };

function App() {
  const [route, nav] = useRoute();

  // "/" focuses search from anywhere (switching views if needed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTyping(document.activeElement)) return;
      e.preventDefault();
      const input = document.getElementById('q') as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
      } else location.hash = '#/search';
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.title = `${TITLES[route.view]} · history++`;
    if (route.view !== 'search') scrollTo(0, 0);
  }, [route.view, route.view === 'page' ? route.id : route.view === 'welcome' ? route.step : 0]);

  if (route.view === 'welcome') return h(WelcomeView, { step: route.step });

  let view;
  switch (route.view) {
    case 'search':
      view = h(HomeView, { q: route.q, nav });
      break;
    case 'timeline':
      view = h(TimelineView, null);
      break;
    case 'insights':
      view = h(InsightsView, null);
      break;
    case 'page':
      view = h(PageView, { id: route.id });
      break;
    case 'settings':
      view = h(SettingsView, null);
      break;
  }
  return h(Shell, { route }, view);
}

export function mount(el: HTMLElement) {
  render(h(App, null), el);
}
