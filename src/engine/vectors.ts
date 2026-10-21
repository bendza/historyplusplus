// In-memory int8 vector index for brute-force semantic search. Vectors are L2-normalized
// e5 embeddings quantized to int8 with a per-vector scale (max |v_i| -> 127), packed as
// dim int8 bytes + float32 scale. A fixed v*127 scale wasted most of the int8 range (e5
// components are ~0.05) and added up to ~0.008 cosine error, a big chunk of the ~0.03 margin
// that separates related from unrelated pages; per-vector scaling keeps it under ~0.0015.
// 100k vectors x 384 dims scans in ~20-40 ms.
import { EMBED_DIM } from '../shared/protocol';

/** Stored bytes per vector: int8 components + float32 scale. */
export const QUANT_BYTES = EMBED_DIM + 4;

/** Float vector -> packed int8 bytes (components scaled so max |v_i| maps to 127, then the scale). */
export function quantize(v: ArrayLike<number>): Int8Array {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]!));
  const scale = max || 1;
  const out = new Int8Array(v.length + 4);
  for (let i = 0; i < v.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round((v[i]! / scale) * 127)));
  new DataView(out.buffer, out.byteOffset + v.length, 4).setFloat32(0, scale, true);
  return out;
}

/** Multiplier turning a packed vector's int8 components back into floats. */
function stepOf(packed: Int8Array, dim: number): number {
  return new DataView(packed.buffer, packed.byteOffset + dim, 4).getFloat32(0, true) / 127;
}

export function dequantize(packed: Int8Array): Float32Array {
  const dim = packed.length - 4;
  const step = stepOf(packed, dim);
  return Float32Array.from(packed.subarray(0, dim), (x) => x * step);
}

/**
 * Below this many live vectors the corpus mean is too noisy to center on, so search() returns
 * raw cosine. Above it, similarities are computed on corpus-centered vectors (see search()).
 */
export const CENTER_MIN_VECTORS = 500;

/** Expected maximum of k independent standard normals, k = 0..10 (k >= 10 uses the last). */
const EXPECTED_MAX = [0, 0, 0.5642, 0.8463, 1.0294, 1.163, 1.2672, 1.3522, 1.4236, 1.485, 1.5388];

export interface VectorHit {
  pageId: number;
  chunkId: number;
  sim: number; // cosine similarity of the page's best chunk
}

export class VectorIndex {
  private vecs = new Int8Array(0);
  private chunkIds = new Int32Array(0);
  private pageIds = new Int32Array(0); // -1 = tombstone
  private steps = new Float32Array(0); // per-vector dequantization multiplier
  private sims = new Float32Array(0);
  /** Similarity distribution of the last search() over all live vectors (per-query background). */
  lastStats = { n: 0, mean: 0, sd: 0, centered: false };
  // Corpus centering state: running sum of live vectors, the mean snapshot `mu` that the
  // per-slot dot products `md[s] = mu . d_s` were computed against, and the live count then.
  private sum = new Float64Array(0);
  private mu: Float64Array | null = null;
  private muSq = 0;
  private md = new Float32Array(0);
  private muAt = 0;
  private slotOf = new Map<number, number>(); // chunkId -> slot
  private chunksOf = new Map<number, number>(); // pageId -> live vectors
  private n = 0; // slots in use, including tombstones
  private dead = 0;

  constructor(readonly dim = EMBED_DIM) {
    this.sum = new Float64Array(dim);
  }

  /** Add (sign 1) or remove (sign -1) slot s's vector from the running corpus sum. */
  private accumulate(s: number, sign: number): void {
    const d = this.dim,
      o = s * d,
      step = this.steps[s]! * sign;
    for (let j = 0; j < d; j++) this.sum[j] = this.sum[j]! + this.vecs[o + j]! * step;
  }

  /** mu . d_s for one slot. */
  private dotMu(s: number): number {
    const d = this.dim,
      o = s * d,
      mu = this.mu!;
    let a = 0;
    for (let j = 0; j < d; j++) a += mu[j]! * this.vecs[o + j]!;
    return a * this.steps[s]!;
  }

