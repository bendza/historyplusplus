// Remembers the last search URL so "Back" from a page detail returns to the same results.
let last = '#/search';

export function rememberSearch(hash: string) {
  last = hash;
}

export function lastSearchHash(): string {
  return last;
}
