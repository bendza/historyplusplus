// Browser + OS facts the UI needs: where other browsers keep their history file (for the
// "import from another browser" picker) and which extension features this browser has.

export type OS = 'mac' | 'windows' | 'linux';

export type BrowserId = 'chrome' | 'edge' | 'brave' | 'arc' | 'vivaldi' | 'opera' | 'firefox' | 'zen' | 'safari';

export interface HistoryFileLocation {
  browser: BrowserId;
  label: string; // display name
  /** Full path. `~` = home (mac/linux); %LOCALAPPDATA% / %APPDATA% on Windows. `<profile>` = a profile folder. */
  path: string;
  /** The folder holding the file (what to open in a file picker / Finder "Go to folder"). */
  dir: string;
  file: 'History' | 'places.sqlite' | 'History.db';
  /** Firefox-family: the profile folder name is random (e.g. "abcd1234.default-release"). */
  profileDir: boolean;
  /** Other places the file may be (older versions, other packagings). */
  alt?: string[];
  note?: string;
}

/** Chromium serves cached favicons at chrome-extension://<id>/_favicon/; Firefox doesn't. */
export const faviconSupported: boolean = !import.meta.env?.FIREFOX;

/** Firefox build (MV2, persistent background page hosting the engine). */
export const isFirefox: boolean = !!import.meta.env?.FIREFOX;

interface NavigatorLike {
  userAgentData?: { platform?: string } | null;
  platform?: string;
  userAgent?: string;
}

/** OS from navigator.userAgentData / platform / userAgent; null when not mac, windows or linux. */
export function detectOS(nav: NavigatorLike | undefined = globalThis.navigator): OS | null {
  if (!nav) return null;
  const hints = [nav.userAgentData?.platform, nav.platform, nav.userAgent].filter(Boolean).join(' ').toLowerCase();
  if (/cros|chrome os|android|iphone|ipad/.test(hints)) return null;
  if (/mac/.test(hints)) return 'mac';
  if (/win/.test(hints)) return 'windows';
  if (/linux|x11/.test(hints)) return 'linux';
  return null;
}

type Entry = Omit<HistoryFileLocation, 'dir' | 'profileDir' | 'file' | 'path'> & { path: string; alt?: string[] };

const MAC: Entry[] = [
  { browser: 'chrome', label: 'Chrome', path: '~/Library/Application Support/Google/Chrome/Default/History' },
  { browser: 'edge', label: 'Edge', path: '~/Library/Application Support/Microsoft Edge/Default/History' },
  { browser: 'brave', label: 'Brave', path: '~/Library/Application Support/BraveSoftware/Brave-Browser/Default/History' },
  { browser: 'arc', label: 'Arc', path: '~/Library/Application Support/Arc/User Data/Default/History' },
  { browser: 'vivaldi', label: 'Vivaldi', path: '~/Library/Application Support/Vivaldi/Default/History' },
  {
    browser: 'opera',
    label: 'Opera',
    path: '~/Library/Application Support/com.operasoftware.Opera/Default/History',
    alt: ['~/Library/Application Support/com.operasoftware.Opera/History'],
  },
  { browser: 'firefox', label: 'Firefox', path: '~/Library/Application Support/Firefox/Profiles/<profile>/places.sqlite' },
  { browser: 'zen', label: 'Zen', path: '~/Library/Application Support/zen/Profiles/<profile>/places.sqlite' },
  {
    browser: 'safari',
    label: 'Safari',
    path: '~/Library/Safari/History.db',
    note: 'macOS asks for Full Disk Access before other apps can read Safari files; copy it somewhere first if the picker refuses.',
  },
];

const WINDOWS: Entry[] = [
  { browser: 'chrome', label: 'Chrome', path: String.raw`%LOCALAPPDATA%\Google\Chrome\User Data\Default\History` },
  { browser: 'edge', label: 'Edge', path: String.raw`%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\History` },
  { browser: 'brave', label: 'Brave', path: String.raw`%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\History` },
  {
    browser: 'arc',
    label: 'Arc',
    path: String.raw`%LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_ttt1ap7aakyb4\LocalCache\Local\Arc\User Data\Default\History`,
  },
  { browser: 'vivaldi', label: 'Vivaldi', path: String.raw`%LOCALAPPDATA%\Vivaldi\User Data\Default\History` },
  {
    browser: 'opera',
    label: 'Opera',
    path: String.raw`%APPDATA%\Opera Software\Opera Stable\Default\History`,
    alt: [String.raw`%APPDATA%\Opera Software\Opera Stable\History`],
  },
  { browser: 'firefox', label: 'Firefox', path: String.raw`%APPDATA%\Mozilla\Firefox\Profiles\<profile>\places.sqlite` },
  { browser: 'zen', label: 'Zen', path: String.raw`%APPDATA%\zen\Profiles\<profile>\places.sqlite` },
];

const LINUX: Entry[] = [
  { browser: 'chrome', label: 'Chrome', path: '~/.config/google-chrome/Default/History', alt: ['~/.config/chromium/Default/History'] },
  { browser: 'edge', label: 'Edge', path: '~/.config/microsoft-edge/Default/History' },
  { browser: 'brave', label: 'Brave', path: '~/.config/BraveSoftware/Brave-Browser/Default/History' },
  { browser: 'vivaldi', label: 'Vivaldi', path: '~/.config/vivaldi/Default/History' },
  { browser: 'opera', label: 'Opera', path: '~/.config/opera/Default/History', alt: ['~/.config/opera/History'] },
  {
    browser: 'firefox',
    label: 'Firefox',
    path: '~/.mozilla/firefox/<profile>/places.sqlite',
    alt: ['~/snap/firefox/common/.mozilla/firefox/<profile>/places.sqlite', '~/.var/app/org.mozilla.firefox/.mozilla/firefox/<profile>/places.sqlite'],
  },
  { browser: 'zen', label: 'Zen', path: '~/.zen/<profile>/places.sqlite', alt: ['~/.var/app/app.zen_browser.zen/.zen/<profile>/places.sqlite'] },
];

const TABLE: Record<OS, Entry[]> = { mac: MAC, windows: WINDOWS, linux: LINUX };

function split(path: string, os: OS): { dir: string; file: HistoryFileLocation['file'] } {
  const sep = os === 'windows' ? '\\' : '/';
  const i = path.lastIndexOf(sep);
  return { dir: path.slice(0, i), file: path.slice(i + 1) as HistoryFileLocation['file'] };
}

/** Each browser's history file location on `os`. Chromium-family paths are for the default profile. */
export function historyFileLocations(os: OS): HistoryFileLocation[] {
  return TABLE[os].map((e) => ({ ...e, ...split(e.path, os), profileDir: e.path.includes('<profile>') }));
}
