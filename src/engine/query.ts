// Search-box parsing: operators (site:, before:, after:) + free text, and a
// translation of free text into an FTS5 MATCH expression that can never be a
// syntax error or an injection of FTS operators.
import type { ParsedQuery } from '../shared/protocol';
import { findDatePhrase, fold } from './dates';

// Tokens: a "quoted phrase" (closing quote optional while typing) or a run of non-space.
const TOKEN_RE = /"[^"]*"?|[^\s"]+/g;

/**
 * Parse a date operator value to local epoch ms (start of the day/month).
 * Accepts YYYY-MM-DD, YYYY-MM, and relative Nd / Nw / Nm / Ny ("7d" = 7 days ago).
 */
function parseDate(value: string, now: number): number | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (m) {
    const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
    const t = new Date(y, mo - 1, d);
    // Reject overflow like 2025-02-31 rolling into March.
    return t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : null;
  }
  m = /^(\d{4})-(\d{1,2})$/.exec(value);
  if (m) {
    const mo = +m[2]!;
    return mo >= 1 && mo <= 12 ? new Date(+m[1]!, mo - 1, 1).getTime() : null;
  }
  m = /^(\d+)([dwmy])$/i.exec(value);
  if (m) {
    const n = +m[1]!;
    const t = new Date(now);
    t.setHours(0, 0, 0, 0);
    const unit = m[2]!.toLowerCase();
    if (unit === 'd') t.setDate(t.getDate() - n);
    else if (unit === 'w') t.setDate(t.getDate() - 7 * n);
    else if (unit === 'm') t.setMonth(t.getMonth() - n);
    else t.setFullYear(t.getFullYear() - n);
    return t.getTime();
  }
  return null;
}

/** "https://www.GitHub.com/x" -> "github.com" */
function cleanSite(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '')
    .replace(/^\.+|\.+$/g, '');
}

/**
 * Split raw input into operators, a plain-language time phrase and free text. Local time.
 * before: is exclusive (start of the given day/month), after: is inclusive.
 * Malformed operators (e.g. `before:soon`) stay in the free text. A time phrase ("last week",
 * "u septembru", see dates.ts) sets before/after and is removed from the text, unless an
 * explicit before:/after: operator is present (operators win; the phrase then stays as text).
 * Quoted phrases are never parsed for dates.
 */
export function parseSearch(
  raw: string,
  now: number = Date.now(),
  opts: { dates?: boolean } = {},
): { parsed: ParsedQuery; dateLabel: string | null } {
  const out: ParsedQuery = { text: '', site: [], before: null, after: null };
  const rest: string[] = [];
  for (const tok of raw.match(TOKEN_RE) ?? []) {
    const m = /^(site|before|after):(.+)$/i.exec(tok);
    if (m) {
      const key = m[1]!.toLowerCase();
      if (key === 'site') {
        const s = cleanSite(m[2]!);
        if (s) {
          if (!out.site.includes(s)) out.site.push(s);
          continue;
        }
      } else {
        const t = parseDate(m[2]!, now);
        if (t !== null) {
          out[key as 'before' | 'after'] = t;
          continue;
        }
      }
    }
    rest.push(tok);
  }
  let dateLabel: string | null = null;
  if (opts.dates !== false && out.before === null && out.after === null) {
    const d = findDatePhrase(rest.map((t) => (t.startsWith('"') ? null : t)), now);
    if (d) {
      out.after = d.after;
      out.before = d.before;
      dateLabel = d.label;
      rest.splice(d.start, d.end - d.start);
    }
  }
  out.text = rest.join(' ');
  return { parsed: out, dateLabel };
}

export function parseQuery(raw: string, now: number = Date.now()): ParsedQuery {
  return parseSearch(raw, now).parsed;
}

