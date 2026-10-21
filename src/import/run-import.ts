// UI-side import of another browser's history file. Parsing happens in this page
// (in-memory SQLite); visits go to the engine in chunks through the normal importVisits op.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import { isUrlAllowed } from '../shared/privacy';
import type { Settings } from '../shared/protocol';
import { detectKind, openHistoryBytes, readVisits, type HistoryKind } from './history-file';

const CHUNK = 2000;
/** The file is parsed in memory; years of heavy browsing are a few hundred MB at most. */
export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

export interface ImportProgress {
  file: string;
  kind: HistoryKind | null;
  done: number;
  total: number;
  inserted: number;
  skipped: number; // filtered by privacy rules
}

let sqlite3Promise: ReturnType<typeof sqlite3InitModule> | null = null;
function loadSqlite() {
  const init = sqlite3InitModule as unknown as (m: { locateFile: (f: string) => string }) => ReturnType<typeof sqlite3InitModule>;
  sqlite3Promise ??= init({ locateFile: (f) => (f === 'sqlite3.wasm' ? wasmUrl : f) });
  return sqlite3Promise;
}

export async function importHistoryFile(
  file: File,
  settings: Settings,
  importVisits: (visits: ReturnType<typeof readVisits>) => Promise<{ inserted: number }>,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportProgress> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`${file.name} is ${Math.round(file.size / 1024 / 1024)} MB; history files over 1 GB can't be imported`);
  }
  const sqlite3 = await loadSqlite();
  const db = openHistoryBytes(sqlite3, new Uint8Array(await file.arrayBuffer()));
  let all: ReturnType<typeof readVisits>;
  let kind: HistoryKind | null;
  try {
    kind = detectKind(db);
    if (!kind) throw new Error(`${file.name} is not a Chromium, Firefox or Safari history file`);
    all = readVisits(db, kind);
  } finally {
    db.close();
  }
  const allowed = all.filter((v) => isUrlAllowed(v.url, settings));
  const p: ImportProgress = { file: file.name, kind, done: 0, total: allowed.length, inserted: 0, skipped: all.length - allowed.length };
  onProgress({ ...p });
  for (let i = 0; i < allowed.length; i += CHUNK) {
    const chunk = allowed.slice(i, i + CHUNK);
    p.inserted += (await importVisits(chunk)).inserted;
    p.done += chunk.length;
    onProgress({ ...p });
  }
  return p;
}
