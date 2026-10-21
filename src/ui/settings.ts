// Settings: one page, sections with a side index. Status, recording, search by meaning,
// history sources, privacy, backups and the danger zone.
import { h, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BACKUP_DIR, BACKUP_KEEP, EMBED_MODEL, RESTORE_OPFS_FILE, type IndexStatus, type Stats } from '../shared/protocol';
import { backupNow, call, downloadModel, removeModel, triggerBackfill, useSettings, useStore } from './api';
import { ConfirmButton, downloadBlob, ErrorBanner, Favicon, Meter, Spinner, Switch } from './common';
import { backendLabel, monthLabel, percent } from './coverage';
import { exportFilename, formatBytes, formatDate, parseDenylist, relativeTime, toBytes } from './format';
import { DATA_CHANGED } from './home-data';
import { OtherBrowsers } from './importer';
import { MeaningProgress, MODEL_SIZE_LABEL, useMeaning } from './meaning';

const SECTIONS: [string, string][] = [
  ['status', 'Overview'],
  ['recording', 'Recording'],
  ['meaning', 'Search by meaning'],
  ['sources', 'History sources'],
  ['privacy', 'Privacy'],
  ['backups', 'Backups'],
  ['danger', 'Delete everything'],
];

const changed = () => window.dispatchEvent(new Event(DATA_CHANGED));

export function SettingsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsErr, setStatsErr] = useState<unknown>(null);
  useEffect(() => {
    const load = () => call('stats', {}).then((s) => (setStats(s), setStatsErr(null)), setStatsErr);
    void load();
    const t = setInterval(load, 15_000);
    addEventListener(DATA_CHANGED, load);
    return () => {
      clearInterval(t);
      removeEventListener(DATA_CHANGED, load);
    };
  }, []);

  return h(
    'div',
    { class: 'view-settings' },
    h(
      'nav',
      { class: 'settings-index', 'aria-label': 'Settings sections' },
      h('h1', null, 'Settings'),
      h('ul', null, SECTIONS.map(([id, label]) => h('li', { key: id }, h('a', { href: `#/settings`, onClick: (e: Event) => (e.preventDefault(), document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }, label)))),
    ),
    h(
      'div',
      { class: 'settings-body' },
      h(StatusSection, { stats, error: statsErr }),
      h(RecordingSection, null),
      h(MeaningSection, null),
      h(SourcesSection, null),
      h(PrivacySection, null),
      h(BackupSection, null),
      h(DangerSection, null),
    ),
  );
}

function Section({ id, title, desc, children, tone }: { id: string; title: string; desc?: ComponentChildren; children?: ComponentChildren; tone?: 'danger' }) {
  return h(
    'section',
    { class: `card set-section${tone ? ` set-${tone}` : ''}`, id: `set-${id}`, 'aria-labelledby': `set-${id}-h` },
    h('h2', { id: `set-${id}-h` }, title),
    desc ? h('p', { class: 'muted set-desc' }, desc) : null,
    children,
  );
}

// ---- Overview ----

function StatusSection({ stats, error }: { stats: Stats | null; error: unknown }) {
  const m = useMeaning();
  const backup = useStore('backup');
  const idx = m.idx;
  return h(
    Section,
    { id: 'status', title: 'Overview' },
    h(ErrorBanner, { error }),
    h(
      'dl',
      { class: 'stat-strip set-strip' },
      cell('Pages kept', stats ? stats.pages.toLocaleString() : '—', stats?.oldestVisit ? `since ${formatDate(stats.oldestVisit)}` : stats ? `${stats.visits.toLocaleString()} visits` : ''),
      cell('Searchable by meaning', idx ? `${percent(idx.pagesEmbedded, idx.pages)}%` : '—', m.phase === 'not-downloaded' ? 'not turned on' : m.phase === 'reading' ? 'reading pages…' : m.phase === 'downloading' ? 'downloading…' : idx ? `${idx.pagesEmbedded.toLocaleString()} pages` : ''),
      cell('Last backup', backup?.lastAt ? relativeTime(backup.lastAt) : backup === undefined ? '—' : 'Never', backup?.error ? 'last attempt failed' : backup?.lastBytes ? formatBytes(backup.lastBytes) : ''),
      cell('Storage used', stats ? formatBytes(stats.dbBytes) : '—', 'on this computer'),
    ),
  );
}

function cell(label: string, value: string, sub: string) {
  return h('div', { class: 'stat-cell' }, h('dt', null, label), h('dd', null, value), sub ? h('dd', { class: 'stat-note' }, sub) : null);
}

// ---- Recording ----

