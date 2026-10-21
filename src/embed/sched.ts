// Pure scheduling helpers for the local embedding pipeline (no DOM / extension APIs).

/** Exponential backoff with a cap: 2s, 4s, 8s, ... up to maxMs. */
export class Backoff {
  private failures = 0;
  constructor(
    private readonly baseMs = 2_000,
    private readonly maxMs = 5 * 60_000,
  ) {}
  /** Record a failure; returns how long to wait before retrying. */
  fail(): number {
    this.failures++;
    return Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1));
  }
  reset(): void {
    this.failures = 0;
  }
  get count(): number {
    return this.failures;
  }
}

/**
 * Searches take priority over background indexing: each in-flight query embedding holds the
 * gate; the indexing loop awaits `idle()` before starting its next batch.
 */
export class PriorityGate {
  private active = 0;
  private waiters: (() => void)[] = [];

  enter(): void {
    this.active++;
  }
  leave(): void {
    if (this.active > 0) this.active--;
    if (this.active === 0) {
      const w = this.waiters;
      this.waiters = [];
      for (const r of w) r();
    }
  }
  get busy(): boolean {
    return this.active > 0;
  }
  /** Resolves immediately when no priority work is running, else when the last one leaves. */
  idle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
  /** Runs `fn` while holding the gate. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.enter();
    try {
      return await fn();
    } finally {
      this.leave();
    }
  }
}

/**
 * Splits item indexes into batches of at most `maxBatch`, grouping items of similar length so
 * padding to the longest input in a batch wastes little compute. Returns index groups; callers
 * map results back by index.
 */
export function planBatches(lengths: readonly number[], maxBatch: number): number[][] {
  const size = Math.max(1, Math.floor(maxBatch));
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]! || a - b);
  const out: number[][] = [];
  for (let i = 0; i < order.length; i += size) out.push(order.slice(i, i + size));
  return out;
}

/**
 * How many passages to embed in the next call so one call takes about `targetMs`
 * (keeps a search waiting behind it short). `msPerItem` <= 0 means unknown yet.
 */
export function nextBatchSize(msPerItem: number, targetMs: number, min = 1, max = 16): number {
  if (!(msPerItem > 0)) return min;
  return Math.max(min, Math.min(max, Math.floor(targetMs / msPerItem)));
}

/** Pause between indexing batches: a fraction of the batch time, clamped (CPU duty cycle). */
export function pauseAfter(batchMs: number, fraction = 0.25, minMs = 50, maxMs = 200): number {
  return Math.max(minMs, Math.min(maxMs, Math.round(batchMs * fraction)));
}

/**
 * Cheap pre-truncation before tokenizing: the model sees at most 512 tokens anyway and
 * tokenizing 40k chars only to throw most away is wasted work. ~4 chars/token is generous
 * for most scripts (CJK is denser, so they still hit the tokenizer's 512 cap).
 */
export function clipText(text: string, maxChars = 4_000): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejects with TimeoutError after `ms`; the underlying work is not cancelled. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Small LRU for query vectors: search-as-you-type repeats the same text a lot. */
export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}

/** Throughput estimate: exponential moving average of items/second across batches. */
export class Rate {
  private value: number | undefined;
  constructor(private readonly alpha = 0.3) {}
  add(items: number, ms: number): number {
    if (items <= 0 || ms <= 0) return this.value ?? 0;
    const r = (items * 1000) / ms;
    this.value = this.value === undefined ? r : this.alpha * r + (1 - this.alpha) * this.value;
    return this.value;
  }
  get perSecond(): number | undefined {
    return this.value === undefined ? undefined : Math.round(this.value * 10) / 10;
  }
}
