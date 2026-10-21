// URL normalization: one canonical key per page so revisits and tracking-param
// variants collapse onto the same `pages` row.

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_eid', 'ref_src']);
// Credentials that sites put in links (password resets, magic sign-in links, OAuth redirects,
// signed download URLs). Never stored: the link is useless later anyway, and it's a secret.
const SECRET_PARAMS = new Set([
  'token', 'access_token', 'id_token', 'refresh_token', 'auth_token', 'reset_token', 'magic_token',
  'login_token', 'session_token', 'sessionid', 'session_id', 'password', 'passwd', 'pwd', 'secret',
  'client_secret', 'api_key', 'apikey', 'otp', 'code_verifier', 'oauth_token', 'oauth_verifier',
  'signature', 'sig', 'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'x-goog-signature',
  'x-goog-credential',
]);
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };

function isDropped(key: string, oauthCallback: boolean): boolean {
  const k = key.toLowerCase();
  if (k.startsWith('utm_') || TRACKING_PARAMS.has(k) || SECRET_PARAMS.has(k)) return true;
  return oauthCallback && k === 'code'; // ?code=…&state=… is a one-time OAuth grant
}

/**
 * Canonical form of a URL: lowercase host, no fragment, no tracking or secret params,
 * no user:password@, no default port. Path and remaining query are kept as-is (order preserved).
 * Unparseable input is returned trimmed and otherwise untouched.
 */
export function normalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim();
  }
  u.hash = '';
  // URL already lowercases the host for special schemes; do it for others too.
  u.hostname = u.hostname.toLowerCase();
  if (u.port && DEFAULT_PORTS[u.protocol] === u.port) u.port = '';
  u.username = '';
  u.password = '';

  if (u.search) {
    const oauthCallback = /(?:^|[?&])state=/i.test(u.search) && /(?:^|[?&])code=/i.test(u.search);
    // Filter the raw query string instead of URLSearchParams round-tripping,
    // which would re-encode untouched params (e.g. %20 -> +).
    const kept = u.search
      .slice(1)
      .split('&')
      .filter((part) => {
        if (!part) return false;
        const rawKey = part.split('=')[0]!;
        let key = rawKey;
        try {
          key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        } catch {
          /* keep raw key */
        }
        return !isDropped(key, oauthCallback);
      });
    u.search = kept.length ? '?' + kept.join('&') : '';
  }

  let out = u.href;
  // `new URL` turns "https://a.com" into "https://a.com/". Drop the slash only
  // for that root-equivalent case; "/docs/" stays distinct from "/docs".
  if (u.pathname === '/' && !u.search && out.endsWith('/') && u.host) out = out.slice(0, -1);
  return out;
}

/** Hostname without a leading "www." ("" when the URL has no host). */
export function domainOf(url: string): string {
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
