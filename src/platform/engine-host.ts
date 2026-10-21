// Engine host: the SQLite engine worker + the local embedding worker + the on-demand model.
// Runs in the offscreen document (Chromium) or the persistent background page (Firefox).
// The only network access is the one-time model download (src/embed/model-store.ts).
import {
  EMBED_MODEL,
  type EngineOp,
  type EngineOps,
  type EngineRequest,
  type EngineResponse,
  type IndexStatus,
  type ModelState,
  type SearchQuery,
  type Settings,
} from '../shared/protocol';
import type { WorkerIn, WorkerOut } from '../engine/engine.worker';
import { EmbedClient } from '../embed/client';
import { Indexer, QueryEmbedder, type Embedder } from '../embed/indexer';
import { MODEL_TOTAL_BYTES } from '../embed/model-files';
import { downloadModel, isModelCached, removeModel } from '../embed/model-store';
import { PriorityGate } from '../embed/sched';
import type { BackupBlob, HostApi } from './host-api';
// Vite `?worker` imports (module workers per vite worker.format 'es').
import EngineWorker from '../engine/engine.worker.ts?worker';
import EmbedWorker from '../embed/embed.worker.ts?worker';

export const PROGRESS_INTERVAL_MS = 250; // ~4 model progress reports per second

type EmbedderStatus = NonNullable<IndexStatus['embedder']>;

export interface EngineHostOptions {
  /** Model state changed (download progress is throttled to PROGRESS_INTERVAL_MS). */
  onModelState(state: ModelState, init: boolean): void;
}

/** Forwards to the current EmbedClient; `remove` swaps in a fresh worker to drop the loaded model. */
class SwappableEmbedder implements Embedder {
  private client = new EmbedClient(new EmbedWorker());
  get ready() {
    return this.client.ready;
  }
  get state() {
    return this.client.state;
  }
  get backend() {
    return this.client.backend;
  }
  get error() {
    return this.client.error;
  }
  load() {
    return this.client.load();
  }
  embed(texts: string[], opts?: { priority?: boolean }) {
    return this.client.embed(texts, opts);
  }
  reset() {
    this.client.terminate();
    this.client = new EmbedClient(new EmbedWorker());
  }
}

