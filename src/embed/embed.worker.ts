/// <reference lib="webworker" />
// Embedding worker: runs multilingual-e5-small (q8) with transformers.js inside the engine host
// (offscreen document / Firefox background page). Model files come from Cache Storage, where the
// host's one-time download (model-store.ts) put them; the ONNX runtime comes from the extension
// package (/ort/). transformers.js remote loading and the jsDelivr wasm default are switched off,
// so this worker never touches the network.
//
// Protocol: in EmbedIn -> out EmbedOut. Jobs run one at a time; `priority` jobs (search
// queries) jump ahead of queued indexing jobs.
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBED_DIM, EMBED_MODEL } from '../shared/protocol';
import { MODEL_CACHE, MODEL_HOST, MODEL_REVISION } from './model-files';
import { clipText, planBatches } from './sched';

export type Backend = 'webgpu' | 'wasm';

export type EmbedIn =
  | { id: number; type: 'load'; device?: Backend } // device: force a backend (benchmarks)
  | { id: number; type: 'embed'; texts: string[]; priority?: boolean };

export type EmbedOut =
  | { id: number; vectors: Float32Array[] }
  | { id: number; loaded: { backend: Backend; ms: number } }
  | { id: number; error: string }
  | { type: 'status'; state: 'loading' | 'ready' | 'error'; backend: Backend | null; error?: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const ORIGIN = scope.location.origin; // chrome-extension://<id>

// ---- transformers.js / onnxruntime-web environment: cache only ----
env.allowRemoteModels = false;
// Cache lookups happen before local/remote; transformers.js insists one of the two is on. The
// local path doesn't exist in the package, so an uncached file fails instead of being fetched.
env.allowLocalModels = true;
env.localModelPath = `${ORIGIN}/models/`;
// Files live in Cache Storage under their pinned huggingface.co resolve URL (model-store.ts).
env.useBrowserCache = true;
env.cacheKey = MODEL_CACHE;
env.remoteHost = MODEL_HOST;
// Pin the revision in the URL template too: some lookups (get_pipeline_files) ignore the
// `revision` option and would ask for .../resolve/main/..., which isn't cached.
env.remotePathTemplate = `{model}/resolve/${MODEL_REVISION}/`;
// Preloading via the Cache API would turn the glue into a blob: URL that 'script-src self' blocks.
env.useWasmCache = false;
const ortWasm = env.backends.onnx.wasm!;
ortWasm.wasmPaths = {
  mjs: `${ORIGIN}/ort/ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${ORIGIN}/ort/ort-wasm-simd-threaded.asyncify.wasm`,
};
// Threads need SharedArrayBuffer, i.e. cross-origin isolation (COOP/COEP in the manifest).
// Use about a third of the cores, max 4, so background indexing never takes over the machine.
const THREADED = scope.crossOriginIsolated;
ortWasm.numThreads = THREADED ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 3))) : 1;
ortWasm.proxy = false;

const MAX_BATCH = 8; // inputs per forward pass inside one job

let extractor: FeatureExtractionPipeline | null = null;
let backend: Backend | null = null;
let loading: Promise<void> | null = null;

function status(state: 'loading' | 'ready' | 'error', error?: string) {
  scope.postMessage({ type: 'status', state, backend, error } satisfies EmbedOut);
}

interface GpuAdapterLike {
  isFallbackAdapter?: boolean;
  info?: { isFallbackAdapter?: boolean };
}

/** A real (hardware) WebGPU adapter. Software fallbacks (SwiftShader) are slower than wasm. */
async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return false;
  try {
    const a = await gpu.requestAdapter();
    return !!a && !(a.info?.isFallbackAdapter ?? a.isFallbackAdapter);
  } catch {
    return false;
  }
}

async function create(device: Backend): Promise<FeatureExtractionPipeline> {
  const p = (await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8', device, revision: MODEL_REVISION })) as FeatureExtractionPipeline;
  // Warm up (and validate the backend actually runs) before declaring it usable.
  const out = await p(['query: warmup'], { pooling: 'mean', normalize: true });
  if (out.dims.at(-1) !== EMBED_DIM) throw new Error(`unexpected embedding size ${String(out.dims)}`);
  return p;
}

function load(device?: Backend): Promise<void> {
  if (extractor) return Promise.resolve();
  if (loading) return loading;
  status('loading');
  loading = (async () => {
    // Measured (Apple M-series, q8 model): threaded wasm 10.5 chunks/s + 4 ms queries vs WebGPU
    // 8 chunks/s + 28 ms (int8 ops fall back to CPU). So WebGPU only when wasm is single-threaded.
    if (device === 'webgpu' || (device === undefined && !THREADED && (await hasWebGpu()))) {
      try {
        extractor = await create('webgpu');
        backend = 'webgpu';
      } catch (e) {
        console.warn('[history++] embedder: WebGPU init failed, falling back to wasm', e);
      }
    }
    if (!extractor) {
      extractor = await create('wasm');
      backend = 'wasm';
    }
    status('ready');
  })().catch((e: unknown) => {
    loading = null; // allow a later retry
    const msg = e instanceof Error ? e.message : String(e);
    status('error', msg);
    throw e;
  });
  return loading;
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  await load();
  const out: Float32Array[] = new Array(texts.length);
  const clipped = texts.map((t) => clipText(t));
  for (const group of planBatches(clipped.map((t) => t.length), MAX_BATCH)) {
    const t = await extractor!(group.map((i) => clipped[i]!), { pooling: 'mean', normalize: true });
    const data = t.data as Float32Array;
    const dim = t.dims.at(-1)!;
    group.forEach((idx, row) => {
      out[idx] = data.slice(row * dim, (row + 1) * dim); // own buffer, transferable
    });
    t.dispose();
  }
  return out;
}

// ---- job queue: one at a time, priority first ----
const queue: Extract<EmbedIn, { type: 'embed' }>[] = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      // Inference blocks this thread, so messages that arrived meanwhile (e.g. a priority
      // query) are still undispatched tasks: yield one macrotask before picking the next job.
      await new Promise((r) => setTimeout(r, 0));
      const job = queue.shift();
      if (!job) break;
      try {
        const vectors = await embed(job.texts);
        scope.postMessage({ id: job.id, vectors } satisfies EmbedOut, vectors.map((v) => v.buffer as ArrayBuffer));
      } catch (e) {
        scope.postMessage({ id: job.id, error: e instanceof Error ? e.message : String(e) } satisfies EmbedOut);
      }
    }
  } finally {
    running = false;
  }
}

scope.onmessage = (ev: MessageEvent<EmbedIn>) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    const t0 = performance.now();
    load(msg.device).then(
      () => scope.postMessage({ id: msg.id, loaded: { backend: backend!, ms: Math.round(performance.now() - t0) } } satisfies EmbedOut),
      (e: unknown) => scope.postMessage({ id: msg.id, error: e instanceof Error ? e.message : String(e) } satisfies EmbedOut),
    );
    return;
  }
  if (msg.type === 'embed') {
    if (msg.priority) {
      // Behind other priority jobs, ahead of indexing jobs.
      const at = queue.findIndex((j) => !j.priority);
      queue.splice(at === -1 ? queue.length : at, 0, msg);
    } else queue.push(msg);
    void pump();
  }
};