function RecordingSection() {
  const [s, update] = useSettings();
  const [dwell, setDwell] = useState<string | null>(null);
  if (!s) return h(Section, { id: 'recording', title: 'Recording' }, h(Spinner, null));
  return h(
    Section,
    { id: 'recording', title: 'Recording' },
    h(Switch, { checked: s.paused, onChange: (v) => void update({ paused: v }), title: 'Pause recording', desc: 'No new visits or page text are kept while paused.' }),
    h(Switch, { checked: s.captureText, onChange: (v) => void update({ captureText: v }), title: 'Save the text of pages you read', desc: 'Lets you search the words on a page, not just its title. Off: titles and addresses only.' }),
    h(
      'div',
      { class: 'switch-row' },
      h('label', { class: 'switch-text', for: 'mindwell' }, h('strong', null, 'Save text after'), h('span', { class: 'muted block' }, 'Pages you leave sooner keep only their title, so quick bounces stay out of search.')),
      h(
        'span',
        { class: 'unit-input' },
        h('input', {
          id: 'mindwell',
          type: 'number',
          min: 0,
          max: 600,
          step: 1,
          value: dwell ?? Math.round(s.minDwellMs / 1000),
          onInput: (e: Event) => setDwell((e.currentTarget as HTMLInputElement).value),
          onChange: (e: Event) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v) && v >= 0) void update({ minDwellMs: Math.round(v * 1000) }).then(() => setDwell(null));
          },
        }),
        h('span', { class: 'muted' }, 'seconds'),
      ),
    ),
  );
}

// ---- Search by meaning ----

function MeaningSection() {
  const [s, update] = useSettings();
  const m = useMeaning();
  const { model, idx, phase } = m;
  return h(
    Section,
    { id: 'meaning', title: 'Search by meaning', desc: `Finds pages by what they are about. Uses a small model (${MODEL_SIZE_LABEL}) that runs on this computer; your pages are never sent anywhere.` },
    s ? h(Switch, { checked: s.semanticSearch, onChange: (v) => void update({ semanticSearch: v }).then(changed), title: 'Use search by meaning', desc: 'Off: search matches exact words only, and no pages are read in the background.' }) : null,
    phase === 'off'
      ? null
      : h(
          'div',
          { class: 'model-box' },
          h(
            'div',
            { class: 'model-head' },
            h('span', { class: `dot ${phase === 'ready' ? 'dot-ok' : phase === 'error' ? 'dot-error' : phase === 'not-downloaded' ? '' : 'dot-busy'}`, 'aria-hidden': 'true' }),
            h('strong', null, phase === 'not-downloaded' ? 'Model not downloaded' : phase === 'downloading' ? 'Downloading the model' : phase === 'error' ? 'Download failed' : phase === 'reading' ? 'Model ready' : 'Ready'),
            model?.downloadedAt && (phase === 'ready' || phase === 'reading')
              ? h('span', { class: 'muted' }, `${EMBED_MODEL.replace(/^Xenova\//, '')}, downloaded ${formatDate(model.downloadedAt)}${idx?.embedder?.backend ? `, runs on ${backendLabel(idx.embedder.backend)}` : ''}`)
              : null,
          ),
          phase === 'ready' ? (idx ? h('p', { class: 'muted small' }, `All ${idx.pages.toLocaleString()} pages are searchable by meaning.`) : null) : h(MeaningProgress, { m }),
          phase === 'ready' || phase === 'reading' ? h(ModelActions, null) : null,
        ),
    idx && idx.byMonth.length && phase !== 'off' ? h(MonthTable, { idx }) : null,
  );
}

function ModelActions() {
  return h(
    'div',
    { class: 'actions' },
    h(ConfirmButton, {
      label: 'Download again',
      confirmLabel: 'Download again',
      prompt: `Fetch the ${MODEL_SIZE_LABEL} model again? Use this if search by meaning stopped working. Word search keeps working meanwhile.`,
      onConfirm: async () => {
        await downloadModel();
      },
    }),
    h(ConfirmButton, {
      label: 'Remove',
      danger: true,
      confirmLabel: 'Remove the model',
      prompt: `Delete the model from this computer (frees ${MODEL_SIZE_LABEL})? Search falls back to exact words until you download it again. Your history is not affected.`,
      onConfirm: async () => {
        await removeModel();
        changed();
      },
    }),
  );
}

