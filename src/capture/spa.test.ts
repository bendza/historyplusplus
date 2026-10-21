import { describe, expect, it } from 'vitest';
import { RecentKeys, pageKey } from './spa';

describe('RecentKeys', () => {
  it('dedupes the same key within the window', () => {
    const r = new RecentKeys(2000);
    expect(r.shouldRecord('a', 1000)).toBe(true);
    expect(r.shouldRecord('a', 2500)).toBe(false);
    expect(r.shouldRecord('b', 2500)).toBe(true);
    expect(r.shouldRecord('a', 3001)).toBe(true);
  });
});

describe('pageKey', () => {
  it('ignores plain anchors but keeps hash routes', () => {
    expect(pageKey('https://x.com/a#section')).toBe('https://x.com/a');
    expect(pageKey('https://x.com/#/inbox')).toBe('https://x.com/#/inbox');
    expect(pageKey('https://x.com/#!/inbox')).toBe('https://x.com/#!/inbox');
    expect(pageKey('https://x.com/a')).toBe('https://x.com/a');
  });
});
