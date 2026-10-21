import { describe, expect, it } from 'vitest';
import { detectOS, historyFileLocations, type OS } from './browsers';

describe('detectOS', () => {
  it('reads userAgentData, platform and userAgent', () => {
    expect(detectOS({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectOS({ platform: 'MacIntel' })).toBe('mac');
    expect(detectOS({ userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(detectOS({ platform: 'Win32' })).toBe('windows');
    expect(detectOS({ platform: 'Linux x86_64' })).toBe('linux');
    expect(detectOS({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' })).toBe('linux');
    expect(detectOS({ userAgentData: { platform: 'Chrome OS' }, platform: 'Linux x86_64' })).toBeNull();
    expect(detectOS({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).toBeNull();
    expect(detectOS({})).toBeNull();
  });
});

describe('historyFileLocations', () => {
  it('lists Safari on mac only, Arc not on linux', () => {
    const ids = (os: OS) => historyFileLocations(os).map((l) => l.browser);
    expect(ids('mac')).toEqual(['chrome', 'edge', 'brave', 'arc', 'vivaldi', 'opera', 'firefox', 'zen', 'safari']);
    expect(ids('windows')).toEqual(['chrome', 'edge', 'brave', 'arc', 'vivaldi', 'opera', 'firefox', 'zen']);
    expect(ids('linux')).toEqual(['chrome', 'edge', 'brave', 'vivaldi', 'opera', 'firefox', 'zen']);
  });

  it('splits dir/file with the OS separator and flags profile folders', () => {
    for (const os of ['mac', 'windows', 'linux'] as const) {
      const sep = os === 'windows' ? '\\' : '/';
      for (const l of historyFileLocations(os)) {
        expect(l.path).toBe(`${l.dir}${sep}${l.file}`);
        expect(['History', 'places.sqlite', 'History.db']).toContain(l.file);
        expect(l.profileDir).toBe(l.file === 'places.sqlite');
        if (os !== 'windows') expect(l.path.startsWith('~/')).toBe(true);
        else expect(l.path).toMatch(/^%(LOCALAPPDATA|APPDATA)%\\/);
      }
    }
    const mac = historyFileLocations('mac');
    expect(mac.find((l) => l.browser === 'chrome')?.path).toBe('~/Library/Application Support/Google/Chrome/Default/History');
    expect(mac.find((l) => l.browser === 'safari')?.dir).toBe('~/Library/Safari');
    expect(historyFileLocations('windows').find((l) => l.browser === 'firefox')?.dir).toBe(String.raw`%APPDATA%\Mozilla\Firefox\Profiles\<profile>`);
  });
});