  /** Re-snapshot the corpus mean when the corpus changed by >10% since the last snapshot. */
  private refreshMean(live: number): void {
    if (this.mu && Math.abs(live - this.muAt) <= this.muAt * 0.1) return;
    const mu = Float64Array.from(this.sum, (x) => x / Math.max(1, live));
    this.mu = mu;
    this.muSq = mu.reduce((a, x) => a + x * x, 0);
    this.muAt = live;
    for (let s = 0; s < this.n; s++) if (this.pageIds[s]! >= 0) this.md[s] = this.dotMu(s);
  }

  private count(pageId: number, delta: number): void {
    const c = (this.chunksOf.get(pageId) ?? 0) + delta;
    if (c > 0) this.chunksOf.set(pageId, c);
    else this.chunksOf.delete(pageId);
  }

  /** Live vectors of one page. */
  chunkCount(pageId: number): number {
    return this.chunksOf.get(pageId) ?? 0;
  }

  /** Live vectors. */
  get size(): number {
    return this.n - this.dead;
  }

  private grow(min: number): void {
    const cap = Math.max(min, Math.ceil(this.chunkIds.length * 1.5), 1024);
    const vecs = new Int8Array(cap * this.dim);
    vecs.set(this.vecs.subarray(0, this.n * this.dim));
    const chunkIds = new Int32Array(cap);
    chunkIds.set(this.chunkIds.subarray(0, this.n));
    const pageIds = new Int32Array(cap);
    pageIds.set(this.pageIds.subarray(0, this.n));
    const steps = new Float32Array(cap);
    steps.set(this.steps.subarray(0, this.n));
    const md = new Float32Array(cap);
    md.set(this.md.subarray(0, this.n));
    [this.vecs, this.chunkIds, this.pageIds, this.steps, this.md, this.sims] = [vecs, chunkIds, pageIds, steps, md, new Float32Array(cap)];
  }

  /** Add or replace one chunk's vector (packed by quantize(): `dim` int8 + float32 scale). */
  upsert(chunkId: number, pageId: number, v: Int8Array): void {
    let slot = this.slotOf.get(chunkId);
    if (slot === undefined) {
      if (this.n === this.chunkIds.length) this.grow(this.n + 1);
      slot = this.n++;
      this.slotOf.set(chunkId, slot);
      this.chunkIds[slot] = chunkId;
    } else if (this.pageIds[slot]! >= 0) {
      this.accumulate(slot, -1);
      this.count(this.pageIds[slot]!, -1);
    }
    this.pageIds[slot] = pageId;
    this.count(pageId, 1);
    this.vecs.set(v.subarray(0, this.dim), slot * this.dim);
    this.steps[slot] = stepOf(v, this.dim);
    this.accumulate(slot, 1);
    if (this.mu) this.md[slot] = this.dotMu(slot);
  }

  remove(chunkId: number): void {
    const slot = this.slotOf.get(chunkId);
    if (slot === undefined) return;
    this.slotOf.delete(chunkId);
    this.accumulate(slot, -1);
    this.count(this.pageIds[slot]!, -1);
    this.pageIds[slot] = -1;
    this.dead++;
    if (this.dead > 1024 && this.dead > this.n / 4) this.compact();
  }

  has(chunkId: number): boolean {
    return this.slotOf.has(chunkId);
  }

  /** Drop tombstones, keeping slot order. */
  compact(): void {
    const d = this.dim;
    let w = 0;
    for (let r = 0; r < this.n; r++) {
      if (this.pageIds[r]! < 0) continue;
      if (w !== r) {
        this.vecs.copyWithin(w * d, r * d, (r + 1) * d);
        this.chunkIds[w] = this.chunkIds[r]!;
        this.pageIds[w] = this.pageIds[r]!;
        this.steps[w] = this.steps[r]!;
        this.md[w] = this.md[r]!;
        this.slotOf.set(this.chunkIds[w]!, w);
      }
      w++;
    }
    this.n = w;
    this.dead = 0;
  }