function MonthTable({ idx }: { idx: IndexStatus }) {
  return h(
    'details',
    { class: 'months-details' },
    h('summary', null, `Coverage by month · ${idx.pagesWithText.toLocaleString()} pages with full text, ${idx.titleOnlyPages.toLocaleString()} with title only`),
    h(
      'div',
      { class: 'month-wrap' },
      h(
        'table',
        { class: 'months' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Month'), h('th', { scope: 'col', class: 'num' }, 'Pages'), h('th', { scope: 'col', class: 'num' }, 'Full text'), h('th', { scope: 'col', class: 'meaning-col' }, 'By meaning'))),
        h(
          'tbody',
          null,
          idx.byMonth.map((mo) => {
            const p = percent(mo.embedded, mo.pages);
            return h(
              'tr',
              { key: mo.month },
              h('th', { scope: 'row' }, monthLabel(mo.month)),
              h('td', { class: 'num' }, mo.pages.toLocaleString()),
              h('td', { class: 'num' }, mo.withText.toLocaleString()),
              h('td', { class: 'meaning-col' }, h('div', { class: 'meaning-cell' }, h('span', { class: 'meter meter-sm', 'aria-hidden': 'true' }, h('span', { class: 'meter-fill', style: { width: `${p}%` } })), h('span', { class: 'pct' }, `${p}%`))),
            );
          }),
        ),
      ),
    ),
  );
}

// ---- History sources ----

function SourcesSection() {
  const sync = useStore('sync');
  const bf = useStore('backfill');
  const imports = useStore('imports') ?? [];
  const [adding, setAdding] = useState(false);
  const running = bf?.status === 'running';
  return h(
    Section,
    { id: 'sources', title: 'History sources', desc: 'Where your history comes from. Imports bring titles, addresses and visit times; duplicates are skipped and your privacy rules apply.' },
    h(
      'ul',
      { class: 'source-list' },
      h(
        'li',
        { class: 'source' },
        h('div', { class: 'source-main' }, h('strong', null, 'This browser'), h('span', { class: 'muted small block', role: 'status', 'aria-live': 'polite' }, thisBrowserLine(sync, bf))),
        running && bf ? h('div', { class: 'source-meter' }, h(Meter, { value: percent(bf.scanned, bf.total), label: 'Importing this browser', busy: true })) : null,
        h('button', { type: 'button', class: 'btn btn-small', disabled: running, onClick: () => void triggerBackfill() }, running ? 'Importing…' : 'Import again'),
      ),
      imports.map((r) =>
        h(
          'li',
          { class: 'source', key: `${r.browser}-${r.file}` },
          h('div', { class: 'source-main' }, h('strong', null, r.browser), h('span', { class: 'muted small block' }, `${r.visits.toLocaleString()} visits from ${r.file} (${r.inserted.toLocaleString()} new), added ${relativeTime(r.at)}`)),
          h('span', { class: 'added' }, h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'), ' Added'),
        ),
      ),
    ),
    adding ? h('div', { class: 'add-browsers' }, h(OtherBrowsers, null)) : h('button', { type: 'button', class: 'btn', onClick: () => setAdding(true) }, '+ Add another browser'),
  );
}

function thisBrowserLine(sync: ReturnType<typeof useStore<'sync'>>, bf: ReturnType<typeof useStore<'backfill'>>): string {
  if (bf?.status === 'running') return `Importing… ${bf.imported.toLocaleString()} visits so far`;
  if (bf?.status === 'error') return `Import stopped: ${bf.error ?? 'unknown error'}`;
  const parts: string[] = [];
  if (sync?.lastCatchUpAt) parts.push(`In sync, last checked ${relativeTime(sync.lastCatchUpAt)}${sync.added ? ` (${sync.added.toLocaleString()} visits caught up)` : ''}`);
  else parts.push('Recording as you browse');
  if (bf?.status === 'done') parts.push(`${bf.imported.toLocaleString()} past visits imported${bf.finishedAt ? ` ${relativeTime(bf.finishedAt)}` : ''}`);
  return parts.join('. ');
}

// ---- Privacy ----

function PrivacySection() {
  const [s, update] = useSettings();
  const [text, setText] = useState('');
  const [forget, setForget] = useState('');
  const [done, setDone] = useState('');
  if (!s) return h(Section, { id: 'privacy', title: 'Privacy' }, h(Spinner, null));
  const add = async (e: Event) => {
    e.preventDefault();
    const list = parseDenylist(text);
    if (!list.length) return;
    await update({ denylist: [...new Set([...s.denylist, ...list])] });
    setText('');
  };
  const forgetDomain = parseDenylist(forget)[0] ?? '';
  return h(
    Section,
    { id: 'privacy', title: 'Privacy', desc: 'Everything stays on this computer. Nothing is sent anywhere, ever.' },
    h(
      'form',
      { class: 'field', onSubmit: add },
      h('label', { for: 'deny-add' }, h('strong', null, 'Never record these sites'), h('span', { class: 'muted block' }, 'Subdomains are included: bank.com also covers login.bank.com. What is already kept stays until you forget it below.')),
      s.denylist.length
        ? h(
            'ul',
            { class: 'chip-list', 'aria-label': 'Never recorded' },
            s.denylist.map((d) =>
              h('li', { key: d, class: 'chip chip-static' }, h(Favicon, { url: `https://${d}/` }), d, h('button', { type: 'button', class: 'chip-x', 'aria-label': `Record ${d} again`, onClick: () => void update({ denylist: s.denylist.filter((x) => x !== d) }) }, '×')),
            ),
          )
        : null,
      h('div', { class: 'inline' }, h('input', { id: 'deny-add', type: 'text', class: 'text-input', placeholder: 'bank.com', value: text, onInput: (e: Event) => setText((e.currentTarget as HTMLInputElement).value) }), h('button', { type: 'submit', class: 'btn', disabled: !text.trim() }, 'Add')),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'forget' }, h('strong', null, 'Forget a site'), h('span', { class: 'muted block' }, 'Deletes every page and visit from a site, then stops recording it.')),
      h(
        'div',
        { class: 'inline' },
        h('input', { id: 'forget', type: 'text', class: 'text-input', placeholder: 'example.com', value: forget, onInput: (e: Event) => (setForget((e.currentTarget as HTMLInputElement).value), setDone('')) }),
        forgetDomain
          ? h(ConfirmButton, {
              label: `Forget ${forgetDomain}`,
              danger: true,
              confirmLabel: `Forget ${forgetDomain}`,
              prompt: h('span', null, 'Delete everything from ', h('strong', null, forgetDomain), ' (and its subdomains) and never record it again? This cannot be undone.'),
              onConfirm: async () => {
                const r = await call('deleteDomain', { domain: forgetDomain });
                await update({ denylist: [...new Set([...s.denylist, forgetDomain])] });
                setDone(`Forgot ${r.deleted.toLocaleString()} page${r.deleted === 1 ? '' : 's'} from ${forgetDomain}.`);
                setForget('');
                changed();
              },
            })
          : null,
      ),
      done ? h('p', { class: 'banner banner-ok', role: 'status' }, done) : null,
    ),
  );
}

