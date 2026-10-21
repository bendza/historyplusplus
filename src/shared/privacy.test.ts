import { describe, expect, it } from 'vitest';
import { domainMatches, isDomainDenied, isUrlAllowed } from './privacy';

describe('isUrlAllowed', () => {
  it('allows ordinary http(s) pages', () => {
    expect(isUrlAllowed('https://en.wikipedia.org/wiki/SQLite')).toBe(true);
    expect(isUrlAllowed('http://example.com/')).toBe(true);
    expect(isUrlAllowed('https://[2001:4860:4860::8888]/')).toBe(true);
  });

  it('denies non-http schemes', () => {
    for (const u of [
      'chrome://settings',
      'chrome-extension://abc/app.html',
      'file:///etc/passwd',
      'about:blank',
      'data:text/html,hi',
      'edge://flags',
      'view-source:https://example.com',
      'ftp://example.com',
      'not a url',
    ]) {
      expect(isUrlAllowed(u), u).toBe(false);
    }
  });

  it('denies localhost, .local and private IPs', () => {
    for (const u of [
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://printer.local/',
      'http://router/',
      'http://10.0.0.1/',
      'http://172.16.5.4/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://127.0.0.1:8080/',
      'http://169.254.169.254/latest',
      'http://[::1]:3000/',
      'http://[fd12:3456::1]/',
      'http://[fc00::1]/',
    ]) {
      expect(isUrlAllowed(u), u).toBe(false);
    }
    expect(isUrlAllowed('http://172.32.0.1/')).toBe(true);
    expect(isUrlAllowed('http://8.8.8.8/')).toBe(true);
  });

  it('denies built-in sensitive domains', () => {
    for (const u of [
      'https://mail.google.com/mail/u/0/',
      'https://outlook.live.com/mail/',
      'https://outlook.office.com/',
      'https://www.paypal.com/myaccount',
      'https://accounts.google.com/signin',
      'https://login.example.com/',
      'https://my.1password.com/',
      'https://vault.bitwarden.com/',
      'https://www.lastpass.com/',
      'https://www.examplebank.com/',
      'https://online.bankofamerica.com/',
      'https://mychart.somehospital.org/',
    ]) {
      expect(isUrlAllowed(u), u).toBe(false);
    }
    expect(isUrlAllowed('https://www.google.com/search?q=x')).toBe(true);
    expect(isUrlAllowed('https://github.com/login')).toBe(true); // path, not host
  });

  it('applies the user denylist as a domain suffix', () => {
    const s = { denylist: ['reddit.com', ' .Example.org '] };
    expect(isUrlAllowed('https://old.reddit.com/r/x', s)).toBe(false);
    expect(isUrlAllowed('https://reddit.com/', s)).toBe(false);
    expect(isUrlAllowed('https://notreddit.com/', s)).toBe(true);
    expect(isUrlAllowed('https://a.example.org/', s)).toBe(false);
  });
});

describe('domainMatches / isDomainDenied', () => {
  it('suffix matches on label boundaries', () => {
    expect(domainMatches('gist.github.com', 'github.com')).toBe(true);
    expect(domainMatches('github.com', 'github.com')).toBe(true);
    expect(domainMatches('notgithub.com', 'github.com')).toBe(false);
    expect(domainMatches('a.b.com', '*.b.com')).toBe(true);
    expect(domainMatches('login.foo.io', 'login.*')).toBe(true);
    expect(domainMatches('foo.login.io', 'login.*')).toBe(false);
  });

  it('covers banks, mail and tax sites outside the US big names', () => {
    for (const host of ['www.hsbc.co.uk', 'hsbc.com', 'app.monzo.com', 'www.barclays.co.uk', 'mail.zoho.com', 'app.tuta.com', 'www.gmx.net', 'sa.www4.irs.gov']) {
      expect(isDomainDenied(host), host).toBe(true);
    }
    for (const host of ['www.dailymail.co.uk', 'en.wikipedia.org', 'github.com', 'news.ycombinator.com']) {
      expect(isDomainDenied(host), host).toBe(false);
    }
  });

  it('isDomainDenied combines defaults and user list', () => {
    expect(isDomainDenied('mail.google.com')).toBe(true);
    expect(isDomainDenied('news.ycombinator.com')).toBe(false);
    expect(isDomainDenied('news.ycombinator.com', { denylist: ['ycombinator.com'] })).toBe(true);
  });
});
