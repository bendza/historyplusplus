// Plain-language time phrases in the search box ("last week", "in september", "prije 3 dana")
// -> a local-time range [after, before) plus a human label. English and Bosnian/Serbian/
// Croatian (Latin script, diacritics optional). Conservative on purpose: month names count
// only after a preposition ("in may", "u maju") or before a year ("may 2025"), so "may"/
// "march"/"maja" in ordinary text never filter results.

export interface DateRange {
  after: number; // epoch ms, inclusive
  before: number | null; // epoch ms, exclusive; null = open (up to now)
  label: string;
}

export interface DateMatch extends DateRange {
  start: number; // first token index consumed
  end: number; // one past the last token index consumed
}

/** Lowercase, drop diacritics (č->c, đ->d), possessive 's and edge punctuation. */
export function fold(tok: string): string {
  return tok
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/['’]s$/u, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Folded month forms -> 0-based month. English (full + abbreviations), Serbian/Bosnian
// (nominative, genitive, locative; ekavian/ijekavian), Croatian (same three cases).
const MONTHS = new Map<string, number>();
(
  [
    ['january jan januar januara januaru sijecanj sijecnja sijecnju'],
    ['february feb februar februara februaru veljaca veljace veljaci'],
    ['march mar mart marta martu ozujak ozujka ozujku'],
    ['april apr aprila aprilu travanj travnja travnju'],
    ['may maj maja maju svibanj svibnja svibnju'],
    ['june jun juni juna junu lipanj lipnja lipnju'],
    ['july jul juli jula julu srpanj srpnja srpnju'],
    ['august aug avgust avgusta avgustu augusta augustu kolovoz kolovoza kolovozu'],
    ['september sep sept septembar septembra septembru rujan rujna rujnu'],
    ['october oct oktobar oktobra oktobru listopad listopada listopadu'],
    ['november nov novembar novembra novembru studeni studenog studenoga studenom studenome'],
    ['december dec decembar decembra decembru prosinac prosinca prosincu'],
  ] as const
).forEach(([forms], m) => forms.split(' ').forEach((f) => MONTHS.set(f, m)));

// English abbreviations count only after a preposition ("in feb"): "Feb 2019 – Feb 2020" in
// pasted CV text is not a request for February 2019.
const MONTH_ABBR = new Set(['jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);

// Words that introduce a month or year: "in september", "u rujnu", "during may", "tokom maja".
const MONTH_PREP = new Set(['in', 'during', 'from', 'u', 'tokom', 'tijekom', 'iz']);
// Fillers swallowed in front of a relative phrase so they don't linger in the free text
// ("in the last 3 days", "from yesterday", "u zadnjih 7 dana").
const LEAD_FILLER = new Set(['in', 'during', 'from', 'on', 'over', 'within', 'the', 'u', 'tokom', 'tijekom', 'od', 'iz']);

type Unit = 'day' | 'week' | 'month' | 'year';
const UNITS = new Map<string, Unit>();
const addUnits = (u: Unit, forms: string) => forms.split(' ').forEach((f) => UNITS.set(f, u));
addUnits('day', 'day days dan dana dane');
addUnits('week', 'week weeks sedmica sedmice sedmicu nedelja nedelje nedelju nedjelja nedjelje nedjelju tjedan tjedna tjedana tjedne');
addUnits('month', 'month months mjesec mjeseca mjeseci mjesece mesec meseca meseci mesece');
addUnits('year', 'year years godina godine godinu');

const NUMBER_WORDS = new Map<string, number>();
(
  [
    [1, 'a an one jedan jednu jednog jedne'],
    [2, 'two couple dva dvije dve'],
    [3, 'three few tri'],
    [4, 'four cetiri'],
    [5, 'five pet'],
    [6, 'six sest'],
    [7, 'seven sedam'],
    [8, 'eight osam'],
    [9, 'nine devet'],
    [10, 'ten deset'],
  ] as const
).forEach(([n, forms]) => forms.split(' ').forEach((f) => NUMBER_WORDS.set(f, n)));

function number(tok: string | null): number | null {
  if (tok == null) return null;
  if (/^\d{1,3}$/.test(tok)) return +tok > 0 ? +tok : null;
  return NUMBER_WORDS.get(tok) ?? null;
}

const THIS_EN = new Set(['this']);
const LAST_EN = new Set(['last', 'previous']);
// BCS demonstratives / "last" in the cases used with week/month/year.
const THIS_BCS = new Set(['ove', 'ovaj', 'ovog', 'ovoga', 'ova', 'ovu', 'ovom', 'ovoj']);
const LAST_BCS = new Set(['prosle', 'prosli', 'proslog', 'proslu', 'proslom', 'prosla', 'proslo', 'prethodne', 'prethodni', 'prethodnog']);
// Rolling windows: "past 7 days", "zadnjih 7 dana", "posljednja 3 mjeseca".
const ROLLING = new Set([
  'past', 'last', 'previous', 'zadnjih', 'zadnja', 'zadnje', 'zadnji', 'poslednjih', 'posljednjih', 'poslednja', 'posljednja',
  'poslednje', 'posljednje', 'proteklih', 'protekla', 'protekle', 'prethodnih',
]);
const AGO_BCS = new Set(['prije', 'pre']);

const WEEKDAY_EN = new Map(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d, i) => [d, i]));
// Genitive after "prošlog/prošle". Sunday (nedjelje) is left out: "prošle nedjelje" means last week.
const WEEKDAY_BCS = new Map<string, number>([
  ['ponedeljka', 1], ['ponedjeljka', 1], ['utorka', 2], ['srede', 3], ['srijede', 3], ['cetvrtka', 4], ['petka', 5], ['subote', 6],
]);

// ---- calendar helpers (local time) ----
const day = (y: number, m: number, d: number) => new Date(y, m, d);
const addDays = (d: Date, n: number) => day(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));

function fmtDay(d: Date, now: Date, withYear = d.getFullYear() !== now.getFullYear()): string {
  return `${SHORT[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`;
}

/** "Oct 5–11", "Sep 28 – Oct 4", "Dec 29, 2025 – Jan 4, 2026"; `last` is inclusive. */
export function fmtSpan(first: Date, last: Date, now: Date): string {
  if (first.getTime() >= last.getTime()) return fmtDay(first, now);
  const y = first.getFullYear();
  const sameYear = y === last.getFullYear();
  const yearSuffix = sameYear && y !== now.getFullYear() ? `, ${y}` : '';
  if (sameYear && first.getMonth() === last.getMonth()) return `${SHORT[first.getMonth()]} ${first.getDate()}–${last.getDate()}${yearSuffix}`;
  if (sameYear) return `${fmtDay(first, now, false)} – ${fmtDay(last, now, false)}${yearSuffix}`;
  return `${fmtDay(first, now, true)} – ${fmtDay(last, now, true)}`;
}

const monthName = (y: number, m: number) => `${LONG[m]} ${y}`;
const plural = (n: number, unit: Unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function range(after: Date, before: Date | null, label: string): DateRange {
  return { after: after.getTime(), before: before ? before.getTime() : null, label };
}

function dayRange(d: Date, now: Date, prefix: string | null): DateRange {
  return range(d, addDays(d, 1), prefix ? `${prefix} · ${fmtDay(d, now)}` : fmtDay(d, now));
}
function weekRange(mon: Date, now: Date, prefix: string): DateRange {
  return range(mon, addDays(mon, 7), `${prefix} · ${fmtSpan(mon, addDays(mon, 6), now)}`);
}
function monthRange(y: number, m: number, prefix: string | null): DateRange {
  return range(day(y, m, 1), day(y, m + 1, 1), prefix ? `${prefix} · ${monthName(y, m)}` : monthName(y, m));
}
function yearRange(y: number, prefix: string | null): DateRange {
  return range(day(y, 0, 1), day(y + 1, 0, 1), prefix ? `${prefix} · ${y}` : String(y));
}

/** The calendar period `n` units back from today ("3 days ago", "prije 2 sedmice"). */
function agoRange(n: number, unit: Unit, today: Date, now: Date): DateRange {
  const label = cap(`${plural(n, unit)} ago`);
  switch (unit) {
    case 'day':
      return dayRange(addDays(today, -n), now, n === 1 ? 'Yesterday' : label);
    case 'week':
      return weekRange(addDays(mondayOf(today), -7 * n), now, label);
    case 'month': {
      const d = day(today.getFullYear(), today.getMonth() - n, 1);
      return monthRange(d.getFullYear(), d.getMonth(), label);
    }
    case 'year':
      return yearRange(today.getFullYear() - n, label);
  }
}

/** Rolling window ending now: "past 7 days" = today and the 6 days before it. */
function rollingRange(n: number, unit: Unit, today: Date, now: Date): DateRange {
  let after: Date;
  if (unit === 'day') after = addDays(today, -(n - 1));
  else if (unit === 'week') after = addDays(today, -(7 * n - 1));
  else if (unit === 'month') after = addDays(day(today.getFullYear(), today.getMonth() - n, today.getDate()), 1);
  else after = addDays(day(today.getFullYear() - n, today.getMonth(), today.getDate()), 1);
  const what = n === 1 ? unit : plural(n, unit);
  return range(after, null, `Past ${what} · ${fmtSpan(after, today, now)}`);
}

/** Most recent occurrence of month `m` that is not in the future (this month counts). */
function recentMonth(m: number, today: Date, strictlyPast: boolean): DateRange {
  const cur = today.getMonth();
  const y = m < cur || (m === cur && !strictlyPast) ? today.getFullYear() : today.getFullYear() - 1;
  return monthRange(y, m, null);
}

function yearTok(tok: string | null | undefined, today: Date): number | null {
  if (tok == null || !/^\d{4}$/.test(tok)) return null;
  const y = +tok;
  return y >= 1990 && y <= today.getFullYear() ? y : null;
}

type Rule = (t: (string | null)[], i: number, today: Date, now: Date) => { len: number; r: DateRange } | null;

const RULES: Rule[] = [
  // today / yesterday / day before yesterday
  (t, i, today, now) => {
    const w = t[i];
    if (w === 'today' || w === 'danas') return { len: 1, r: dayRange(today, now, 'Today') };
    if (w === 'yesterday' || w === 'juce' || w === 'jucer') return { len: 1, r: dayRange(addDays(today, -1), now, 'Yesterday') };
    if (w === 'prekjuce' || w === 'prekjucer') return { len: 1, r: dayRange(addDays(today, -2), now, '2 days ago') };
    return null;
  },
  // this/last week|month|year (EN + BCS), calendar periods
  (t, i, today, now) => {
    const a = t[i],
      b = t[i + 1];
    if (a == null || b == null) return null;
    const unit = UNITS.get(b);
    if (!unit || unit === 'day') return null;
    const isThis = THIS_EN.has(a) || THIS_BCS.has(a);
    const isLast = LAST_EN.has(a) || LAST_BCS.has(a);
    // "this weeks"/"last months" are not calendar phrases.
    if ((!isThis && !isLast) || /^(weeks|months|years)$/.test(b)) return null;
    const back = isThis ? 0 : 1;
    const prefix = isThis ? `This ${unit}` : `Last ${unit}`;
    if (unit === 'week') return { len: 2, r: weekRange(addDays(mondayOf(today), -7 * back), now, prefix) };
    if (unit === 'month') {
      const d = day(today.getFullYear(), today.getMonth() - back, 1);
      return { len: 2, r: monthRange(d.getFullYear(), d.getMonth(), prefix) };
    }
    return { len: 2, r: yearRange(today.getFullYear() - back, prefix) };
  },
  // past/last N units, zadnjih N dana; "past week" = rolling 7 days
  (t, i, today, now) => {
    const a = t[i];
    if (a == null || !ROLLING.has(a)) return null;
    const n = number(t[i + 1] ?? null);
    if (n !== null) {
      const unit = t[i + 2] != null ? UNITS.get(t[i + 2]!) : undefined;
      return unit ? { len: 3, r: rollingRange(n, unit, today, now) } : null;
    }
    // Bare "past week|month|year" (calendar "last week" is handled by the rule above).
    if (a === 'past' && t[i + 1] != null && /^(day|week|month|year)$/.test(t[i + 1]!))
      return { len: 2, r: rollingRange(1, UNITS.get(t[i + 1]!)!, today, now) };
    return null;
  },
  // N units ago / prije N dana
  (t, i, today, now) => {
    if (t[i] != null && AGO_BCS.has(t[i]!)) {
      // "pre mesec dana", "prije tjedan dana": one unit ago
      const one = t[i + 1] != null ? UNITS.get(t[i + 1]!) : undefined;
      if (one && one !== 'day' && t[i + 2] === 'dana') return { len: 3, r: agoRange(1, one, today, now) };
      const n = number(t[i + 1] ?? null);
      const unit = n !== null && t[i + 2] != null ? UNITS.get(t[i + 2]!) : undefined;
      return n !== null && unit ? { len: 3, r: agoRange(n, unit, today, now) } : null;
    }
    const n = number(t[i] ?? null);
    const unit = n !== null && t[i + 1] != null ? UNITS.get(t[i + 1]!) : undefined;
    return n !== null && unit && t[i + 2] === 'ago' ? { len: 3, r: agoRange(n, unit, today, now) } : null;
  },
  // last monday / prošlog petka
  (t, i, today, now) => {
    const a = t[i],
      b = t[i + 1];
    if (a == null || b == null) return null;
    const wd = LAST_EN.has(a) ? WEEKDAY_EN.get(b) : LAST_BCS.has(a) ? WEEKDAY_BCS.get(b) : undefined;
    if (wd === undefined) return null;
    const back = (today.getDay() - wd + 7) % 7 || 7;
    return { len: 2, r: dayRange(addDays(today, -back), now, `Last ${WEEKDAYS[wd]}`) };
  },
  // [in|u|during|from] <month> [year], <month> <year>, last <month>, prošlog <month>
  (t, i, today) => {
    const a = t[i];
    if (a == null) return null;
    const prep = MONTH_PREP.has(a);
    const last = LAST_EN.has(a) || LAST_BCS.has(a);
    const mi = prep || last ? i + 1 : i;
    const m = t[mi] != null ? MONTHS.get(t[mi]!) : undefined;
    if (m === undefined) {
      // "in 2025", "u 2025"
      const y = prep ? yearTok(t[i + 1], today) : null;
      return y !== null ? { len: 2, r: yearRange(y, null) } : null;
    }
    const y = last ? null : yearTok(t[mi + 1], today);
    if (y !== null && (prep || !MONTH_ABBR.has(t[mi]!))) {
      if (y === today.getFullYear() && m > today.getMonth()) return null; // future month
      return { len: mi + 2 - i, r: monthRange(y, m, null) };
    }
    if (!prep && !last) return null; // bare month name: too ambiguous ("may", "mart", "maja")
    return { len: mi + 1 - i, r: recentMonth(m, today, last) };
  },
];

/**
 * First time phrase in `tokens` (null entries = quoted phrases, never parsed or crossed).
 * Swallows up to two filler words right before it ("in the", "u").
 */
export function findDatePhrase(tokens: (string | null)[], nowMs: number): DateMatch | null {
  const now = new Date(nowMs);
  const today = day(now.getFullYear(), now.getMonth(), now.getDate());
  const t = tokens.map((x) => (x == null ? null : fold(x)));
  for (let i = 0; i < t.length; i++) {
    if (t[i] == null) continue;
    for (const rule of RULES) {
      const hit = rule(t, i, today, now);
      if (!hit) continue;
      let start = i;
      while (start > 0 && i - start < 2 && t[start - 1] != null && LEAD_FILLER.has(t[start - 1]!)) start--;
      return { ...hit.r, start, end: i + hit.len };
    }
  }
  return null;
}
