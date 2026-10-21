// Privacy rules shared by capture (content script + background) and the UI.
// Pure functions only: no browser APIs, so they are unit-testable in node.
import type { Settings } from './protocol';

// Built-in sensitive hosts (banking, payments, tax, health, email, identity, password managers).
// A list can't know every bank: pages with password, one-time-code or card fields (extract.ts)
// and sites on the user's own list are skipped too.
// Entries are domain suffixes unless they contain a '*' (then a glob on the host).
export const DEFAULT_SENSITIVE_DOMAINS: readonly string[] = [
  // email
  'mail.google.com',
  'inbox.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'proton.me',
  'mail.aol.com',
  'icloud.com',
  'fastmail.com',
  'mail.zoho.com',
  'mail.zoho.eu',
  'hey.com',
  'tuta.com',
  'tutanota.com',
  'gmx.*',
  '*.gmx.*',
  'web.de',
  'e.mail.ru',
  'mail.yandex.*',
  'mail.yahoo.*',
  'webmail.*',
  // identity / login
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'id.apple.com',
  'auth0.com',
  'okta.com',
  'login.*',
  'signin.*',
  'auth.*',
  'sso.*',
  // password managers
  '1password.com',
  'bitwarden.com',
  'lastpass.com',
  'dashlane.com',
  'keepersecurity.com',
  // payments / banking
  'paypal.com',
  'venmo.com',
  'stripe.com',
  'wise.com',
  'revolut.com',
  'chase.com',
  'wellsfargo.com',
  'bankofamerica.com',
  'citi.com',
  'capitalone.com',
  'americanexpress.com',
  'schwab.com',
  'fidelity.com',
  'vanguard.com',
  'coinbase.com',
  'hsbc.*',
  '*.hsbc.*',
  'barclays.*',
  '*.barclays.*',
  'lloydsbank.com',
  'natwest.com',
  'santander.*',
  '*.santander.*',
  'monzo.com',
  'starlingbank.com',
  'n26.com',
  'bunq.com',
  'ing.com',
  'usaa.com',
  'ally.com',
  'discover.com',
  'chime.com',
  'sofi.com',
  'robinhood.com',
  'etrade.com',
  'interactivebrokers.com',
  'binance.com',
  'kraken.com',
  'klarna.com',
  'afterpay.com',
  'affirm.com',
  'adyen.com',
  'braintreegateway.com',
  'irs.gov',
  'turbotax.intuit.com',
  'gusto.com',
  'adp.com',
  '*bank*',
  // health
  'mychart.*',
  '*.mychart.com',
  'mychart.com',
  'patient.*',
  'healthcare.gov',
  'zocdoc.com',
  'teladoc.com',
];

const DENIED_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'devtools:',
  'file:',
  'about:',
  'data:',
  'blob:',
  'javascript:',
  'edge:',
  'brave:',
  'opera:',
  'view-source:',
  'moz-extension:',
]);

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^\*?\.+/, '').replace(/\.+$/, '');
}

/** Suffix match: 'example.com' matches 'example.com' and 'a.example.com', not 'badexample.com'. */
export function domainMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  const raw = pattern.trim().toLowerCase();
  if (!raw) return false;
  if (raw.includes('*') && !/^\*\.[^*]+$/.test(raw)) {
    // Glob on host labels: '*' matches any run of characters.
    const re = new RegExp('^' + raw.split('*').map(escapeRe).join('.*') + '$');
    return re.test(h);
  }
  const p = normalizeDomain(raw);
  if (!p) return false;
  return h === p || h.endsWith('.' + p);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return false;
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true; // fe80::/10 link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return mapped?.[1] ? isPrivateIPv4(mapped[1]) : false;
}

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    (!host.includes('.') && !host.startsWith('[')) // bare intranet names like http://router/
  );
}

/** True if `domain` (a host) is denied by the built-in sensitive list or the user denylist. */
export function isDomainDenied(domain: string, settings?: Pick<Settings, 'denylist'>): boolean {
  const host = domain.toLowerCase();
  if (DEFAULT_SENSITIVE_DOMAINS.some((p) => domainMatches(host, p))) return true;
  return (settings?.denylist ?? []).some((p) => domainMatches(host, p));
}

/** Whether a URL may be recorded at all (visit row and text). */
export function isUrlAllowed(url: string, settings?: Pick<Settings, 'denylist'>): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (DENIED_SCHEMES.has(u.protocol)) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (isLocalHost(host) || isPrivateIPv4(host) || isPrivateIPv6(host)) return false;
  return !isDomainDenied(host, settings);
}
