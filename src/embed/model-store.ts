// Download / check / remove the pinned embedding model in Cache Storage. Runs in the engine host
// (offscreen document on Chromium, background page on Firefox). This is the only code in the
// extension that talks to the network, and only to the URLs from model-files.ts.
import { MODEL_CACHE, MODEL_FILES, MODEL_TOTAL_BYTES, modelFileUrl, type ModelFile } from './model-files';

export interface DownloadProgress {
  loaded: number;
  total: number;
}

export interface ModelStoreDeps {
  caches: CacheStorage;
  fetch: typeof fetch;
  digest?: (data: Uint8Array) => Promise<string>; // hex sha256
}

/** Error with a message meant for people (shown in settings / onboarding). */
export class ModelDownloadError extends Error {}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultDeps(): ModelStoreDeps {
  return { caches: globalThis.caches, fetch: globalThis.fetch.bind(globalThis) };
}

async function cachedSize(cache: Cache, f: ModelFile): Promise<number | null> {
  const res = await cache.match(modelFileUrl(f.path));
  if (!res) return null;
  const len = Number(res.headers.get('content-length'));
  return Number.isFinite(len) && len > 0 ? len : (await res.arrayBuffer()).byteLength;
}

/** True when every model file is in Cache Storage with the expected size. */
export async function isModelCached(deps: ModelStoreDeps = defaultDeps()): Promise<boolean> {
  try {
    if (!(await deps.caches.has(MODEL_CACHE))) return false;
    const cache = await deps.caches.open(MODEL_CACHE);
    for (const f of MODEL_FILES) if ((await cachedSize(cache, f)) !== f.size) return false;
    return true;
  } catch {
    return false;
  }
}

export async function removeModel(deps: ModelStoreDeps = defaultDeps()): Promise<void> {
  await deps.caches.delete(MODEL_CACHE);
}

function humanError(e: unknown, file: string): ModelDownloadError {
  if (e instanceof ModelDownloadError) return e;
  const name = (e as { name?: string })?.name;
  const msg = String((e as Error)?.message ?? e);
  if (name === 'AbortError') return new ModelDownloadError('Download cancelled.');
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) {
    return new ModelDownloadError(`Not enough free disk space for the search model (about ${Math.round(MODEL_TOTAL_BYTES / 1e6)} MB).`);
  }
  if (e instanceof TypeError || /network|failed to fetch|load failed/i.test(msg)) {
    return new ModelDownloadError(`Couldn't reach huggingface.co to download the search model (${file}). Check your connection and try again.`);
  }
  return new ModelDownloadError(`Search model download failed (${file}): ${msg}`);
}

/**
 * Fetch every missing file, verify size + SHA-256, store it. Files already cached are kept, so a
 * retry after an error resumes with the next file. `onProgress` gets bytes across all files.
 */
export async function downloadModel(
  opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal },
  deps: ModelStoreDeps = defaultDeps(),
): Promise<void> {
  const digest = deps.digest ?? sha256Hex;
  let done = 0;
  const report = (extra: number) => opts.onProgress?.({ loaded: done + extra, total: MODEL_TOTAL_BYTES });
  let cache: Cache;
  try {
    cache = await deps.caches.open(MODEL_CACHE);
  } catch (e) {
    throw humanError(e, 'cache');
  }
  report(0);
  for (const f of MODEL_FILES) {
    try {
      if ((await cachedSize(cache, f)) === f.size) {
        done += f.size;
        report(0);
        continue;
      }
      const res = await deps.fetch(modelFileUrl(f.path), { signal: opts.signal, credentials: 'omit', cache: 'no-store' });
      if (!res.ok) throw new ModelDownloadError(`The model server answered HTTP ${res.status} for ${f.path}. Try again later.`);
      const buf = new Uint8Array(f.size);
      let got = 0;
      const reader = res.body!.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (got + value.byteLength > f.size) throw new ModelDownloadError(`${f.path} is larger than expected; download refused.`);
        buf.set(value, got);
        got += value.byteLength;
        report(got);
      }
      if (got !== f.size) throw new ModelDownloadError(`${f.path} arrived incomplete (${got} of ${f.size} bytes). Try again.`);
      if ((await digest(buf)) !== f.sha256) throw new ModelDownloadError(`${f.path} failed its integrity check; it was not saved. Try again.`);
      await cache.put(
        modelFileUrl(f.path),
        new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(f.size) } }),
      );
      done += f.size;
      report(0);
    } catch (e) {
      throw humanError(e, f.path);
    }
  }
}
