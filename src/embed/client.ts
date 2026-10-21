// Offscreen-side handle on the embedding worker: request/response by id plus load state.
import type { Backend, EmbedIn, EmbedOut } from './embed.worker';

export type EmbedderLoadState = 'unloaded' | 'loading' | 'ready' | 'error';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class EmbedClient {
  state: EmbedderLoadState = 'unloaded';
  backend: Backend | null = null;
  error: string | undefined;
  loadMs: number | undefined;

  private nextId = 1;
  private pending = new Map<number, { resolve: (v: EmbedOut) => void }>();
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<EmbedOut>) => {
      const m = ev.data;
      if ('type' in m) {
        // Status events: 'error' here only matters if no load() call is tracking it.
        if (m.backend) this.backend = m.backend;
        if (m.state === 'ready') this.state = 'ready';
        else if (m.state === 'loading' && this.state !== 'ready') this.state = 'loading';
        return;
      }
      this.pending.get(m.id)?.resolve(m);
      this.pending.delete(m.id);
    };
    worker.onerror = (e) => {
      console.error('[history++] embed worker error', e.message);
      this.state = 'error';
      this.error = e.message || 'embed worker crashed';
      for (const [id, p] of this.pending) p.resolve({ id, error: this.error });
      this.pending.clear();
    };
  }

  /** Stop the worker (drops the loaded model); pending calls fail. The client is unusable after. */
  terminate(): void {
    this.worker.terminate();
    this.state = 'unloaded';
    for (const [id, p] of this.pending) p.resolve({ id, error: 'embedder stopped' });
    this.pending.clear();
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  private send(msg: DistributiveOmit<EmbedIn, 'id'>, transfer: Transferable[] = []): Promise<EmbedOut> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve });
      this.worker.postMessage({ ...msg, id } as EmbedIn, transfer);
    });
  }

  /** Load the model (idempotent while loading/ready). Rejects on failure; a later call retries. */
  load(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.state = 'loading';
    this.error = undefined;
    this.loadPromise = this.send({ type: 'load' })
      .then((m) => {
        if ('error' in m) throw new Error(m.error);
        if (!('loaded' in m)) throw new Error('unexpected load reply');
        this.backend = m.loaded.backend;
        this.loadMs = m.loaded.ms;
        this.state = 'ready';
      })
      .catch((e: unknown) => {
        this.state = 'error';
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  /** Embed texts (already prefixed with 'query: ' / 'passage: '). L2-normalized, EMBED_DIM long. */
  async embed(texts: string[], opts: { priority?: boolean } = {}): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const m = await this.send({ type: 'embed', texts, priority: opts.priority });
    if ('error' in m) throw new Error(m.error);
    if (!('vectors' in m)) throw new Error('unexpected embed reply');
    return m.vectors;
  }
}
