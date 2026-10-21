// "Search by meaning" status shared by the welcome flow, the popup banner and Settings:
// the one-time model download (storage 'model') and reading pages (indexStatus).
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { IndexStatus, ModelState } from '../shared/protocol';
import { downloadModel, useSettings, useStore } from './api';
import { ErrorBanner, Meter } from './common';
import { downloadLabel, formatEta, meaningPhase, percent, type MeaningPhase } from './coverage';
import { useIndexStatus } from './home-data';

export const MODEL_SIZE_LABEL = '118 MB';

export interface MeaningState {
  phase: MeaningPhase;
  model: ModelState | null | undefined;
  idx: IndexStatus | null;
  /** Download ETA from the observed rate ('' until known). */
  eta: string;
}

/** Bytes/s over the last few samples of a growing counter. */
function useRate(value: number | undefined): number {
  const samples = useRef<{ t: number; v: number }[]>([]);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (value == null) return;
    const now = Date.now();
    const s = samples.current.filter((x) => now - x.t < 8000 && x.v <= value);
    s.push({ t: now, v: value });
    samples.current = s;
    const first = s[0]!;
    if (s.length > 1 && now > first.t) setRate(((value - first.v) / (now - first.t)) * 1000);
  }, [value]);
  return rate;
}

export function useMeaning(): MeaningState {
  const model = useStore('model');
  const idx = useIndexStatus(model?.status === 'downloading' ? 1500 : undefined);
  const [settings] = useSettings();
  const loaded = model?.status === 'downloading' ? model.loaded : idx?.embedder?.download?.loaded;
  const total = model?.status === 'downloading' ? model.total : (idx?.embedder?.download?.total ?? 0);
  const rate = useRate(loaded);
  const phase = meaningPhase(model, idx, settings?.semanticSearch ?? true);
  const eta = phase === 'downloading' && loaded != null && total > 0 ? formatEta(total - loaded, rate) : '';
  return { phase, model, idx, eta };
}

/** Progress block for the current phase. `onDownload` starts (or retries) the download. */
export function MeaningProgress({ m, compact = false }: { m: MeaningState; compact?: boolean }) {
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      await downloadModel();
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  };
  const { phase, model, idx } = m;
  let body;
  switch (phase) {
    case 'not-downloaded':
      body = h(
        'div',
        { class: 'mp-row' },
        h('button', { type: 'button', class: 'btn btn-primary', disabled: starting, onClick: start }, starting ? 'Starting…' : `Download (${MODEL_SIZE_LABEL})`),
        compact ? null : h('span', { class: 'muted small' }, 'Word search already works while you decide.'),
      );
      break;
    case 'downloading': {
      const loaded = model?.loaded ?? idx?.embedder?.download?.loaded ?? 0;
      const total = model?.total || idx?.embedder?.download?.total || 0;
      const pct = total ? percent(loaded, total) : null;
      body = h(
        'div',
        { class: 'mp-progress' },
        h('div', { class: 'mp-line' }, h('strong', null, 'Downloading'), h('span', { class: 'muted' }, `${downloadLabel(loaded, total)}${m.eta ? ` · ${m.eta} left` : ''}`)),
        h(Meter, { value: pct, label: 'Model download', busy: true }),
      );
      break;
    }
    case 'error':
      body = h(
        'div',
        { class: 'mp-error' },
        h('p', { class: 'error-text' }, h('strong', null, 'The download did not finish. '), model?.error ?? idx?.embedder?.error ?? 'Check your connection and try again.'),
        h('button', { type: 'button', class: 'btn btn-primary', disabled: starting, onClick: start }, 'Retry download'),
      );
      break;
    case 'reading': {
      const done = idx?.pagesEmbedded ?? 0;
      const all = idx?.pages ?? 0;
      const eta = idx?.embedder?.state === 'indexing' ? formatEta((idx.chunksTotal ?? 0) - (idx.chunksEmbedded ?? 0), idx.embedder.perSecond) : '';
      body = h(
        'div',
        { class: 'mp-progress' },
        h('div', { class: 'mp-line' }, h('strong', null, 'Reading your pages'), h('span', { class: 'muted' }, `${done.toLocaleString()} of ${all.toLocaleString()}${eta ? ` · ${eta} left` : ''}`)),
        h(Meter, { value: idx ? percent(idx.chunksEmbedded, idx.chunksTotal) : null, label: 'Pages read for search by meaning', busy: true }),
      );
      break;
    }
    case 'ready':
      body = h('p', { class: 'mp-ready' }, h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'), ` Ready. ${(idx?.pages ?? 0).toLocaleString()} pages searchable by meaning.`);
      break;
    case 'off':
      body = h('p', { class: 'muted' }, 'Search by meaning is turned off in Settings.');
      break;
  }
  return h('div', { class: 'meaning-progress', 'aria-live': 'polite' }, body, h(ErrorBanner, { error }));
}
