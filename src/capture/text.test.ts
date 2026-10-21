import { describe, expect, it } from 'vitest';
import { capText, htmlToText, normalizeLang, normalizeText } from './text';

describe('text helpers', () => {
  it('htmlToText keeps paragraph breaks and decodes entities', () => {
    const html = '<h1>Title</h1><p>Hello&nbsp;<b>world</b> &amp; co&#33;</p><script>bad()</script><ul><li>a</li><li>b</li></ul>';
    expect(normalizeText(htmlToText(html))).toBe('Title\n\nHello world & co!\n\na\n\nb');
  });

  it('normalizeText collapses whitespace', () => {
    expect(normalizeText('  a \t b\r\n\n\n\n c  ')).toBe('a b\n\nc');
  });

  it('capText caps without splitting surrogate pairs', () => {
    expect(capText('abcdef', 3)).toBe('abc');
    expect(capText('ab\u{1F600}', 3)).toBe('ab');
    expect(capText('abc', 10)).toBe('abc');
  });

  it('normalizeLang', () => {
    expect(normalizeLang('en_US ')).toBe('en-us');
    expect(normalizeLang('')).toBeNull();
    expect(normalizeLang(null)).toBeNull();
    expect(normalizeLang('not a lang')).toBeNull();
  });
});
