/** Remembers recently recorded keys so overlapping events (onVisited + onHistoryStateUpdated) record once. */
export class RecentKeys {
  private seen = new Map<string, number>();
  constructor(private windowMs = 2000) {}

  /** Returns true if `key` was not recorded within the window, and remembers it. */
  shouldRecord(key: string, now = Date.now()): boolean {
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.seen.set(key, now);
    if (this.seen.size > 500) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [k, ts] of this.seen) if (now - ts >= this.windowMs) this.seen.delete(k);
  }
}

/** Page identity for SPA change detection: drop plain anchors (#section) but keep hash routes (#/x, #!/x). */
export function pageKey(url: string): string {
  const i = url.indexOf('#');
  if (i === -1) return url;
  const hash = url.slice(i + 1);
  return hash.startsWith('/') || hash.startsWith('!') ? url : url.slice(0, i);
}
