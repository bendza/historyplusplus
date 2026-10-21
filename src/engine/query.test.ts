import { describe, expect, it } from 'vitest';
import { lightStem, parseQuery, parseSearch, toFtsLooseMatch, toFtsMatch } from './query';

const NOW = new Date(2025, 9, 13, 15, 0).getTime(); // 2025-10-13 15:00 local

describe('parseQuery', () => {
  it('extracts site (repeatable, cleaned) and leaves text', () => {
    const p = parseQuery('react hooks site:github.com site:https://www.MDN.io/docs  tutorial', NOW);
    expect(p.site).toEqual(['github.com', 'mdn.io']);
    expect(p.text).toBe('react hooks tutorial');
    expect(p.before).toBeNull();
    expect(p.after).toBeNull();
  });

  it('parses day dates in local time (before exclusive, after inclusive start of day)', () => {
    const p = parseQuery('after:2025-09-01 before:2025-09-15 berlin', NOW);
    expect(p.after).toBe(new Date(2025, 8, 1).getTime());
    expect(p.before).toBe(new Date(2025, 8, 15).getTime());
    expect(p.text).toBe('berlin');
  });

  it('parses month granularity', () => {
    const p = parseQuery('after:2025-09 before:2025-10', NOW);
    expect(p.after).toBe(new Date(2025, 8, 1).getTime());
    expect(p.before).toBe(new Date(2025, 9, 1).getTime());
    expect(p.text).toBe('');
  });

  it('parses relative dates', () => {
    expect(parseQuery('after:7d', NOW).after).toBe(new Date(2025, 9, 6).getTime());
    expect(parseQuery('after:1m', NOW).after).toBe(new Date(2025, 8, 13).getTime());
  });

  it('keeps malformed operators as text', () => {
    const p = parseQuery('before:soon after:2025-02-31 site: x', NOW);
    expect(p.before).toBeNull();
    expect(p.after).toBeNull();
    expect(p.text).toBe('before:soon after:2025-02-31 site: x');
  });

  it('is case-insensitive on operator names and keeps quoted phrases intact', () => {
    const p = parseQuery('SITE:a.com "site:b.com in quotes"', NOW);
    expect(p.site).toEqual(['a.com']);
    expect(p.text).toBe('"site:b.com in quotes"');
  });
});

describe('lightStem', () => {
  it('drops one inflectional ending from long plain words only', () => {
    expect(lightStem('sarajevo')).toBe('sarajev');
    expect(lightStem('baščaršija')).toBe('baščaršij');
    expect(lightStem('events')).toBe('event');
    expect(lightStem('berlin')).toBe('berlin');
    expect(lightStem('side')).toBe('side');
    expect(lightStem('wxt.dev')).toBe('wxt.dev');
  });
});

describe('toFtsMatch', () => {
  it('returns null for empty / non-word input', () => {
    expect(toFtsMatch('')).toBeNull();
    expect(toFtsMatch('   ')).toBeNull();
    expect(toFtsMatch('- * ( ) "" :')).toBeNull();
  });

  it('quotes tokens, ANDs them, prefixes the last', () => {
    expect(toFtsMatch('side events berl')).toBe('"side" AND "event"* AND "berl"*');
  });

  it('supports quoted phrases (no prefix on a final phrase)', () => {
    expect(toFtsMatch('"side events" berlin')).toBe('"side events" AND "berlin"*');
    expect(toFtsMatch('berlin "side events"')).toBe('"berlin" AND "side events"');
    expect(toFtsMatch('"unterminated phr')).toBe('"unterminated phr"');
  });

  it('neutralizes hostile FTS syntax', () => {
    expect(toFtsMatch('foo" OR bar*')).toBe('"foo" AND "OR bar*"');
    expect(toFtsMatch('NEAR(')).toBe('"NEAR("*');
    expect(toFtsMatch('x - y')).toBe('"x" AND "y"*');
    expect(toFtsMatch('title:x')).toBe('"title:x"*');
  });

  it('handles unicode and Serbian diacritics', () => {
    expect(toFtsMatch('ćevapi Šabac')).toBe('"ćevap"* AND "Šabac"*');
    expect(toFtsMatch('Београд')).toBe('"Београд"*');
    expect(toFtsMatch('東京 🎉')).toBe('"東京"*');
  });
});

