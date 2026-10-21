import { MAX_TEXT_CHARS } from '../shared/protocol';

const BLOCK_TAGS =
  'address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|td|th|ul';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Convert an HTML fragment (e.g. Defuddle's `content`) to plain text, keeping paragraph breaks. */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s);
}

/** Collapse runs of spaces, keep at most one blank line between paragraphs, trim. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ ​\t\f\v ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cap to `max` chars without splitting a surrogate pair. */
export function capText(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text;
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Normalize a BCP-47 tag from <html lang>, e.g. 'en_US ' -> 'en-us'; null if absent/invalid. */
export function normalizeLang(lang: string | null | undefined): string | null {
  const l = (lang ?? '').trim().replace(/_/g, '-').toLowerCase();
  return /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(l) ? l : null;
}
