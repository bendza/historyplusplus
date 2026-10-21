import { describe, expect, it, vi } from 'vitest';
import { Indexer, QueryEmbedder, type Embedder } from './indexer';
import { PriorityGate } from './sched';

function fakeEmbedder(over: Partial<Pick<Embedder, 'ready' | 'state'>> = {}) {
  const calls: string[][] = [];
  const e = {
    ready: true,
    state: 'ready' as Embedder['state'],
    backend: 'wasm' as const,
    load: vi.fn(async () => {}),
    embed: vi.fn(async (texts: string[], _opts?: { priority?: boolean }) => {
      calls.push(texts);
      return texts.map(() => new Float32Array(384));
    }),
    ...over,
  };
  return { e, calls };
}

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ chunkId: i + 1, text: `t${i + 1}` }));

describe('Indexer.runOnce', () => {
  it('embeds pending chunks with the passage prefix and stores them all', async () => {
    const { e, calls } = fakeEmbedder();
    const stored: number[] = [];
    const ix = new Indexer({
      embedder: e,
      gate: new PriorityGate(),
      embedPending: async () => items(5),
      storeEmbeddings: async (it) => void stored.push(...it.map((x) => x.chunkId)),
      sleep: async () => {},
    });
    ix.setEnabled(true);
    expect(await ix.runOnce()).toBe('stored');
    expect(stored).toEqual([1, 2, 3, 4, 5]);
    expect(calls.flat()[0]).toBe('passage: t1');
    expect(calls[0]).toHaveLength(1); // unknown speed: starts with one item per call
    expect(ix.status().state).toBe('indexing');
    expect(ix.status().perSecond).toBeGreaterThan(0);
  });

  it('loads the model first when not ready', async () => {
    const { e } = fakeEmbedder({ ready: false, state: 'unloaded' });
    const ix = new Indexer({ embedder: e, gate: new PriorityGate(), embedPending: async () => items(1), storeEmbeddings: async () => {}, sleep: async () => {} });
    ix.setEnabled(true);
    await ix.runOnce();
    expect(e.load).toHaveBeenCalledOnce();
  });

  it('waits for the priority gate between calls', async () => {
    const { e } = fakeEmbedder();
    const gate = new PriorityGate();
    gate.enter();
    const ix = new Indexer({ embedder: e, gate, embedPending: async () => items(2), storeEmbeddings: async () => {}, sleep: async () => {} });
    ix.setEnabled(true);
    const p = ix.runOnce();
    await new Promise((r) => setTimeout(r, 5));
    expect(e.embed).not.toHaveBeenCalled();
    gate.leave();
    await p;
    expect(e.embed).toHaveBeenCalled();
  });

  it('stores partial progress when an embed call fails', async () => {
    const { e } = fakeEmbedder();
    let n = 0;
    e.embed.mockImplementation(async (texts: string[]) => {
      if (++n === 2) throw new Error('boom');
      return texts.map(() => new Float32Array(384));
    });
    const stored: number[] = [];
    const ix = new Indexer({ embedder: e, gate: new PriorityGate(), embedPending: async () => items(3), storeEmbeddings: async (it) => void stored.push(...it.map((x) => x.chunkId)), sleep: async () => {} });
    ix.setEnabled(true);
    await expect(ix.runOnce()).rejects.toThrow('boom');
    expect(stored).toEqual([1]);
  });

  it('reports disabled / idle states', () => {
    const { e } = fakeEmbedder();
    const ix = new Indexer({ embedder: e, gate: new PriorityGate(), embedPending: async () => [], storeEmbeddings: async () => {} });
    expect(ix.status().state).toBe('idle');
    ix.setEnabled(false);
    expect(ix.status()).toEqual({ state: 'disabled', backend: 'wasm' });
  });
});

describe('QueryEmbedder', () => {
  const mk = (e: Embedder, enabled = true) => new QueryEmbedder({ embedder: e, gate: new PriorityGate(), enabled: () => enabled }, 50);

  it('embeds only the free text with the query prefix, at priority, and caches it', async () => {
    const { e, calls } = fakeEmbedder();
    const q = mk(e);
    const v = await q.vectorFor({ q: 'berlin  techno site:example.com after:2024-01' });
    expect(v).toBeInstanceOf(Float32Array);
    expect(calls).toEqual([['query: berlin techno']]);
    expect(e.embed.mock.calls[0]![1]).toEqual({ priority: true });
    await q.vectorFor({ q: 'berlin techno' });
    expect(calls).toHaveLength(1);
  });

  it('skips keyword mode, disabled setting, and operator-only queries', async () => {
    const { e } = fakeEmbedder();
    expect(await mk(e).vectorFor({ q: 'x', mode: 'keyword' })).toBeUndefined();
    expect(await mk(e, false).vectorFor({ q: 'x' })).toBeUndefined();
    expect(await mk(e).vectorFor({ q: 'site:github.com' })).toBeUndefined();
    expect(e.embed).not.toHaveBeenCalled();
  });

  it('does not wait for an unloaded model but starts loading it', async () => {
    const { e } = fakeEmbedder({ ready: false, state: 'unloaded' });
    expect(await mk(e).vectorFor({ q: 'hello' })).toBeUndefined();
    expect(e.load).toHaveBeenCalledOnce();
    expect(e.embed).not.toHaveBeenCalled();
  });

  it('gives up after the timeout', async () => {
    const { e } = fakeEmbedder();
    e.embed.mockImplementation(() => new Promise(() => {}));
    expect(await mk(e).vectorFor({ q: 'slow' })).toBeUndefined();
  });
});