describe('stopwords and loose matching', () => {
  it('drops EN + BCS stopwords (diacritics folded) but keeps an all-stopword query', () => {
    expect(toFtsMatch('what jobs did I look at')).toBe('"jobs"');
    expect(toFtsMatch('ugovor o zajmu za firmu')).toBe('"ugovor" AND "zajm"* AND "firm"*');
    expect(toFtsMatch('što je ovo')).toBe('"što" AND "je" AND "ovo"*');
    expect(toFtsMatch('the "who" band')).toBe('"who" AND "band"*'); // quoted words are never dropped
  });

  it('loose match: OR of every ceil(60%)-of-n AND group; none under 3 terms', () => {
    expect(toFtsLooseMatch('react hooks')).toBeNull();
    expect(toFtsLooseMatch('the react hooks')).toBeNull();
    expect(toFtsLooseMatch('robot window cleaning')).toBe('("robot" AND "window") OR ("robot" AND "cleaning"*) OR ("window" AND "cleaning"*)');
    const five = toFtsLooseMatch('how much do employees earn at a belgrade company')!;
    // terms: much employees earn belgrade company -> 3 of 5 = 10 groups
    expect(five.split(' OR ')).toHaveLength(10);
  });

  it('loose match keeps only the longest terms of very long questions', () => {
    const q = toFtsLooseMatch('aa1 bb2 longword1 longword2 longword3 longword4 longword5 longword6 longword7')!;
    expect(q).toContain('longword1');
    expect(q).not.toContain('"aa1"');
    expect(q).not.toContain('"bb2"');
  });
});

