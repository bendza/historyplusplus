// First-run flow at #/welcome/N (the background opens it on install). Four steps; progress
// is kept in storage 'onboarding' so closing the tab resumes where you left off.
import { h, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BACKUP_DIR, BACKUP_KEEP } from '../shared/protocol';
import { getStore, isMock, setStore, triggerBackfill, useSettings, useStore } from './api';
import { Meter, Switch } from './common';
import { percent } from './coverage';
import { formatDate, parseDenylist, routeHash } from './format';
import { useStats, useTimeline, summarize } from './home-data';
import { OtherBrowsers } from './importer';
import { MeaningProgress, MODEL_SIZE_LABEL, useMeaning } from './meaning';

const STEPS = ['What it is', 'Your history', 'Search by meaning', 'Stay safe'];

export function WelcomeView({ step }: { step: number }) {
  useEffect(() => {
    // Remember how far we got (never move a finished onboarding back to "not done").
    void getStore('onboarding').then((ob) => setStore('onboarding', { completedAt: ob?.completedAt ?? null, step }));
    document.getElementById('welcome-title')?.focus();
  }, [step]);

  const go = (n: number) => (location.hash = routeHash({ view: 'welcome', step: n }));
  const finish = async (q = '') => {
    await setStore('onboarding', { completedAt: Date.now(), step: 4 });
    location.hash = routeHash({ view: 'search', q });
  };

  const body = step === 1 ? h(StepIntro, null) : step === 2 ? h(StepHistory, null) : step === 3 ? h(StepMeaning, null) : h(StepSafe, { finish });

  return h(
    'div',
    { class: 'welcome' },
    h('header', { class: 'welcome-top' }, h('span', { class: 'wordmark' }, h('img', { class: 'wordmark-mark', src: '/icon/48.png', alt: '', width: 24, height: 24 }), 'history++'), isMock ? h('span', { class: 'mock-badge' }, 'Mock data') : null, h('a', { class: 'welcome-skip', href: '#/search', onClick: (e: Event) => (e.preventDefault(), void finish()) }, 'Skip setup')),
    h(
      'ol',
      { class: 'steps', 'aria-label': 'Setup steps' },
      STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        return h(
          'li',
          { key: n, class: `step step-${state}`, 'aria-current': state === 'current' ? 'step' : undefined },
          h('a', { href: routeHash({ view: 'welcome', step: n }) }, h('span', { class: 'step-n', 'aria-hidden': 'true' }, state === 'done' ? '✓' : n), h('span', { class: 'step-label' }, label, state === 'done' ? h('span', { class: 'sr-only' }, ' (done)') : null)),
        );
      }),
    ),
    h('main', { class: 'welcome-main', id: 'main' }, body),
    h(
      'footer',
      { class: 'welcome-nav' },
      step > 1 ? h('button', { type: 'button', class: 'btn', onClick: () => go(step - 1) }, 'Back') : h('span', null),
      step < 4 ? h('button', { type: 'button', class: 'btn btn-primary btn-wide', onClick: () => go(step + 1) }, 'Continue') : h('button', { type: 'button', class: 'btn btn-primary btn-wide', onClick: () => void finish() }, 'Open history++'),
    ),
  );
}

function Title({ children, lead }: { children?: ComponentChildren; lead: ComponentChildren }) {
  return [h('h1', { id: 'welcome-title', tabIndex: -1, class: 'welcome-title' }, children), h('p', { class: 'welcome-lead' }, lead)];
}

// ---- 1. What it is ----

