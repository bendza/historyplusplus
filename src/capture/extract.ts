// Content-script-side readable text extraction. Never mutates the live page.
import Defuddle from 'defuddle';
import { Readability } from '@mozilla/readability';
import { capText, htmlToText, normalizeLang, normalizeText } from './text';

const MIN_USEFUL_CHARS = 200;

// Hosted card fields live in cross-origin iframes, so a checkout page using them has no card
// input of its own: their frames are the signal instead. Paths are matched too where the same
// host also serves frames that appear on every page (Stripe.js loads a hidden controller frame).
const PAYMENT_FRAMES: readonly { host: string; path?: string }[] = [
  { host: 'js.stripe.com', path: '/elements-inner-' },
  { host: 'checkoutshopper-live.adyen.com' },
  { host: 'checkoutshopper-live-us.adyen.com' },
  { host: 'checkoutshopper-test.adyen.com' },
  { host: 'assets.braintreegateway.com', path: 'hosted-fields' },
  { host: 'js.checkout.com', path: '/frames' },
  { host: 'web.squarecdn.com' },
];

/** True for the src of an iframe that hosts card fields. */
export function isPaymentFrameSrc(src: string): boolean {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return PAYMENT_FRAMES.some((f) => host === f.host && (!f.path || u.pathname.includes(f.path)));
}

/** True if the page has fields we must never read around (passwords, one-time codes, card numbers). */
export function hasSensitiveFields(doc: Document): boolean {
  if (
    doc.querySelector(
      'input[type="password" i], [autocomplete^="cc-" i], [autocomplete~="one-time-code" i], ' +
        '[autocomplete~="current-password" i], [autocomplete~="new-password" i]',
    )
  ) {
    return true;
  }
  return Array.from(doc.querySelectorAll('iframe[src]')).some((f) => isPaymentFrameSrc(f.getAttribute('src') ?? ''));
}

function viaDefuddle(doc: Document): string {
  const clone = doc.cloneNode(true) as Document;
  // useAsync: false keeps Defuddle's site extractors from calling third-party APIs.
  const res = new Defuddle(clone, { url: doc.location?.href, useAsync: false }).parse();
  return normalizeText(htmlToText(res.content ?? ''));
}

function viaReadability(doc: Document): string {
  const clone = doc.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  return normalizeText(article?.textContent ?? '');
}

function viaBody(doc: Document): string {
  return normalizeText(doc.body?.innerText ?? doc.body?.textContent ?? '');
}

export function extractText(doc: Document): { text: string; lang: string | null } {
  let text = '';
  for (const fn of [viaDefuddle, viaReadability, viaBody]) {
    try {
      const t = fn(doc);
      if (t.length > text.length) text = t;
      if (text.length >= MIN_USEFUL_CHARS) break;
    } catch {
      // try next extractor
    }
  }
  return { text: capText(text), lang: normalizeLang(doc.documentElement?.getAttribute('lang')) };
}