// ---- Backups ----

function BackupSection() {
  const [s, update] = useSettings();
  const backup = useStore('backup');
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState<'' | 'db' | 'json'>('');
  const [restore, setRestore] = useState<File | null>(null);
  const [restored, setRestored] = useState('');

  const exportAs = async (kind: 'db' | 'json') => {
    setExporting(kind);
    setError(null);
    try {
      // The SQLite copy goes through "Back up now" (made next to the database, never sent over
      // messaging, so it works at any size); only the JSON export is built here.
      if (kind === 'json') downloadBlob((await call('exportJson', {})).json, exportFilename('json'), 'application/json');
    } catch (e) {
      setError(e);
    } finally {
      setExporting('');
    }
  };

  const pick = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setError(null);
    setRestored('');
    setRestore(file);
  };

  const status = backup?.running
    ? 'Backing up now…'
    : backup?.error
      ? `The last backup failed: ${backup.error}`
      : backup?.lastAt
        ? `Last backup ${relativeTime(backup.lastAt)} (${formatBytes(backup.lastBytes)})${backup.lastFile ? `, saved as Downloads/${backup.lastFile}` : ''}.`
        : 'No backup yet.';

  return h(
    Section,
    { id: 'backups', title: 'Backups', desc: 'Uninstalling the extension deletes its data. A backup file is how you keep your history safe, or move it to another computer.' },
    s
      ? h(Switch, {
          checked: s.backupEnabled,
          onChange: (v) => void update({ backupEnabled: v }),
          title: 'Back up every day',
          desc: h('span', null, 'Saved to ', h('code', null, `Downloads/${BACKUP_DIR}`), `, keeping the last ${BACKUP_KEEP}.`),
        })
      : null,
    h(
      'div',
      { class: 'backup-status' },
      h('span', { class: `dot ${backup?.running ? 'dot-busy' : backup?.error ? 'dot-error' : backup?.lastAt ? 'dot-ok' : ''}`, 'aria-hidden': 'true' }),
      h('span', { role: 'status', 'aria-live': 'polite', class: backup?.error ? 'error-text' : '' }, status),
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary', disabled: !!backup?.running, onClick: () => (setError(null), backupNow().catch(setError)) }, backup?.running ? 'Backing up…' : 'Back up now'),
      h('label', { class: 'btn', for: 'restore-file' }, 'Restore from a backup…', h('input', { id: 'restore-file', type: 'file', accept: '.sqlite3,.sqlite,.db,application/vnd.sqlite3', hidden: true, onChange: pick })),
      h('button', { type: 'button', class: 'btn', disabled: !!exporting, onClick: () => void exportAs('json') }, exporting === 'json' ? 'Exporting…' : 'Export JSON'),
    ),
    restore ? h(RestoreConfirm, { file: restore, onCancel: () => setRestore(null), onDone: (msg) => (setRestore(null), setRestored(msg)) }) : null,
    restored ? h('p', { class: 'banner banner-ok', role: 'status' }, restored) : null,
    h(ErrorBanner, { error }),
  );
}

