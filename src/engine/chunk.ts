// Splitting pages into embeddable passages. Chunk ord 0 is the "title chunk"
// (title + domain + readable URL words, works for title-only imported history);
// ord 1..MAX_TEXT_CHUNKS are ~CHUNK_CHARS passages from the start of the page text.

export const CHUNK_CHARS = 800;
export const MAX_TEXT_CHUNKS = 6; // the first parts of a page matter most
// Only this much of the page text can end up in a chunk.
export const TEXT_HEAD_CHARS = Math.ceil(CHUNK_CHARS * MAX_TEXT_CHUNKS * 1.5);

// URL path pieces that carry no meaning.
const URL_STOP = new Set(['html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'cgi', 'index', 'www', 'amp']);

/**
 * Readable words from a URL's path + query: "/x/react-hooks_guide/issues/12345?tab=readme"
 * -> ["react", "hooks", "guide", "issues", "tab", "readme"]. Drops numbers, hex blobs and
 * id-like tokens (6+ chars containing a digit), 1-char pieces and file extensions.
 */
export function urlWords(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  let s = u.pathname + ' ' + u.search.replace(/\+/g, ' ');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  s = s.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, ' '); // UUIDs
  const out: string[] = [];
  for (const raw of s.split(/[\s/\-_.?=&#:;,~!%+|()[\]{}'"@$*]+/)) {
    const w = raw.toLowerCase();
    if (w.length < 2 || w.length > 30 || URL_STOP.has(w)) continue;
    if (/^\d+$/.test(w)) continue; // numbers
    if (/^[0-9a-f]{8,}$/.test(w) || (/^[0-9a-f]{4,}$/.test(w) && /\d/.test(w))) continue; // hashes, hex ids
    if (w.length >= 6 && /\d/.test(w)) continue; // ids like dQw4w9WgXcQ, a1b2c3
    if (!out.includes(w)) out.push(w);
    if (out.length >= 24) break;
  }
  return out;
}

/** ord 0: "Title — domain url words". Never empty for a recordable page (domain is always set). */
export function titleChunk(title: string, domain: string, url: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  const rest = [domain, ...urlWords(url)].join(' ');
  return t ? `${t} — ${rest}` : rest;
}

/** Split an over-long sentence at word boundaries. */
function hardSplit(s: string, size: number): string[] {
  const out: string[] = [];
  while (s.length > size) {
    let cut = s.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size; // no usable space: cut mid-word
    out.push(s.slice(0, cut).trim());
    s = s.slice(cut).trim();
  }
  if (s) out.push(s);
  return out;
}

/**
 * Page text -> up to `max` passages of about `size` chars, packed from paragraphs,
 * falling back to sentences, then words, for pieces that don't fit.
 */
export function textChunks(text: string, size = CHUNK_CHARS, max = MAX_TEXT_CHUNKS): string[] {
  // Only the head of the text can end up in a chunk; don't split 40k chars for nothing.
  const head = text.slice(0, Math.ceil(size * max * 1.5));
  const pieces: string[] = [];
  for (const para of head.split(/\n+/)) {
    const p = para.replace(/\s+/g, ' ').trim();
    if (!p) continue;
    if (p.length <= size) {
      pieces.push(p);
      continue;
    }
    for (const sentence of p.split(/(?<=[.!?。！？])\s+/)) {
      if (sentence.length <= size) pieces.push(sentence);
      else pieces.push(...hardSplit(sentence, size));
    }
  }
  const out: string[] = [];
  let cur = '';
  for (const piece of pieces) {
    if (cur && cur.length + 1 + piece.length > size) {
      out.push(cur);
      if (out.length >= max) return out;
      cur = piece;
    } else {
      cur = cur ? cur + ' ' + piece : piece;
    }
  }
  if (cur) {
    // Fold a short tail into the previous passage instead of embedding a scrap.
    if (out.length && cur.length < size / 4) out[out.length - 1] += ' ' + cur;
    else out.push(cur);
  }
  return out.slice(0, max);
}
