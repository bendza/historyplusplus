// Read another browser's history database (Chromium `History`, Firefox `places.sqlite`,
// Safari `History.db`) into visit rows for the engine's importVisits op. Runs fully on device.
import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Transition } from '../shared/protocol';

export type HistoryKind = 'chromium' | 'firefox' | 'safari';

export interface ImportedVisit {
  url: string;
  title?: string;
  ts: number; // epoch ms
  transition?: Transition;
}

// Chromium stores microseconds since 1601-01-01; Safari seconds since 2001-01-01.
const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000;
const SAFARI_EPOCH_OFFSET_S = 978_307_200;

// Chromium core transition = transition & 0xff. Subframes are not real page visits.
const CHROMIUM_TRANSITIONS = ['link', 'typed', 'auto_bookmark', 'auto_subframe', 'manual_subframe', 'generated', 'auto_toplevel', 'form_submit', 'reload', 'keyword', 'keyword_generated'];
// Firefox visit_type; 4 embed, 7 download, 8 framed link are skipped.
const FIREFOX_TRANSITIONS: Record<number, string> = { 1: 'link', 2: 'typed', 3: 'auto_bookmark', 5: 'link', 6: 'link', 9: 'reload' };

export function detectKind(db: Database): HistoryKind | null {
  const tables = new Set(db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table'") as string[]);
  if (tables.has('urls') && tables.has('visits')) return 'chromium';
  if (tables.has('moz_places') && tables.has('moz_historyvisits')) return 'firefox';
  if (tables.has('history_items') && tables.has('history_visits')) return 'safari';
  return null;
}

export function readVisits(db: Database, kind: HistoryKind): ImportedVisit[] {
  const out: ImportedVisit[] = [];
  if (kind === 'chromium') {
    db.exec({
      sql: 'SELECT u.url, u.title, v.visit_time, v.transition FROM visits v JOIN urls u ON u.id = v.url ORDER BY v.visit_time',
      rowMode: 'array',
      callback: (r) => {
        const core = Number(r[3]) & 0xff;
        if (core === 3 || core === 4) return;
        out.push({ url: String(r[0]), title: (r[1] as string) || undefined, ts: Math.round(Number(r[2]) / 1000 - WEBKIT_EPOCH_OFFSET_MS), transition: CHROMIUM_TRANSITIONS[core] });
      },
    });
  } else if (kind === 'firefox') {
    db.exec({
      sql: 'SELECT p.url, p.title, v.visit_date, v.visit_type FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id ORDER BY v.visit_date',
      rowMode: 'array',
      callback: (r) => {
        const transition = FIREFOX_TRANSITIONS[Number(r[3])];
        if (!transition) return;
        out.push({ url: String(r[0]), title: (r[1] as string) || undefined, ts: Math.round(Number(r[2]) / 1000), transition });
      },
    });
  } else {
    db.exec({
      sql: 'SELECT i.url, v.title, v.visit_time FROM history_visits v JOIN history_items i ON i.id = v.history_item ORDER BY v.visit_time',
      rowMode: 'array',
      callback: (r) => {
        out.push({ url: String(r[0]), title: (r[1] as string) || undefined, ts: Math.round((Number(r[2]) + SAFARI_EPOCH_OFFSET_S) * 1000), transition: 'link' });
      },
    });
  }
  return out.filter((v) => v.ts > 0 && /^https?:/i.test(v.url));
}

/**
 * Open a copied history file as an in-memory database. Browsers keep these files in
 * WAL mode; header bytes 18/19 are reset to legacy so the deserialized copy opens without a -wal file.
 */
export function openHistoryBytes(sqlite3: Awaited<ReturnType<typeof import('@sqlite.org/sqlite-wasm').default>>, bytes: Uint8Array): Database {
  const copy = new Uint8Array(bytes);
  if (copy.length > 19 && copy[18] === 2) copy[18] = copy[19] = 1;
  const db = new sqlite3.oo1.DB();
  const p = sqlite3.wasm.allocFromTypedArray(copy);
  const { capi } = sqlite3;
  const rc = capi.sqlite3_deserialize(db.pointer!, 'main', p, copy.length, copy.length, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
  if (rc) {
    db.close();
    throw new Error(`Not a readable SQLite file (code ${rc})`);
  }
  // The file is untrusted: read it only, and don't let its schema (views, triggers) run functions.
  db.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');
  return db;
}