export function createEngineHost(opts: EngineHostOptions): HostApi {
  // ---- engine worker ----
  const worker = new EngineWorker();
  worker.onerror = (e) => console.error('[history++] engine worker error', e);
  let nextId = 1;
  const pending = new Map<number, (res: EngineResponse, raw?: Uint8Array) => void>();
  worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const { id, res, raw } = ev.data;
    pending.get(id)?.(res, raw);
    pending.delete(id);
  };
  function call(req: EngineRequest): Promise<EngineResponse> {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      worker.postMessage({ id, req } satisfies WorkerIn);
    });
  }
  /** The database file, transferred from the worker (never base64, never runtime messaging). */
  function exportRaw(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (res, raw) => (res.ok && raw ? resolve(raw) : reject(new Error(res.ok ? 'exportRaw: no data' : res.error))));
      worker.postMessage({ id, exportRaw: true } satisfies WorkerIn);
    });
  }
  async function engine<K extends EngineOp>(op: K, args: EngineOps[K]['args']): Promise<EngineOps[K]['result']> {
    const res = (await call({ op, args } as EngineRequest)) as EngineResponse<K>;
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }

  // ---- local embeddings (only once the model is downloaded) ----
  let settings: Settings | null = null;
  const model: ModelState = { status: 'not-downloaded', loaded: 0, total: MODEL_TOTAL_BYTES, downloadedAt: null };
  let modelKnown = false; // Cache Storage checked
  const embedder = new SwappableEmbedder();
  const gate = new PriorityGate();
  const indexer = new Indexer({
    embedder,
    gate,
    embedPending: async (limit) => (await engine('embedPending', { limit })).items,
    storeEmbeddings: async (items) => void (await engine('storeEmbeddings', { model: EMBED_MODEL, items })),
  });
  const semanticOn = () => settings?.semanticSearch === true && model.status === 'ready';
  const queries = new QueryEmbedder({ embedder, gate, enabled: semanticOn });
  const syncIndexer = () => {
    if (settings && modelKnown) indexer.setEnabled(semanticOn());
  };

  let lastReport = 0;
  let reportTimer: ReturnType<typeof setTimeout> | undefined;
  function reportModel(force = false, init = false) {
    clearTimeout(reportTimer);
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) {
      reportTimer = setTimeout(() => reportModel(true), PROGRESS_INTERVAL_MS - (now - lastReport));
      return;
    }
    lastReport = now;
    opts.onModelState({ ...model }, init);
  }

  let download: { promise: Promise<void>; abort: AbortController } | null = null;

  function startDownload(): Promise<void> {
    if (download) return download.promise;
    if (model.status === 'ready') return Promise.resolve();
    const abort = new AbortController();
    Object.assign(model, { status: 'downloading', loaded: 0, total: 0, error: undefined });
    delete model.error;
    syncIndexer();
    reportModel(true);
    const promise = downloadModel({
      signal: abort.signal,
      onProgress: (p) => {
        model.loaded = p.loaded;
        model.total = p.total;
        reportModel();
      },
    })
      .then(() => {
        Object.assign(model, { status: 'ready', loaded: model.total, downloadedAt: Date.now() });
        syncIndexer();
        indexer.wake();
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return; // removed meanwhile; remove() reported the new state
        model.status = 'error';
        model.error = (e as Error)?.message ?? String(e);
        console.warn('[history++] model download failed:', model.error);
      })
      .finally(() => {
        if (download?.abort === abort) download = null;
        if (!abort.signal.aborted) reportModel(true);
      });
    download = { promise, abort };
    return promise;
  }

  async function remove(): Promise<void> {
    download?.abort.abort();
    download = null;
    Object.assign(model, { status: 'not-downloaded', loaded: 0, total: MODEL_TOTAL_BYTES, downloadedAt: null });
    delete model.error;
    syncIndexer();
    embedder.reset(); // drop the model from memory; queries fall back to words
    await removeModel();
    reportModel(true);
  }

  function embedderStatus(): EmbedderStatus {
    if (model.status === 'ready' || !modelKnown) return indexer.status();
    if (settings && !settings.semanticSearch) return { state: 'disabled', backend: null };
    if (model.status === 'downloading') {
      return { state: 'downloading', backend: null, download: { loaded: model.loaded, total: model.total } };
    }
    if (model.status === 'error') return { state: 'error', backend: null, error: model.error };
    return { state: 'not-downloaded', backend: null };
  }

  // Internal ops: only the host drives the embedding queue.
  const INTERNAL_OPS: ReadonlySet<string> = new Set<EngineOp>(['embedPending', 'storeEmbeddings']);

  async function handle(req: EngineRequest): Promise<EngineResponse> {
    if (INTERNAL_OPS.has(req.op)) return { ok: false, error: `engine ${req.op}: internal op` };
    switch (req.op) {
      case 'search': {
        const args = { ...(req.args as SearchQuery) };
        delete args.queryVector; // only ever set here
        const vec = await queries.vectorFor(args);
        if (vec) args.queryVector = vec;
        return call({ op: 'search', args });
      }
      case 'indexStatus': {
        const res = (await call(req)) as EngineResponse<'indexStatus'>;
        if (res.ok) res.result = { ...res.result, embedder: embedderStatus() };
        return res;
      }
      case 'upsertText': {
        const res = (await call(req)) as EngineResponse<'upsertText'>;
        if (res.ok && res.result?.changed) indexer.wake(); // new text to chunk + embed
        return res;
      }
      case 'importVisits':
      case 'recordVisit': {
        const res = await call(req);
        if (res.ok && res.result) indexer.wake(); // new pages to chunk + embed
        return res;
      }
      default:
        return call(req);
    }
  }

  async function backupBlob(): Promise<BackupBlob> {
    const data = await exportRaw();
    const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/vnd.sqlite3' }));
    return { url, bytes: data.byteLength };
  }

  void isModelCached().then((cached) => {
    if (model.status === 'not-downloaded' && !download) {
      model.status = cached ? 'ready' : 'not-downloaded';
      if (cached) model.loaded = model.total = MODEL_TOTAL_BYTES;
    }
    modelKnown = true;
    syncIndexer();
    reportModel(true, true);
  });
  indexer.start();

  return {
    engine: handle,
    settings(s) {
      settings = s;
      syncIndexer();
    },
    model: (action) => (action === 'download' ? startDownload() : remove()),
    backupBlob,
    revokeBlob: (url) => URL.revokeObjectURL(url),
  };
}
