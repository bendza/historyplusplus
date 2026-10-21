// Daily backup: the SQLite file goes to <Downloads>/history++/history-plus-plus-YYYY-MM-DD.sqlite3
// through the downloads API (extensions can't write files elsewhere). Only the newest BACKUP_KEEP
// backup files are kept; older ones are deleted from disk and from the downloads list.
import { BACKUP_DIR, BACKUP_KEEP, type BackupState } from '../shared/protocol';
import type { BackupBlob } from './host-api';

export const BACKUP_DUE_MS = 24 * 60 * 60_000;
export const BACKUP_CHECK_PERIOD_MIN = 60;

export const DEFAULT_BACKUP_STATE: BackupState = { lastAt: null, lastBytes: 0, lastFile: null, running: false };

const pad = (n: number) => String(n).padStart(2, '0');
export function backupFileName(d: Date): string {
  return `${BACKUP_DIR}/history-plus-plus-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.sqlite3`;
}

/** Matches our backup files at any absolute path, / or \ separators. Group 1: YYYY-MM-DD. */
export const BACKUP_FILE_RE = /[\\/]history\+\+[\\/]history-plus-plus-(\d{4}-\d{2}-\d{2})\.sqlite3$/;
export const BACKUP_FILE_REGEX_SOURCE = String.raw`[\\/]history\+\+[\\/]history-plus-plus-\d{4}-\d{2}-\d{2}\.sqlite3$`;

/** Due when backups are on and the last one is a day old. Fresh installs wait a day from `since`. */
export function isBackupDue(state: BackupState | undefined, since: number | undefined, now: number): boolean {
  const last = state?.lastAt ?? since ?? null;
  return last === null || now - last >= BACKUP_DUE_MS;
}

export interface DownloadItemLike {
  id: number;
  filename: string;
  exists?: boolean;
  state?: string;
  startTime?: string;
}

/**
 * Which download entries to delete. Files: everything older than the newest `keep` distinct
 * dates (deleted from disk + erased). Entries: older history rows that point at a kept file
 * (conflictAction 'overwrite' leaves one row per day the file was rewritten) are only erased.
 */
export function planPrune(items: DownloadItemLike[], keep = BACKUP_KEEP): { removeFile: number[]; eraseOnly: number[] } {
  const byFile = new Map<string, { date: string; rows: DownloadItemLike[] }>();
  for (const it of items) {
    const m = BACKUP_FILE_RE.exec(it.filename);
    if (!m) continue;
    const e = byFile.get(it.filename) ?? { date: m[1]!, rows: [] };
    e.rows.push(it);
    byFile.set(it.filename, e);
  }
  const files = [...byFile.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const removeFile: number[] = [];
  const eraseOnly: number[] = [];
  files.forEach((f, i) => {
    // Newest row first: it is the one whose file is on disk.
    const rows = [...f.rows].sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? '') || b.id - a.id);
    if (i < keep) {
      eraseOnly.push(...rows.slice(1).map((r) => r.id));
    } else {
      const [head, ...rest] = rows;
      if (head) (head.exists === false ? eraseOnly : removeFile).push(head.id);
      eraseOnly.push(...rest.map((r) => r.id));
    }
  });
  return { removeFile, eraseOnly };
}

export interface BackupDeps {
  backupBlob(): Promise<BackupBlob>;
  revokeBlob(url: string): void;
  download(opts: { url: string; filename: string }): Promise<number>;
  /** Resolves when the download finished; rejects with the interrupt reason. */
  waitForDownload(id: number): Promise<void>;
  searchBackups(): Promise<DownloadItemLike[]>;
  removeFile(id: number): Promise<void>;
  erase(id: number): Promise<void>;
  setUiEnabled?(enabled: boolean): Promise<void>;
  saveState(s: BackupState): Promise<void>;
  now?: () => number;
}

export async function runBackup(prev: BackupState | undefined, deps: BackupDeps): Promise<BackupState> {
  const now = deps.now ?? Date.now;
  const state: BackupState = { ...DEFAULT_BACKUP_STATE, ...prev, running: true };
  delete state.error;
  await deps.saveState({ ...state });
  let url: string | null = null;
  try {
    const blob = await deps.backupBlob();
    url = blob.url;
    const filename = backupFileName(new Date(now()));
    // Keep the daily download from popping up the downloads bubble (Chromium only).
    await deps.setUiEnabled?.(false).catch(() => {});
    try {
      const id = await deps.download({ url, filename });
      await deps.waitForDownload(id);
    } finally {
      await deps.setUiEnabled?.(true).catch(() => {});
    }
    Object.assign(state, { lastAt: now(), lastBytes: blob.bytes, lastFile: filename });
    const plan = planPrune(await deps.searchBackups());
    for (const id of plan.removeFile) {
      await deps.removeFile(id).catch((e: unknown) => console.warn('[history++] backup prune removeFile', e));
      await deps.erase(id).catch(() => {});
    }
    for (const id of plan.eraseOnly) await deps.erase(id).catch(() => {});
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
  } finally {
    if (url) deps.revokeBlob(url);
    state.running = false;
    await deps.saveState({ ...state });
  }
  return state;
}
