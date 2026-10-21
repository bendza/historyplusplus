// Background indexing loop + query-embedding policy. Runs in the offscreen document;
// dependencies are injected so the logic is testable without workers or extension APIs.
import { parseQuery } from '../engine/query';
import type { IndexStatus, SearchQuery } from '../shared/protocol';
import { Backoff, Lru, PriorityGate, Rate, nextBatchSize, pauseAfter, withTimeout } from './sched';

export interface Embedder {
  readonly ready: boolean;
  readonly state: 'unloaded' | 'loading' | 'ready' | 'error';
  readonly backend: 'webgpu' | 'wasm' | null;
  readonly error?: string;
  load(): Promise<void>;
  embed(texts: string[], opts?: { priority?: boolean }): Promise<Float32Array[]>;
}

export interface IndexerDeps {
  embedder: Embedder;
  gate: PriorityGate;
  embedPending(limit: number): Promise<{ chunkId: number; text: string }[]>;
  storeEmbeddings(items: { chunkId: number; vector: Float32Array }[]): Promise<void>;
  /** Plain (non-wakeable) sleep; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const PENDING_LIMIT = 32;
export const IDLE_POLL_MS = 30_000;
const TARGET_CALL_MS = 400; // one embed call should leave a waiting search at most ~this long

type Phase = 'idle' | 'disabled' | 'loading' | 'indexing' | 'ready' | 'error';
type EmbedderStatus = NonNullable<IndexStatus['embedder']>;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Indexer {
  private enabled: boolean | null = null; // null: settings not known yet
  private phase: Phase = 'idle';
  private error: string | undefined;
  private readonly backoff = new Backoff();
  private readonly rate = new Rate();
  private msPerItem = 0;
  private wakeUp: (() => void) | null = null;
  private started = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: IndexerDeps) {
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? (() => performance.now());
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on) this.backoff.reset();
    this.wake();
  }

  get isEnabled(): boolean {
    return this.enabled === true;
  }

  /** Cut an idle/backoff wait short (new text captured, settings changed). */
  wake(): void {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }

  status(): EmbedderStatus {
    const e = this.deps.embedder;
    const state: EmbedderStatus['state'] =
      this.enabled === false ? 'disabled' : this.phase === 'disabled' ? 'idle' : this.phase;
    const out: EmbedderStatus = { state, backend: e.backend };
    const err = state === 'error' ? this.error ?? e.error : undefined;
    if (err) out.error = err;
    const ps = this.rate.perSecond;
    if (ps !== undefined) out.perSecond = ps;
    return out;
  }

  /** Starts the loop once; it never resolves and never throws. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = Number.isFinite(ms) ? setTimeout(() => done(), ms) : undefined;
      const done = () => {
        if (t !== undefined) clearTimeout(t);
        if (this.wakeUp === done) this.wakeUp = null;
        resolve();
      };
      this.wakeUp = done;
    });
  }

  private async loop(): Promise<never> {
    for (;;) {
      if (!this.enabled) {
        this.phase = this.enabled === false ? 'disabled' : 'idle';
        await this.wait(Infinity);
        continue;
      }
      try {
        await this.runOnce();
      } catch (e) {
        this.phase = 'error';
        this.error = errText(e);
        const ms = this.backoff.fail();
        console.warn(`[history++] embedder: ${this.error}; retrying in ${Math.round(ms / 1000)} s`);
        await this.wait(ms);
      }
    }
  }

  /** One round: load model, fetch pending chunks, embed them, store. Exposed for tests. */
  async runOnce(): Promise<'empty' | 'stored' | 'disabled'> {
    const { embedder, gate } = this.deps;
    if (!embedder.ready) {
      this.phase = 'loading';
      await embedder.load();
    }
    if (!this.enabled) return 'disabled';
    const items = await this.deps.embedPending(PENDING_LIMIT);
    this.backoff.reset();
    this.error = undefined;
    if (!items.length) {
      this.phase = 'ready';
      await this.wait(IDLE_POLL_MS);
      return 'empty';
    }
    this.phase = 'indexing';
    const out: { chunkId: number; vector: Float32Array }[] = [];
    try {
      for (let i = 0; i < items.length; ) {
        await gate.idle(); // searches first
        if (!this.enabled) break;
        const slice = items.slice(i, i + nextBatchSize(this.msPerItem, TARGET_CALL_MS));
        const t0 = this.now();
        const vectors = await embedder.embed(slice.map((it) => `passage: ${it.text}`));
        const ms = Math.max(1, this.now() - t0);
        this.msPerItem = this.msPerItem ? 0.5 * this.msPerItem + 0.5 * (ms / slice.length) : ms / slice.length;
        this.rate.add(slice.length, ms);
        slice.forEach((it, k) => out.push({ chunkId: it.chunkId, vector: vectors[k]! }));
        i += slice.length;
        await this.sleep(pauseAfter(ms));
      }
    } finally {
      // Keep partial progress even when a later call failed or indexing was switched off.
      if (out.length) await this.deps.storeEmbeddings(out);
    }
    return this.enabled ? 'stored' : 'disabled';
  }
}

export const QUERY_TIMEOUT_MS = 1_500;

/**
 * Decide whether a search gets a query vector and compute it. Never throws: on any problem the
 * search simply runs keyword-only. When the model isn't loaded yet we don't wait for it.
 */
export class QueryEmbedder {
  private readonly cache = new Lru<string, Float32Array>(64);
  constructor(
    private readonly deps: { embedder: Embedder; gate: PriorityGate; enabled: () => boolean },
    private readonly timeoutMs = QUERY_TIMEOUT_MS,
  ) {}

  async vectorFor(args: SearchQuery): Promise<Float32Array | undefined> {
    const { embedder, gate } = this.deps;
    if (!this.deps.enabled() || args.mode === 'keyword') return undefined;
    const text = parseQuery(args.q ?? '').text.trim().replace(/\s+/g, ' ');
    if (!text) return undefined;
    const hit = this.cache.get(text);
    if (hit) return hit;
    if (!embedder.ready) {
      if (embedder.state !== 'loading') embedder.load().catch(() => {}); // warm up for next time
      return undefined;
    }
    try {
      const [v] = await gate.run(() => withTimeout(embedder.embed([`query: ${text}`], { priority: true }), this.timeoutMs));
      if (v) this.cache.set(text, v);
      return v;
    } catch (e) {
      console.warn('[history++] query embedding skipped:', errText(e));
      return undefined;
    }
  }
}