  /**
   * Best-matching chunk per page, sorted by similarity (best first). Pages must reach minSim
   * (raw mode) or minZ standard deviations above this query's mean similarity (centered mode).
   *
   * With >= CENTER_MIN_VECTORS live vectors, similarity is cosine between corpus-centered
   * vectors, (q-mu).(d-mu) / (|q-mu| |d-mu|), with mu the corpus mean. e5 embeddings share a
   * large common direction, so raw cosine lets short generic pages ("Log in", "Unsubscribe")
   * look ~0.83 similar to every query and outrank real matches. Measured on 13k real history
   * titles, centering moved planted relevant pages from rank #727 / #143 / #7178 to #1 / #1 / #3.
   * Expanded with |d| = |q| = 1: numerator q.d - q.mu - mu.d + |mu|^2, |d-mu| = sqrt(1 - 2 mu.d + |mu|^2),
   * so per slot only mu.d (md, cached) is needed on top of the raw dot product.
   *
   * chunkPenalty > 0 lowers each page's score by chunkPenalty x (expected max of k standard
   * normals) x sd, k = the page's vector count: the best of many chunks is inflated by chance.
   * Centered mode only: a small index's sd is too noisy to scale by.
   * The minSim/minZ cut applies to the raw best chunk; callers re-filter the adjusted scores.
   */
  search(query: ArrayLike<number>, minSim: number, minZ = -Infinity, chunkPenalty = 0): VectorHit[] {
    const d = this.dim;
    if (query.length !== d) throw new Error(`query vector must have ${d} dims, got ${query.length}`);
    const q = Float64Array.from(query);
    const { vecs, pageIds, steps, sims } = this;
    const n = this.n;
    const centered = this.size >= CENTER_MIN_VECTORS;
    let qMu = 0,
      qNorm = 1,
      muSq = 0;
    if (centered) {
      this.refreshMean(this.size);
      const mu = this.mu!;
      muSq = this.muSq;
      for (let j = 0; j < d; j++) qMu += q[j]! * mu[j]!;
      qNorm = Math.sqrt(Math.max(1e-9, 1 - 2 * qMu + muSq));
    }
    const md = this.md;
    let live = 0,
      sum = 0,
      sumSq = 0;
    for (let s = 0; s < n; s++) {
      if (pageIds[s]! < 0) {
        sims[s] = -2;
        continue;
      }
      const o = s * d;
      // 4 accumulators: ~1.5x faster than a single one in V8.
      let a = 0,
        b = 0,
        c = 0,
        e = 0;
      let j = 0;
      for (; j + 3 < d; j += 4) {
        a += q[j]! * vecs[o + j]!;
        b += q[j + 1]! * vecs[o + j + 1]!;
        c += q[j + 2]! * vecs[o + j + 2]!;
        e += q[j + 3]! * vecs[o + j + 3]!;
      }
      for (; j < d; j++) a += q[j]! * vecs[o + j]!;
      let sim = (a + b + c + e) * steps[s]!;
      if (centered) {
        const m = md[s]!;
        sim = (sim - qMu - m + muSq) / (qNorm * Math.sqrt(Math.max(1e-9, 1 - 2 * m + muSq)));
      }
      sims[s] = sim;
      live++;
      sum += sim;
      sumSq += sim * sim;
    }
    const mean = live ? sum / live : 0;
    this.lastStats = { n: live, mean, sd: live ? Math.sqrt(Math.max(0, sumSq / live - mean * mean)) : 0, centered };
    // Raw cosine values aren't comparable across queries once centered; filter by z instead.
    const cut = centered ? this.lastStats.mean + minZ * this.lastStats.sd : minSim;
    const best = new Map<number, VectorHit>();
    for (let s = 0; s < n; s++) {
      const sim = sims[s]!;
      if (sim < cut) continue;
      const pageId = pageIds[s]!;
      const cur = best.get(pageId);
      if (!cur) best.set(pageId, { pageId, chunkId: this.chunkIds[s]!, sim });
      else if (sim > cur.sim) {
        cur.sim = sim;
        cur.chunkId = this.chunkIds[s]!;
      }
    }
    if (chunkPenalty > 0 && centered) {
      const unit = chunkPenalty * this.lastStats.sd;
      for (const h of best.values()) h.sim -= unit * EXPECTED_MAX[Math.min(10, this.chunkCount(h.pageId))]!;
    }
    return [...best.values()].sort((x, y) => y.sim - x.sim || y.pageId - x.pageId);
  }
}
