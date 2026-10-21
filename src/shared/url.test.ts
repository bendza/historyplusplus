import { describe, expect, it } from 'vitest';
import { domainOf, normalizeUrl } from './url';

describe('normalizeUrl', () => {
  it('lowercases host, strips fragment', () => {
    expect(normalizeUrl('https://GitHub.COM/Foo/Bar#readme')).toBe('https://github.com/Foo/Bar');
  });

  it('strips tracking params and keeps the rest in order', () => {
    expect(normalizeUrl('https://a.com/p?b=2&utm_source=x&a=1&UTM_Medium=y&fbclid=z&gclid=g&mc_eid=m&ref_src=r')).toBe(
      'https://a.com/p?b=2&a=1',
    );
  });

  it('strips secrets: reset and sign-in tokens, signed-URL params, user:password@', () => {
    expect(normalizeUrl('https://a.com/reset?token=abc123&lang=en')).toBe('https://a.com/reset?lang=en');
    expect(normalizeUrl('https://a.com/cb?Access_Token=x&id_token=y&page=2')).toBe('https://a.com/cb?page=2');
    expect(normalizeUrl('https://b.s3.amazonaws.com/f.pdf?X-Amz-Credential=c&X-Amz-Signature=s&v=1')).toBe(
      'https://b.s3.amazonaws.com/f.pdf?v=1',
    );
    expect(normalizeUrl('https://user:hunter2@a.com/x')).toBe('https://a.com/x');
  });

  it('drops an OAuth code only next to a state param', () => {
    expect(normalizeUrl('https://a.com/callback?code=grant&state=s1')).toBe('https://a.com/callback?state=s1');
    expect(normalizeUrl('https://leetcode.com/p?code=1')).toBe('https://leetcode.com/p?code=1');
  });

  it('drops the query entirely when only tracking params remain', () => {
    expect(normalizeUrl('https://a.com/p?utm_source=x')).toBe('https://a.com/p');
  });

  it('does not re-encode untouched params', () => {
    expect(normalizeUrl('https://a.com/s?q=a%20b&x=c+d')).toBe('https://a.com/s?q=a%20b&x=c+d');
  });

  it('drops default ports, keeps others', () => {
    expect(normalizeUrl('https://a.com:443/x')).toBe('https://a.com/x');
    expect(normalizeUrl('http://a.com:80/x')).toBe('http://a.com/x');
    expect(normalizeUrl('http://a.com:8080/x')).toBe('http://a.com:8080/x');
  });

  it('removes trailing slash only for root', () => {
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com');
    expect(normalizeUrl('https://a.com')).toBe('https://a.com');
    expect(normalizeUrl('https://a.com/?utm_source=x#top')).toBe('https://a.com');
    expect(normalizeUrl('https://a.com/docs/')).toBe('https://a.com/docs/');
    expect(normalizeUrl('https://a.com/?q=1')).toBe('https://a.com/?q=1');
  });

  it('passes through unparseable input', () => {
    expect(normalizeUrl('  not a url ')).toBe('not a url');
  });
});

describe('domainOf', () => {
  it('strips leading www and lowercases', () => {
    expect(domainOf('https://WWW.Example.com/x')).toBe('example.com');
    expect(domainOf('https://gist.github.com/')).toBe('gist.github.com');
    expect(domainOf('https://www2.example.com')).toBe('www2.example.com');
  });
  it('returns empty for garbage', () => {
    expect(domainOf('nope')).toBe('');
  });
});
