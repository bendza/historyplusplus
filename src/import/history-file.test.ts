import { describe, expect, it, beforeAll } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { detectKind, openHistoryBytes, readVisits } from './history-file';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
let sqlite3: Sqlite3;
beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });

function bytesOf(sql: string): Uint8Array {
  const db = new sqlite3.oo1.DB(':memory:');
  db.exec(sql);
  const bytes = sqlite3.capi.sqlite3_js_db_export(db);
  db.close();
  return bytes;
}

describe('history file import', () => {
  it('reads Chromium History, skipping subframes and converting time', () => {
    const bytes = bytesOf(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT);
      CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER);
      INSERT INTO urls VALUES (1,'https://example.com/a','A'),(2,'https://ads.example/frame','F'),(3,'chrome://settings','S');
      INSERT INTO visits VALUES (1,1,13370000000000000,${0x30000001}),(2,2,13370000000000000,3),(3,3,13370000000000000,1);`);
    bytes[18] = bytes[19] = 2; // simulate WAL-mode header
    const db = openHistoryBytes(sqlite3, bytes);
    expect(detectKind(db)).toBe('chromium');
    const v = readVisits(db, 'chromium');
    expect(v).toEqual([{ url: 'https://example.com/a', title: 'A', ts: 13370000000000 - 11644473600000, transition: 'typed' }]);
  });

  it('reads Firefox places.sqlite', () => {
    const db = openHistoryBytes(sqlite3, bytesOf(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT);
      CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);
      INSERT INTO moz_places VALUES (1,'https://mozilla.org/','Moz');
      INSERT INTO moz_historyvisits VALUES (1,1,1700000000000000,2),(2,1,1700000000000001,4);`));
    expect(detectKind(db)).toBe('firefox');
    expect(readVisits(db, 'firefox')).toEqual([{ url: 'https://mozilla.org/', title: 'Moz', ts: 1700000000000, transition: 'typed' }]);
  });

  it('reads Safari History.db and rejects unknown files', () => {
    const db = openHistoryBytes(sqlite3, bytesOf(`CREATE TABLE history_items(id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE history_visits(id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);
      INSERT INTO history_items VALUES (1,'https://apple.com/'); INSERT INTO history_visits VALUES (1,1,700000000.5,'Apple');`));
    expect(detectKind(db)).toBe('safari');
    expect(readVisits(db, 'safari')[0]!.ts).toBe((700000000.5 + 978307200) * 1000);
    expect(detectKind(openHistoryBytes(sqlite3, bytesOf('CREATE TABLE x(a);')))).toBeNull();
  });

  it.runIf(process.env.REAL_HISTORY_DIR)('reads real browser history copies', async () => {
    const fs = await import('node:fs');
    for (const f of fs.readdirSync(process.env.REAL_HISTORY_DIR!)) {
      const db = openHistoryBytes(sqlite3, fs.readFileSync(`${process.env.REAL_HISTORY_DIR}/${f}`));
      const kind = detectKind(db);
      const v = kind ? readVisits(db, kind) : [];
      const d = (t: number) => new Date(t).toISOString().slice(0, 10);
      console.log(`${f}: ${kind} visits=${v.length} range=${v.length ? `${d(v[0]!.ts)}..${d(v.at(-1)!.ts)}` : '-'}`);
      expect(kind).toBe('chromium');
    }
  });
});
