import { describe, expect, it } from 'vitest';
import { backendLabel, embedderStateLabel, formatEta, matchSuffix, monthLabel, percent, pollInterval } from './coverage';
import type { IndexStatus } from '../shared/protocol';

describe('percent', () => {
  it('handles empty totals', () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(5, 0)).toBe(0);
  });
  it('rounds and clamps', () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(10, 10)).toBe(100);
    expect(percent(12, 10)).toBe(100);
  });
  it('never shows 100 before done or 0 once started', () => {
    expect(percent(9999, 10000)).toBe(99);
    expect(percent(1, 10000)).toBe(1);
  });
});

describe('formatEta', () => {
  it('is empty without a rate or work', () => {
    expect(formatEta(100, undefined)).toBe('');
    expect(formatEta(100, 0)).toBe('');
    expect(formatEta(0, 10)).toBe('');
  });
  it('formats seconds, minutes and hours', () => {
    expect(formatEta(10, 10)).toBe('about 5 s');
    expect(formatEta(420, 10)).toBe('about 45 s');
    expect(formatEta(6000, 10)).toBe('about 10 min');
    expect(formatEta(36000, 10)).toBe('about 1 h');
    expect(formatEta(45000, 10)).toBe('about 1 h 15 min');
  });
});

describe('monthLabel', () => {
  const now = new Date(2026, 9, 13).getTime();
  it('omits the current year', () => {
    expect(monthLabel('2026-03', now)).toBe('Mar');
    expect(monthLabel('2025-12', now)).toBe('Dec 2025');
  });
  it('passes through junk', () => {
    expect(monthLabel('2026-13', now)).toBe('2026-13');
    expect(monthLabel('nope', now)).toBe('nope');
  });
});

describe('embedder labels', () => {
  const base = { chunksTotal: 10, chunksEmbedded: 10 };
  const e = (state: NonNullable<IndexStatus['embedder']>['state'], extra = {}) => ({ ...base, embedder: { state, backend: 'wasm' as const, ...extra } });
  it('maps states', () => {
    expect(embedderStateLabel(e('loading'), true)).toBe('Loading model…');
    expect(embedderStateLabel(e('indexing'), true)).toBe('Indexing…');
    expect(embedderStateLabel(e('ready'), true)).toBe('Up to date');
    expect(embedderStateLabel({ ...e('idle'), chunksEmbedded: 3 }, true)).toBe('Waiting to index');
    expect(embedderStateLabel(e('error', { error: 'no WebGPU' }), true)).toBe('Error: no WebGPU');
    expect(embedderStateLabel(e('disabled'), true)).toBe('Off');
    expect(embedderStateLabel(e('ready'), false)).toBe('Off');
    expect(embedderStateLabel(base, true)).toBe('Not running');
  });
  it('labels backends', () => {
    expect(backendLabel('webgpu')).toBe('GPU (WebGPU)');
    expect(backendLabel('wasm')).toBe('CPU (WASM)');
    expect(backendLabel(null)).toBe('');
  });
  it('polls fast only while busy', () => {
    expect(pollInterval(null)).toBe(15000);
    expect(pollInterval({ embedder: { state: 'indexing', backend: null } } as IndexStatus)).toBe(2000);
    expect(pollInterval({ embedder: { state: 'ready', backend: null } } as IndexStatus)).toBe(15000);
  });
});

describe('matchSuffix', () => {
  it('only appears when meaning contributed', () => {
    expect(matchSuffix([])).toBe('');
    expect(matchSuffix([{ match: 'keyword' }])).toBe('');
    expect(matchSuffix([{ match: 'keyword' }, { match: 'both' }])).toBe(' · meaning + keywords');
  });
});

describe('meaningPhase', () => {
  const idx = (embedded: number, state: 'idle' | 'indexing' | 'ready' | 'disabled' | 'not-downloaded' | 'error' = 'indexing') => ({
    pages: 10,
    pagesEmbedded: embedded,
    chunksTotal: 100,
    chunksEmbedded: embedded * 10,
    embedder: { state, backend: null },
  });
  it('follows the download first, then the reading progress', async () => {
    const { meaningPhase } = await import('./coverage');
    expect(meaningPhase({ status: 'not-downloaded' }, idx(0, 'not-downloaded'))).toBe('not-downloaded');
    expect(meaningPhase({ status: 'downloading' }, idx(0))).toBe('downloading');
    expect(meaningPhase({ status: 'error' }, idx(0))).toBe('error');
    expect(meaningPhase({ status: 'ready' }, idx(4))).toBe('reading');
    expect(meaningPhase({ status: 'ready' }, idx(10, 'ready'))).toBe('ready');
    expect(meaningPhase(null, idx(0, 'not-downloaded'))).toBe('not-downloaded');
    expect(meaningPhase({ status: 'ready' }, idx(4), false)).toBe('off');
  });
  it('labels download sizes in MB', async () => {
    const { downloadLabel } = await import('./coverage');
    expect(downloadLabel(42 * 1_048_576, 118 * 1_048_576)).toBe('42 MB of 118 MB');
    expect(downloadLabel(5 * 1_048_576, 0)).toBe('5 MB');
  });
});