describe('plain-language dates', () => {
  // Wednesday 2026-10-14 15:00 local.
  const NOW2 = new Date(2026, 9, 14, 15, 0).getTime();
  const D = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
  const p = (q: string, now = NOW2) => {
    const r = parseSearch(q, now);
    return { text: r.parsed.text, after: r.parsed.after, before: r.parsed.before, label: r.dateLabel };
  };

  it('today / yesterday, EN and BCS with and without diacritics', () => {
    expect(p('today')).toEqual({ text: '', after: D(2026, 10, 14), before: D(2026, 10, 15), label: 'Today · Oct 14' });
    expect(p('danas')).toMatchObject({ after: D(2026, 10, 14), label: 'Today · Oct 14' });
    for (const q of ['yesterday', 'juče', 'juce', 'jučer', 'jucer', 'Yesterday,'])
      expect(p(q)).toEqual({ text: '', after: D(2026, 10, 13), before: D(2026, 10, 14), label: 'Yesterday · Oct 13' });
    expect(p('prekjučer')).toMatchObject({ after: D(2026, 10, 12), before: D(2026, 10, 13) });
  });

  it('removes the phrase (and a leading preposition) from the text', () => {
    expect(p("yesterday's analytics dashboard").text).toBe('analytics dashboard');
    expect(p('chess games I played last week').text).toBe('chess games I played');
    expect(p('what jobs did I look at in september').text).toBe('what jobs did I look at');
    expect(p('react in the last 3 days').text).toBe('react');
    expect(p('stanovi u zadnjih 7 dana').text).toBe('stanovi');
  });

  it('calendar weeks start on Monday', () => {
    expect(p('this week')).toMatchObject({ after: D(2026, 10, 12), before: D(2026, 10, 19), label: 'This week · Oct 12–18' });
    expect(p('last week')).toMatchObject({ after: D(2026, 10, 5), before: D(2026, 10, 12), label: 'Last week · Oct 5–11' });
    for (const q of ['ove sedmice', 'ove nedelje', 'ove nedjelje', 'ovog tjedna', 'ovaj tjedan'])
      expect(p(q).label).toBe('This week · Oct 12–18');
    for (const q of ['prošle sedmice', 'prosle sedmice', 'prošle nedelje', 'prošle nedjelje', 'prošlog tjedna', 'prošli tjedan', 'prosli tjedan'])
      expect(p(q).label).toBe('Last week · Oct 5–11');
  });

  it('this / last month and year', () => {
    expect(p('this month')).toMatchObject({ after: D(2026, 10, 1), before: D(2026, 11, 1), label: 'This month · October 2026' });
    expect(p('last month')).toMatchObject({ after: D(2026, 9, 1), before: D(2026, 10, 1), label: 'Last month · September 2026' });
    for (const q of ['ovaj mjesec', 'ovog mjeseca', 'ovaj mesec', 'ovog meseca']) expect(p(q).label).toBe('This month · October 2026');
    for (const q of ['prošlog mjeseca', 'proslog meseca', 'prošli mjesec']) expect(p(q).label).toBe('Last month · September 2026');
    expect(p('this year')).toMatchObject({ after: D(2026, 1, 1), before: D(2027, 1, 1), label: 'This year · 2026' });
    expect(p('last year')).toMatchObject({ after: D(2025, 1, 1), before: D(2026, 1, 1), label: 'Last year · 2025' });
    expect(p('ove godine').label).toBe('This year · 2026');
    expect(p('prošle godine').label).toBe('Last year · 2025');
  });

  it('months: most recent occurrence not in the future, in EN / Serbian / Bosnian / Croatian forms', () => {
    expect(p('in september')).toMatchObject({ after: D(2026, 9, 1), before: D(2026, 10, 1), label: 'September 2026' });
    expect(p('in october').label).toBe('October 2026'); // the current month counts
    expect(p('in november')).toMatchObject({ after: D(2025, 11, 1), label: 'November 2025' });
    expect(p('during march').label).toBe('March 2026');
    expect(p('job postings from july')).toMatchObject({ text: 'job postings', label: 'July 2026' });
    for (const q of ['u septembru', 'u rujnu', 'tokom septembra', 'tijekom rujna']) expect(p(q).label).toBe('September 2026');
    expect(p('u avgustu').label).toBe('August 2026');
    expect(p('u kolovozu').label).toBe('August 2026');
    expect(p('u augustu').label).toBe('August 2026');
    expect(p('u maju').label).toBe('May 2026');
    expect(p('u svibnju').label).toBe('May 2026');
    expect(p('u studenom').label).toBe('November 2025');
    expect(p('u prosincu').label).toBe('December 2025');
    expect(p('u veljači').label).toBe('February 2026');
    expect(p('u veljaci').label).toBe('February 2026');
    expect(p('u siječnju').label).toBe('January 2026');
  });

  it('month + year, "in <year>", last <month>', () => {
    expect(p('september 2025')).toMatchObject({ after: D(2025, 9, 1), before: D(2025, 10, 1), label: 'September 2025' });
    expect(p('may 2025 trip')).toMatchObject({ text: 'trip', label: 'May 2025' });
    expect(p('in feb 2025').label).toBe('February 2025');
    expect(p('u martu 2024').label).toBe('March 2024');
    expect(p('in 2025')).toMatchObject({ after: D(2025, 1, 1), before: D(2026, 1, 1), label: '2025' });
    expect(p('last may').label).toBe('May 2026');
    expect(p('last october').label).toBe('October 2025'); // strictly before this month
  });

  it('never reads ordinary words as months', () => {
    for (const q of ['may the force', 'march madness', 'maja i ana', 'mart', 'jun hot', 'Feb 2019 Feb 2020 Telenor', 'sept 2020 resume', 'may 2027'])
      expect(p(q).label).toBeNull();
    expect(p('may 2027').text).toBe('may 2027'); // future year: not a date
  });

  it('N days / weeks / months / years ago (EN + BCS)', () => {
    expect(p('3 days ago')).toEqual({ text: '', after: D(2026, 10, 11), before: D(2026, 10, 12), label: '3 days ago · Oct 11' });
    expect(p('a day ago').label).toBe('Yesterday · Oct 13');
    expect(p('2 weeks ago')).toMatchObject({ after: D(2026, 9, 28), before: D(2026, 10, 5), label: '2 weeks ago · Sep 28 – Oct 4' });
    expect(p('a month ago')).toMatchObject({ after: D(2026, 9, 1), label: '1 month ago · September 2026' });
    expect(p('two years ago').label).toBe('2 years ago · 2024');
    expect(p('prije 3 dana').label).toBe('3 days ago · Oct 11');
    expect(p('pre dva dana').label).toBe('2 days ago · Oct 12');
    expect(p('prije dvije sedmice').label).toBe('2 weeks ago · Sep 28 – Oct 4');
    expect(p('pre mesec dana').label).toBe('1 month ago · September 2026');
    expect(p('prije tjedan dana').label).toBe('1 week ago · Oct 5–11');
    expect(p('prije godinu dana').label).toBe('1 year ago · 2025');
  });

  it('past / last N units are rolling windows ending now', () => {
    expect(p('past 7 days')).toEqual({ text: '', after: D(2026, 10, 8), before: null, label: 'Past 7 days · Oct 8–14' });
    expect(p('last 2 weeks')).toMatchObject({ after: D(2026, 10, 1), label: 'Past 2 weeks · Oct 1–14' });
    expect(p('past 3 months')).toMatchObject({ after: D(2026, 7, 15), label: 'Past 3 months · Jul 15 – Oct 14' });
    expect(p('past week')).toMatchObject({ after: D(2026, 10, 8), label: 'Past week · Oct 8–14' });
    expect(p('zadnjih 7 dana').label).toBe('Past 7 days · Oct 8–14');
    expect(p('posljednja 2 mjeseca').label).toBe('Past 2 months · Aug 15 – Oct 14');
  });

  it('last <weekday>: the most recent one before today', () => {
    expect(p('last monday')).toMatchObject({ after: D(2026, 10, 12), before: D(2026, 10, 13), label: 'Last Monday · Oct 12' });
    expect(p('last wednesday').label).toBe('Last Wednesday · Oct 7');
    expect(p('last friday').label).toBe('Last Friday · Oct 9');
    expect(p('prošlog petka').label).toBe('Last Friday · Oct 9');
  });

  it('labels carry the year only when it is not the current one, across year ends too', () => {
    const jan2 = new Date(2026, 0, 2, 9).getTime(); // a Friday
    expect(p('this week', jan2).label).toBe('This week · Dec 29, 2025 – Jan 4, 2026');
    expect(p('last week', jan2).label).toBe('Last week · Dec 22–28, 2025');
    expect(p('yesterday', jan2).label).toBe('Yesterday · Jan 1');
    expect(p('last month', jan2).label).toBe('Last month · December 2025');
  });

  it('quoted phrases are never parsed; explicit operators win', () => {
    expect(p('"last week" notes')).toMatchObject({ text: '"last week" notes', label: null, after: null });
    const r = p('report last week after:2026-01-01');
    expect(r).toMatchObject({ text: 'report last week', label: null, after: D(2026, 1, 1), before: null });
    expect(p('notes before:2026-05 yesterday')).toMatchObject({ text: 'notes yesterday', label: null });
  });

  it('only the first phrase is used; site: still works alongside', () => {
    const r = parseSearch('site:github.com yesterday last week', NOW2);
    expect(r.parsed.site).toEqual(['github.com']);
    expect(r.dateLabel).toBe('Yesterday · Oct 13');
    expect(r.parsed.text).toBe('last week');
  });

  it('dates: false leaves the text alone', () => {
    expect(parseSearch('posted 4 months ago', NOW2, { dates: false })).toMatchObject({
      parsed: { text: 'posted 4 months ago', after: null },
      dateLabel: null,
    });
  });
});
