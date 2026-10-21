/// <reference lib="webworker" />
// Engine worker: sole owner of the SQLite database. Lives inside the offscreen
// document. Protocol: in {id, req: EngineRequest} -> out {id, res: EngineResponse}.
// Worker-only extra for backups that must not cross runtime messaging: in {id, exportRaw: true}
// -> out {id, res: {ok: true, result: {bytes: ''}}, raw: Uint8Array} (the database file,
// transferred, never base64) or {id, res: {ok: false, error}}.
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { RESTORE_OPFS_FILE, type EngineRequest, type EngineResponse } from '../shared/protocol';
import { HistoryDb } from './db';
// Explicit asset import: Vite fails to resolve the library's own
// `new URL('sqlite3.wasm', import.meta.url)` (repo path contains '++'), so we
// hand the emitted URL to Emscripten via locateFile. no-inline: Firefox's MV2 background is
// built in Vite lib mode, which would inline it as a data: URL that CSP connect-src blocks.
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url&no-inline';

export type WorkerIn = { id: number; req: EngineRequest; exportRaw?: undefined } | { id: number; exportRaw: true; req?: undefined };
export interface WorkerOut {
  id: number;
  res: EngineResponse;
  raw?: Uint8Array; // exportRaw only
}

const DB_FILE = '/history.sqlite3';
const POOL_NAME = 'history-pp';
// The SAH-pool VFS keeps its files in this OPFS directory (the library default, "." + name;
// changing it would orphan existing data). Restore uploads live in the plain OPFS root.
const POOL_DIR = '.' + POOL_NAME;
if (RESTORE_OPFS_FILE === POOL_DIR || RESTORE_OPFS_FILE.includes('/')) throw new Error('RESTORE_OPFS_FILE must be a plain file outside the pool');

async function open(): Promise<HistoryDb> {
  // We only use the SAH-pool VFS. Skip the default "opfs"/"opfs-wl" VFSes: they need
  // SharedArrayBuffer + a proxy worker we don't ship, and just log scary errors.
  (globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, 'opfs-vfs': true, 'opfs-wl': true } },
  };
  // init() accepts Emscripten module overrides at runtime though its .d.ts says no args.
  const init = sqlite3InitModule as unknown as (m: { locateFile: (f: string) => string }) => ReturnType<typeof sqlite3InitModule>;
  const sqlite3 = await init({ locateFile: (f) => (f === 'sqlite3.wasm' ? wasmUrl : f) });
  let db: Database;
  try {
    // SAH-pool VFS: sync OPFS access handles, no COOP/COEP needed. Needs a dedicated worker.
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
    db = new pool.OpfsSAHPoolDb(DB_FILE);
  } catch (e) {
    console.error(
      '[history++] OPFS unavailable, using an IN-MEMORY database. NOTHING WILL BE PERSISTED.',
      e,
    );
    db = new sqlite3.oo1.DB(':memory:', 'c');
  }
  // runs migrations; sqlite3 lets restoreDb stage a backup in a separate in-memory database
  const h = new HistoryDb(db, () => sqlite3.capi.sqlite3_js_db_export(db), { sqlite3 });
  console.info(`[history++] engine ready: sqlite ${sqlite3.version.libVersion}, vfs ${db.dbVfsName()}`);
  return h;
}

const ready = open();
ready.catch((e) => console.error('[history++] engine init failed', e));

/**
 * restoreDb with opfsFile: read the upload the UI wrote to the OPFS root, restore it like
 * bytes, and always delete the upload afterwards. Only RESTORE_OPFS_FILE is accepted.
 */
async function restoreFromOpfs(h: HistoryDb, name: string): Promise<EngineResponse> {
  if (name !== RESTORE_OPFS_FILE) return { ok: false, error: `restore: unexpected OPFS file ${JSON.stringify(name)}` };
  let root: FileSystemDirectoryHandle | null = null;
  try {
    root = await navigator.storage.getDirectory();
    let data: Uint8Array;
    try {
      const file = await (await root.getFileHandle(name)).getFile();
      data = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      return { ok: false, error: `restore: cannot read the uploaded file (${e instanceof Error ? e.message : String(e)})` };
    }
    try {
      return { ok: true, result: h.restoreBytes(data) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  } finally {
    await root?.removeEntry(name).catch(() => {});
  }
}

const post = (out: WorkerOut, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(out, transfer);

// Single writer: requests run strictly one after another.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data ?? ({} as WorkerIn);
  const { id } = msg;
  queue = queue.then(async () => {
    let h: HistoryDb;
    try {
      h = await ready;
    } catch (e) {
      post({ id, res: { ok: false, error: `engine init failed: ${e instanceof Error ? e.message : String(e)}` } });
      return;
    }
    if (msg.exportRaw) {
      try {
        let raw = h.exportBytes();
        // Transfer only a buffer that is exactly this file (never a view into the wasm heap).
        if (raw.byteOffset !== 0 || raw.buffer.byteLength !== raw.byteLength) raw = raw.slice();
        post({ id, res: { ok: true, result: { bytes: '' } }, raw }, [raw.buffer]);
      } catch (e) {
        post({ id, res: { ok: false, error: e instanceof Error ? e.message : String(e) } });
      }
      return;
    }
    const req = msg.req;
    if (req?.op === 'restoreDb' && (req.args as { opfsFile?: string })?.opfsFile && !(req.args as { bytes?: string }).bytes) {
      post({ id, res: await restoreFromOpfs(h, (req.args as { opfsFile: string }).opfsFile) });
      return;
    }
    post({ id, res: h.handle(req) });
  });
};
