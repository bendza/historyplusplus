import { describe, expect, it } from 'vitest';
import { MODEL_CACHE, MODEL_FILES, MODEL_TOTAL_BYTES, modelFileUrl } from './model-files';
import { downloadModel, isModelCached, removeModel, type ModelStoreDeps } from './model-store';

// In-memory Cache Storage (Node has Response but no caches).
function memCaches() {
  const store = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    let m = store.get(name);
    if (!m) store.set(name, (m = new Map()));
    const c = {
      match: async (k: string) => m!.get(k)?.clone(),
      put: async (k: string, r: Response) => void m!.set(k, r),
    };
    return c as unknown as Cache;
  };
  return { store, caches: { open, has: async (n: string) => store.has(n), delete: async (n: string) => store.delete(n) } as unknown as CacheStorage };
}

// Fake server: serves bytes of the right length; digest fake maps length -> expected hash.
function fakeFetch(fail?: (url: string) => Response | Error | undefined) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const r = fail?.(url);
    if (r instanceof Error) throw r;
    if (r) return r;
    const file = MODEL_FILES.find((x) => modelFileUrl(x.path) === url)!;
    const body = new Uint8Array(Math.min(file.size, 4096));
    return new Response(new ReadableStream({
      start(c) {
        // Stream the declared size in pieces without allocating the whole 118 MB in tests.
        let left = file.size;
        while (left > 0) {
          const n = Math.min(left, body.length);
          c.enqueue(body.subarray(0, n));
          left -= n;
        }
        c.close();
      },
    }));
  }) as unknown as typeof fetch;
  return { f, urls };
}
const digest = async (d: Uint8Array) => MODEL_FILES.find((f) => f.size === d.byteLength)!.sha256;

describe('model store', () => {
  it('downloads every pinned file with aggregate progress, then reports cached', async () => {
    const { caches, store } = memCaches();
    const { f, urls } = fakeFetch();
    const deps: ModelStoreDeps = { caches, fetch: f, digest };
    expect(await isModelCached(deps)).toBe(false);
    const progress: number[] = [];
    await downloadModel({ onProgress: (p) => (expect(p.total).toBe(MODEL_TOTAL_BYTES), progress.push(p.loaded)) }, deps);
    expect(urls).toEqual(MODEL_FILES.map((x) => modelFileUrl(x.path)));
    expect(urls[0]).toMatch(/^https:\/\/huggingface\.co\/Xenova\/multilingual-e5-small\/resolve\/[0-9a-f]{40}\/config\.json$/);
    expect(progress.at(-1)).toBe(MODEL_TOTAL_BYTES);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1]!)).toBe(true);
    expect(await isModelCached(deps)).toBe(true);

    // Second run fetches nothing.
    const again = fakeFetch();
    await downloadModel({}, { caches, fetch: again.f, digest });
    expect(again.urls).toEqual([]);

    await removeModel(deps);
    expect(store.has(MODEL_CACHE)).toBe(false);
    expect(await isModelCached(deps)).toBe(false);
  });

  it('turns failures into human errors and resumes after them', async () => {
    const { caches } = memCaches();
    const big = modelFileUrl('onnx/model_quantized.onnx');
    const offline = fakeFetch((u) => (u === big ? new TypeError('Failed to fetch') : undefined));
    await expect(downloadModel({}, { caches, fetch: offline.f, digest })).rejects.toThrow(/Couldn't reach huggingface\.co/);
    const notFound = fakeFetch((u) => (u === big ? new Response('nope', { status: 404 }) : undefined));
    await expect(downloadModel({}, { caches, fetch: notFound.f, digest })).rejects.toThrow(/HTTP 404/);
    expect(notFound.urls).toEqual([big]); // the others were kept from the first attempt
    const badHash = fakeFetch();
    await expect(downloadModel({}, { caches, fetch: badHash.f, digest: async () => 'x' })).rejects.toThrow(/integrity/);
    expect(await isModelCached({ caches, fetch: badHash.f })).toBe(false);
  });
});
