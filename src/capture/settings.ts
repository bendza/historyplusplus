import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from '../shared/protocol';

export function mergeSettings(raw: unknown): Settings {
  const s = raw && typeof raw === 'object' ? (raw as Partial<Settings>) : {};
  return {
    denylist: Array.isArray(s.denylist) ? s.denylist.filter((d): d is string => typeof d === 'string') : DEFAULT_SETTINGS.denylist,
    minDwellMs: typeof s.minDwellMs === 'number' && s.minDwellMs >= 0 ? s.minDwellMs : DEFAULT_SETTINGS.minDwellMs,
    captureText: typeof s.captureText === 'boolean' ? s.captureText : DEFAULT_SETTINGS.captureText,
    paused: typeof s.paused === 'boolean' ? s.paused : DEFAULT_SETTINGS.paused,
    semanticSearch: typeof s.semanticSearch === 'boolean' ? s.semanticSearch : DEFAULT_SETTINGS.semanticSearch,
    backupEnabled: typeof s.backupEnabled === 'boolean' ? s.backupEnabled : DEFAULT_SETTINGS.backupEnabled,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const { settings } = await browser.storage.local.get('settings');
    return mergeSettings(settings);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Calls `cb` with fresh settings whenever storage key 'settings' changes. */
export function onSettingsChanged(cb: (s: Settings) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) cb(mergeSettings(changes.settings.newValue));
  });
}