// Function words (English + Bosnian/Serbian/Croatian, diacritics folded) plus the filler of
// "what was that page I looked at" questions. Dropped from the FTS expression only: the
// embedding still sees the whole sentence. Kept when a query is nothing but stopwords.
const STOPWORDS = new Set(
  (
    'a an the and or but of to in on at by for with from into about as is are was were be been being am ' +
    'it its this that these those there here i me my mine we our you your he she they them their his her ' +
    'what which who whom whose when where why how do does did done doing have has had having ' +
    'can could would should will shall may might must not no so than then too very just also some any ' +
    'all one ones thing things stuff something anything ' +
    'look looked looking looks saw seen see visited visit browsing browsed opened found find ' +
    'page pages site website websites ' +
    'i u na za od do se je da sa s po iz su ili a ali o ob kod pri kao sto koji koja koje kojem kako ' +
    'gdje gde kad kada sam si smo ste bio bila bilo bili me mi ti to taj ta te ovo ono onaj ' +
    'moj moja moje mog mojoj neki neka nesto li ne ni pa jer vec jos samo sve svi biti ce bi ' +
    'gledao gledala gledam vidio vidjela vidjeo videla citao citala stranica stranicu stranice sajt'
  ).split(/\s+/),
);
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * Very light stemming so inflected words still match: Bosnian/Serbian/Croatian case endings
 * (Sarajevo/Sarajevu, Baščaršija/Baščaršiji) and English plurals (event/events). Drops one
 * trailing vowel or 's' from plain words of 5+ letters; the caller prefix-matches the result.
 */
export function lightStem(word: string): string {
  if (!/^\p{L}{5,}$/u.test(word)) return word;
  return /[aeiouAEIOUsS]$/u.test(word) ? word.slice(0, -1) : word;
}

interface Term {
  s: string;
  phrase: boolean;
  last: boolean; // final token as typed: gets a prefix * (search-as-you-type)
}

/** Searchable terms of the free text: stopwords dropped unless nothing else is left. */
function terms(text: string): Term[] {
  const all: Term[] = [];
  for (const tok of text.match(TOKEN_RE) ?? []) {
    const phrase = tok.startsWith('"');
    const s = phrase ? tok.replace(/^"|"$/g, '') : tok;
    // Tokens with no letters/digits tokenize to nothing; drop them.
    if (HAS_WORD.test(s)) all.push({ s: s.trim(), phrase, last: false });
  }
  const tail = all.at(-1);
  if (tail && !tail.phrase) tail.last = true;
  const content = all.filter((t) => t.phrase || !STOPWORDS.has(fold(t.s)));
  return content.length ? content : all;
}

function ftsTerm({ s, phrase, last }: Term): string {
  if (!phrase) {
    const stem = lightStem(s);
    if (stem !== s) return '"' + stem + '"*';
  }
  const quoted = '"' + s.replace(/"/g, '""') + '"';
  return last ? quoted + '*' : quoted;
}

/**
 * Free text -> safe FTS5 MATCH expression, or null when nothing searchable.
 * Every token becomes an FTS5 string ("..." with "" escaping), so operators
 * like OR / NEAR / - / * / ( typed by the user are plain text. Stopwords are
 * dropped, the rest ANDed; the last typed token gets a prefix `*`.
 */
export function toFtsMatch(text: string): string | null {
  const ts = terms(text);
  return ts.length ? ts.map(ftsTerm).join(' AND ') : null;
}

// Loose match: at least LOOSE_SHARE of the terms (rounded up), at most LOOSE_MAX_TERMS terms
// considered (the longest ones, which tend to be the rarest) so the OR of combinations stays small.
const LOOSE_SHARE = 0.6;
const LOOSE_MAX_TERMS = 7;

/**
 * Fallback for long natural-language questions whose strict AND finds (almost) nothing:
 * pages containing MOST of the terms, as an OR of every k-of-n AND group, ranked by bm25.
 * null when the query has fewer than 3 terms (no meaningful "most").
 */
export function toFtsLooseMatch(text: string): string | null {
  let ts = terms(text);
  if (ts.length < 3) return null;
  if (ts.length > LOOSE_MAX_TERMS) {
    const keep = new Set([...ts].sort((a, b) => b.s.length - a.s.length).slice(0, LOOSE_MAX_TERMS));
    ts = ts.filter((t) => keep.has(t));
  }
  const parts = ts.map(ftsTerm);
  const k = Math.ceil(parts.length * LOOSE_SHARE);
  const groups: string[] = [];
  const pick = (from: number, acc: string[]) => {
    if (acc.length === k) {
      groups.push('(' + acc.join(' AND ') + ')');
      return;
    }
    for (let i = from; i <= parts.length - (k - acc.length); i++) pick(i + 1, [...acc, parts[i]!]);
  };
  pick(0, []);
  return groups.join(' OR ');
}
