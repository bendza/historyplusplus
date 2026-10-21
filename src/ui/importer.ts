// "Other browsers" list shared by the welcome flow and Settings: one row per browser with the
// exact history-file path (copyable) and an Add button that runs the on-device importer.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { importHistoryFile, type ImportProgress } from '../import/run-import';
import { call, getSettings, getStore, isMock, setStore, useStore, type ImportRecord } from './api';
import { CopyField, ErrorBanner, Meter } from './common';
import { relativeTime } from './format';
import { DATA_CHANGED } from './home-data';
import { detectOS, historyFileLocations, pastePathHint, type HistoryLocation } from './sources';

async function runImport(loc: HistoryLocation, file: File, onProgress: (p: ImportProgress) => void): Promise<ImportProgress> {
  let p: ImportProgress;
  if (isMock) {
    // No real file parsing in mock mode: pretend to read a few thousand visits.
    const total = 3_000 + Math.round(Math.random() * 4_000);
    p = { file: file.name, kind: 'chromium', done: 0, total, inserted: 0, skipped: 12 };
    while (p.done < total) {
      await new Promise((r) => setTimeout(r, 140));
      p = { ...p, done: Math.min(total, p.done + 900), inserted: Math.min(total, p.done + 900) - 40 };
      onProgress(p);
    }
  } else {
    p = await importHistoryFile(file, await getSettings(), (visits) => call('importVisits', { visits }), onProgress);
  }
  const rec: ImportRecord = { browser: loc.browser, file: file.name, visits: p.total, inserted: p.inserted, at: Date.now() };
  const prev = (await getStore('imports')) ?? [];
  await setStore('imports', [...prev.filter((r) => !(r.browser === rec.browser && r.file === rec.file)), rec]);
  window.dispatchEvent(new Event(DATA_CHANGED));
  return p;
}

export function OtherBrowsers({ compact = false }: { compact?: boolean }) {
  const os = detectOS();
  const imports = useStore('imports') ?? [];
  const locs = historyFileLocations(os);
  return h(
    'div',
    { class: 'browsers' },
    h('p', { class: 'muted small browsers-hint' }, `Pick another browser's history file. It is read on this computer only. ${pastePathHint(os)}`),
    h(
      'ul',
      { class: 'browser-list' },
      locs.map((loc) => h(BrowserRow, { key: loc.browser, loc, done: imports.filter((r) => r.browser === loc.browser), compact })),
    ),
  );
}

function BrowserRow({ loc, done }: { loc: HistoryLocation; done: ImportRecord[]; compact: boolean }) {
  const [prog, setProg] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busy = !!prog && prog.done < prog.total;
  const added = done.reduce((n, r) => n + r.visits, 0);

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setError(null);
    setProg({ file: file.name, kind: null, done: 0, total: 1, inserted: 0, skipped: 0 });
    try {
      await runImport(loc, file, setProg);
    } catch (err) {
      setError(err);
    } finally {
      setProg(null);
    }
  };

  const id = `pick-${loc.browser.toLowerCase().replace(/\W+/g, '-')}`;
  return h(
    'li',
    { class: 'browser-row' },
    h(
      'div',
      { class: 'browser-head' },
      h('strong', null, loc.browser),
      added ? h('span', { class: 'added' }, h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'), ` Added · ${added.toLocaleString()} visits`, done[0] ? h('span', { class: 'muted' }, ` · ${relativeTime(done[done.length - 1]!.at)}`) : null) : null,
      h(
        'label',
        { class: `btn btn-small${busy ? ' disabled' : ''}`, for: id },
        busy ? 'Adding…' : added ? 'Add again' : 'Add',
        h('input', { id, type: 'file', hidden: true, disabled: busy, onChange: onFile, 'aria-label': `Choose the ${loc.browser} history file` }),
      ),
    ),
    h(CopyField, { value: loc.path, label: `${loc.browser} history file location` }),
    loc.note ? h('p', { class: 'muted small' }, loc.note) : null,
    busy && prog
      ? h(
          'div',
          { class: 'row-progress', role: 'status', 'aria-live': 'polite' },
          h(Meter, { value: Math.round((prog.done / Math.max(1, prog.total)) * 100), label: `Adding ${loc.browser} history` }),
          h('span', { class: 'muted small' }, `${prog.done.toLocaleString()} of ${prog.total.toLocaleString()} visits`),
        )
      : null,
    h(ErrorBanner, { error }),
  );
}
