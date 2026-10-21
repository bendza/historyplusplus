import { describe, expect, it } from 'vitest';
import { isExtensionContext, isExtensionPage, isOwnPageReport } from './sender';

const ID = 'abcdefghijklmnop';
const BASE = `chrome-extension://${ID}/`;

describe('isExtensionPage', () => {
  it('accepts our own pages, in a tab or not', () => {
    expect(isExtensionPage({ id: ID, url: `${BASE}app.html#/search`, tab: { id: 1 } }, ID, BASE)).toBe(true);
    expect(isExtensionPage({ id: ID, url: `${BASE}popup.html` }, ID, BASE)).toBe(true);
  });
  it('rejects content scripts and other extensions', () => {
    expect(isExtensionPage({ id: ID, url: 'https://evil.example/', tab: { id: 1 } }, ID, BASE)).toBe(false);
    expect(isExtensionPage({ id: 'other', url: 'chrome-extension://other/app.html' }, ID, BASE)).toBe(false);
    expect(isExtensionPage({ id: ID }, ID, BASE)).toBe(false);
  });
});

describe('isExtensionContext', () => {
  it('accepts the background and offscreen document only', () => {
    expect(isExtensionContext({ id: ID, url: `${BASE}background.js` }, ID, BASE)).toBe(true);
    expect(isExtensionContext({ id: ID, url: `${BASE}offscreen.html` }, ID, BASE)).toBe(true);
    expect(isExtensionContext({ id: ID, url: `${BASE}app.html`, tab: { id: 1 } }, ID, BASE)).toBe(false);
    expect(isExtensionContext({ id: ID, url: 'https://evil.example/', tab: { id: 1 } }, ID, BASE)).toBe(false);
  });
});

describe('isOwnPageReport', () => {
  const tab = { id: 1 };
  it('accepts a report about the sending page, including an older URL on the same site', () => {
    expect(isOwnPageReport({ id: ID, url: 'https://a.com/x', tab }, ID, 'https://a.com/x')).toBe(true);
    expect(isOwnPageReport({ id: ID, url: 'https://a.com/new', tab }, ID, 'https://a.com/old')).toBe(true);
  });
  it('rejects reports about other sites, or from outside a tab', () => {
    expect(isOwnPageReport({ id: ID, url: 'https://evil.example/', tab }, ID, 'https://bank.com/')).toBe(false);
    expect(isOwnPageReport({ id: ID, url: 'https://a.com/' }, ID, 'https://a.com/')).toBe(false);
    expect(isOwnPageReport({ id: 'other', url: 'https://a.com/', tab }, ID, 'https://a.com/')).toBe(false);
    expect(isOwnPageReport({ id: ID, url: 'https://a.com/', tab }, ID, 'not a url')).toBe(false);
  });
});