/** Copy the chosen backup into this extension's private storage (OPFS), reporting progress 0..1. */
async function writeToOpfs(file: File, onProgress: (f: number) => void): Promise<void> {
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle(RESTORE_OPFS_FILE, { create: true });
  const out = await handle.createWritable();
  try {
    const CH = 8 * 1024 * 1024;
    for (let i = 0; i < file.size; i += CH) {
      await out.write(file.slice(i, i + CH));
      onProgress(Math.min(1, (i + CH) / file.size));
    }
    await out.close();
  } catch (e) {
    await out.abort().catch(() => {});
    throw e;
  }
}

function RestoreConfirm({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (msg: string) => void }) {
  const [stage, setStage] = useState<'' | 'copying' | 'restoring'>('');
  const [copied, setCopied] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const busy = stage !== '';
  const run = async () => {
    setError(null);
    setCopied(0);
    try {
      setStage('copying');
      await writeToOpfs(file, setCopied);
      setStage('restoring');
      const r = await call('restoreDb', { opfsFile: RESTORE_OPFS_FILE });
      changed();
      onDone(`Restored ${r.pages.toLocaleString()} pages and ${r.visits.toLocaleString()} visits from ${file.name}.`);
    } catch (e) {
      setError(e);
    } finally {
      setStage('');
    }
  };
  return h(
    'div',
    { class: 'confirm', role: 'alertdialog', 'aria-labelledby': 'restore-q' },
    h('p', { id: 'restore-q', class: 'confirm-prompt' }, h('strong', null, `Replace everything with ${file.name} (${formatBytes(file.size)})?`), ' Your current history is swapped for the one in this backup. Anything recorded since that backup was made is lost. The file is checked first; if it is not a history++ backup, nothing changes.'),
    busy
      ? h(
          'div',
          { class: 'mp-progress restore-progress', role: 'status', 'aria-live': 'polite' },
          h('div', { class: 'mp-line' }, h('strong', null, stage === 'copying' ? 'Reading the backup' : 'Restoring'), h('span', { class: 'muted' }, stage === 'copying' ? `${formatBytes(file.size * copied)} of ${formatBytes(file.size)}` : 'Checking and swapping in the backup…')),
          h(Meter, { value: stage === 'copying' ? Math.round(copied * 100) : null, label: 'Restore progress', busy: true }),
        )
      : null,
    h('div', { class: 'confirm-actions' }, h('button', { type: 'button', class: 'btn btn-danger', disabled: busy, onClick: run, autoFocus: true }, busy ? 'Restoring…' : 'Replace with this backup'), h('button', { type: 'button', class: 'btn', disabled: busy, onClick: onCancel }, 'Cancel')),
    h(ErrorBanner, { error }),
  );
}

// ---- Danger zone ----

const PHRASE = 'delete everything';

function DangerSection() {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('deleteAll', {});
      setDone(true);
      setTyped('');
      changed();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return h(
    Section,
    { id: 'danger', title: 'Delete everything', tone: 'danger', desc: 'Removes every page, visit and saved text from this computer. Settings and the model stay. Back up first if you might want it later.' },
    done
      ? h('p', { class: 'banner banner-ok', role: 'status' }, 'Everything was deleted. history++ keeps recording from now on.')
      : h(
          'div',
          { class: 'field' },
          h('label', { for: 'danger-type' }, 'Type ', h('strong', null, PHRASE), ' to confirm'),
          h(
            'div',
            { class: 'inline' },
            h('input', { id: 'danger-type', type: 'text', class: 'text-input', autoComplete: 'off', spellcheck: false, value: typed, onInput: (e: Event) => setTyped((e.currentTarget as HTMLInputElement).value) }),
            h('button', { type: 'button', class: 'btn btn-danger', disabled: busy || typed.trim().toLowerCase() !== PHRASE, onClick: run }, busy ? 'Deleting…' : 'Delete all history'),
          ),
        ),
    h(ErrorBanner, { error }),
  );
}
