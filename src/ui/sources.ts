// Display rows for "import from another browser", built on src/shared/browsers.ts.
import { detectOS as detectSharedOS, historyFileLocations as sharedLocations, type OS } from '../shared/browsers';

export type { OS };

export interface HistoryLocation {
  browser: string;
  path: string; // what to paste into the file picker
  note?: string;
}

/** The OS to show paths for; unknown platforms (ChromeOS etc.) fall back to Linux-style paths. */
export function detectOS(): OS {
  return detectSharedOS() ?? 'linux';
}

export function historyFileLocations(os: OS): HistoryLocation[] {
  return sharedLocations(os).map((l) => ({
    browser: l.label,
    // Firefox-family profile folders have random names: point at the folder that holds them.
    path: l.profileDir ? l.path.slice(0, l.path.indexOf('<profile>')) : l.path,
    note: [l.profileDir ? `Open your profile folder and pick ${l.file}.` : '', l.note ?? '', l.alt?.length ? `Not there? Try ${l.alt.join(' or ')}` : ''].filter(Boolean).join(' ') || undefined,
  }));
}

/** The file-picker shortcut that lets you paste a path. */
export function pastePathHint(os: OS): string {
  if (os === 'mac') return 'In the file picker press ⌘⇧G and paste the path.';
  if (os === 'windows') return 'In the file picker paste the path into the File name box.';
  return 'In the file picker press Ctrl+L and paste the path.';
}
