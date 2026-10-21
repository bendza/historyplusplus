import { describe, expect, it } from 'vitest';
import { BACKUP_KEEP } from '../shared/protocol';
import { BACKUP_FILE_RE, BACKUP_FILE_REGEX_SOURCE, backupFileName, isBackupDue, planPrune, runBackup, type BackupDeps } from './backup';

const file = (date: string, sep = '/') => `${sep === '/' ? '/Users/me/Downloads' : 'C:\\Users\\me\\Downloads'}${sep}history++${sep}history-plus-plus-${date}.sqlite3`;
const day = (i: number) => `2026-10-${String(i).padStart(2, '0')}`;

describe('backup file names', () => {
  it('formats local dates and matches both separators', () => {
    expect(backupFileName(new Date(2026, 0, 5, 23, 59))).toBe('history++/history-plus-plus-2026-01-05.sqlite3');
    expect(BACKUP_FILE_RE.exec(file('2026-10-14'))?.[1]).toBe('2026-10-14');
    expect(BACKUP_FILE_RE.exec(file('2026-10-14', '\\'))?.[1]).toBe('2026-10-14');
    expect(BACKUP_FILE_RE.test('/x/history-plus-plus-2026-10-14.sqlite3')).toBe(false);
    expect(new RegExp(BACKUP_FILE_REGEX_SOURCE).test(file('2026-10-14', '\\'))).toBe(true);
  });
});

describe('isBackupDue', () => {
  it('waits a day after install, then a day after each backup', () => {
    const H = 3_600_000;
    expect(isBackupDue(undefined, undefined, 100)).toBe(true);
    expect(isBackupDue(undefined, 0, 23 * H)).toBe(false);
    expect(isBackupDue(undefined, 0, 24 * H)).toBe(true);
    expect(isBackupDue({ lastAt: 10 * H, lastBytes: 1, lastFile: 'x', running: false }, 0, 30 * H)).toBe(false);
  });
});

describe('planPrune', () => {
  it('keeps the newest BACKUP_KEEP dates and deletes older files', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, filename: file(day(i + 1)), exists: true }));
    items.push({ id: 99, filename: '/Users/me/Downloads/other.sqlite3', exists: true });
    const plan = planPrune(items);
    expect(BACKUP_KEEP).toBe(7);
    expect(plan.removeFile.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(plan.eraseOnly).toEqual([]);
  });

  it('only erases duplicate rows of a kept (overwritten) file, and missing old files', () => {
    const items = [
      { id: 1, filename: file(day(14)), startTime: '2026-10-14T08:00:00Z' },
      { id: 2, filename: file(day(14)), startTime: '2026-10-14T20:00:00Z' },
      ...Array.from({ length: 7 }, (_, i) => ({ id: 10 + i, filename: file(day(i + 1)), exists: i !== 0 })),
    ];
    const plan = planPrune(items);
    expect(plan.removeFile).toEqual([]);
    expect(plan.eraseOnly.sort((a, b) => a - b)).toEqual([1, 10]);
  });
});

describe('runBackup', () => {
  function deps(over: Partial<BackupDeps> = {}) {
    const log: string[] = [];
    const states: unknown[] = [];
    const d: BackupDeps = {
      backupBlob: async () => ({ url: 'blob:x', bytes: 1234 }),
      revokeBlob: (u) => void log.push(`revoke ${u}`),
      download: async ({ filename }) => (log.push(`download ${filename}`), 7),
      waitForDownload: async () => {},
      searchBackups: async () => Array.from({ length: 9 }, (_, i) => ({ id: i + 1, filename: file(day(i + 1)), exists: true })),
      removeFile: async (id) => void log.push(`rm ${id}`),
      erase: async (id) => void log.push(`erase ${id}`),
      setUiEnabled: async (on) => void log.push(`ui ${on}`),
      saveState: async (s) => void states.push(s),
      now: () => new Date(2026, 9, 14, 12).getTime(),
      ...over,
    };
    return { d, log, states };
  }

  it('downloads, prunes and records the result', async () => {
    const { d, log, states } = deps();
    const s = await runBackup(undefined, d);
    expect(s).toMatchObject({ lastBytes: 1234, lastFile: 'history++/history-plus-plus-2026-10-14.sqlite3', running: false });
    expect(s.error).toBeUndefined();
    expect(log).toEqual([
      'ui false',
      'download history++/history-plus-plus-2026-10-14.sqlite3',
      'ui true',
      'rm 2',
      'erase 2',
      'rm 1',
      'erase 1',
      'revoke blob:x',
    ]);
    expect(states[0]).toMatchObject({ running: true });
  });

  it('records errors and keeps the previous backup info', async () => {
    const { d, log } = deps({ waitForDownload: async () => Promise.reject(new Error('disk full')) });
    const s = await runBackup({ lastAt: 5, lastBytes: 9, lastFile: 'old', running: false }, d);
    expect(s).toMatchObject({ lastAt: 5, lastBytes: 9, lastFile: 'old', running: false, error: 'disk full' });
    expect(log).toContain('ui true');
    expect(log).toContain('revoke blob:x');
  });
});