function StepIntro() {
  const points: [string, string, string][] = [
    ['M10 3v14M3 10h14', 'Kept forever', 'Browsers quietly delete history after about 90 days. history++ keeps every visit, with the words on the pages you actually read.'],
    ['M8.5 3a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM13 13l4 4', 'Found by meaning', 'Search for "that article about sleeping better" and find it even if the page never used those words.'],
    ['M5 9V7a5 5 0 0 1 10 0v2M4 9h12v8H4z', 'Only on this computer', 'No account, no cloud, no tracking. Your history lives in this browser and goes nowhere else.'],
  ];
  return h(
    'section',
    { class: 'welcome-step' },
    h(Title, { lead: 'A memory for everything you read on the web, searchable in a second.' }, 'Never lose a page again'),
    h(
      'ul',
      { class: 'promises' },
      points.map(([d, title, text]) =>
        h(
          'li',
          { key: title },
          h('span', { class: 'promise-icon', 'aria-hidden': 'true' }, h('svg', { viewBox: '0 0 20 20', width: 20, height: 20 }, h('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))),
          h('div', null, h('h2', null, title), h('p', null, text)),
        ),
      ),
    ),
  );
}

// ---- 2. Your history ----

function StepHistory() {
  const bf = useStore('backfill');
  const stats = useStats();
  useEffect(() => {
    // Fresh installs start the import from the background; kick it if nothing ran yet.
    if (bf === null) void triggerBackfill();
  }, [bf === null]);
  const running = bf?.status === 'running';
  const done = bf?.status === 'done';
  const s = stats.data;
  useEffect(() => {
    if (done) stats.reload();
  }, [done]);

  return h(
    'section',
    { class: 'welcome-step' },
    h(Title, { lead: 'history++ starts with what your browsers already remember, so search works from day one.' }, 'Your history so far'),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'This browser'), done ? h('span', { class: 'added' }, h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'), ' Done') : null),
      h(
        'div',
        { role: 'status', 'aria-live': 'polite' },
        running && bf
          ? [
              h('p', { class: 'panel-line' }, `Bringing in your history… ${bf.imported.toLocaleString()} visits so far`),
              h(Meter, { value: percent(bf.scanned, bf.total), label: 'Importing this browser’s history', busy: true }),
            ]
          : bf?.status === 'error'
            ? h('p', { class: 'error-text' }, `The import stopped: ${bf.error ?? 'unknown error'}. `, h('button', { type: 'button', class: 'btn btn-small', onClick: () => void triggerBackfill() }, 'Try again'))
            : bf === undefined
              ? h('p', { class: 'panel-line muted' }, 'Checking…')
              : null,
        s && (done || !running)
          ? h(
              'dl',
              { class: 'mini-stats' },
              h('div', null, h('dt', null, 'Visits'), h('dd', null, s.visits.toLocaleString())),
              h('div', null, h('dt', null, 'Pages'), h('dd', null, s.pages.toLocaleString())),
              h('div', null, h('dt', null, 'Going back to'), h('dd', null, s.oldestVisit ? formatDate(s.oldestVisit) : '—')),
            )
          : null,
      ),
    ),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Other browsers'), h('span', { class: 'muted small' }, 'Optional')), h(OtherBrowsers, null)),
  );
}

// ---- 3. Search by meaning ----

function StepMeaning() {
  const m = useMeaning();
  return h(
    'section',
    { class: 'welcome-step' },
    h(Title, { lead: 'Find pages by what they were about, not just the exact words on them.' }, 'Search by meaning'),
    h(
      'div',
      { class: 'panel' },
      h(
        'ul',
        { class: 'facts' },
        h('li', null, h('strong', null, `One-time download, about ${MODEL_SIZE_LABEL}. `), 'A small language model that runs inside your browser.'),
        h('li', null, h('strong', null, 'Nothing of yours is sent. '), 'The model comes to your computer; your pages never leave it.'),
        h('li', null, h('strong', null, 'Word search already works. '), 'You can keep going while it downloads and reads your pages.'),
      ),
      h(MeaningProgress, { m }),
    ),
  );
}

// ---- 4. Stay safe ----

function StepSafe({ finish }: { finish: (q?: string) => Promise<void> }) {
  const [settings, update] = useSettings();
  const [deny, setDeny] = useState('');
  const week = useTimeline(7);
  const stats = useStats();
  const top = stats.data?.topDomains[0]?.domain;
  const page = week.data ? summarize(week.data).topPages.find((p) => p.title && p.title.split(/\s+/).length >= 4 && !/^(mail\.|inbox)/i.test(p.domain) && !/inbox/i.test(p.title)) : undefined;
  const topic = page?.title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(' ').toLowerCase();
  const suggestions = [['last week', 'Everything from last week'], top ? [`site:${top}`, `Only ${top}`] : null, topic ? [topic, 'Something you read this week'] : null].filter(Boolean) as [string, string][];

  const addDeny = async (e: Event) => {
    e.preventDefault();
    if (!settings) return;
    const add = parseDenylist(deny);
    if (!add.length) return;
    await update({ denylist: [...new Set([...settings.denylist, ...add])] });
    setDeny('');
  };

  return h(
    'section',
    { class: 'welcome-step' },
    h(Title, { lead: 'A few things worth setting now. You can change all of them later in Settings.' }, 'Keep it safe'),
    h(
      'div',
      { class: 'panel' },
      settings
        ? h(Switch, {
            checked: settings.backupEnabled,
            onChange: (v) => void update({ backupEnabled: v }),
            title: 'Back up every day',
            desc: h('span', null, 'A copy goes to ', h('code', null, `Downloads/${BACKUP_DIR}`), `, keeping the last ${BACKUP_KEEP}. Uninstalling the extension deletes its data, so this is your safety net.`),
          })
        : null,
      h(
        'form',
        { class: 'field', onSubmit: addDeny },
        h('label', { for: 'w-deny' }, h('strong', null, 'Never record these sites'), h('span', { class: 'muted block' }, 'Banking, health, anything private. Subdomains are included.')),
        h('div', { class: 'inline' }, h('input', { id: 'w-deny', type: 'text', class: 'text-input', placeholder: 'bank.com', value: deny, onInput: (e: Event) => setDeny((e.currentTarget as HTMLInputElement).value) }), h('button', { type: 'submit', class: 'btn', disabled: !deny.trim() }, 'Add')),
        settings?.denylist.length ? h('ul', { class: 'chip-list', 'aria-label': 'Never recorded' }, settings.denylist.map((d) => h('li', { key: d, class: 'chip chip-static' }, d))) : null,
      ),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Keep it one click away'),
      h(
        'ol',
        { class: 'pin-steps' },
        h('li', null, 'Click the puzzle-piece icon next to the address bar.'),
        h('li', null, 'Find history++ and click the pin.'),
        h('li', null, 'Or press ', h('kbd', null, 'Alt'), '+', h('kbd', null, 'H'), ' anywhere to search.'),
      ),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Try a first search'),
      h(
        'div',
        { class: 'suggest' },
        suggestions.map(([q, why]) => h('button', { type: 'button', key: q, class: 'suggest-btn', onClick: () => void finish(q) }, h('span', { class: 'suggest-q' }, q), h('span', { class: 'muted small' }, why))),
      ),
    ),
  );
}
