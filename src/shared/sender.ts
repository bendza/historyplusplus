// Who sent a runtime message. Content scripts run inside web pages, and Chrome treats them as
// less trusted than extension pages (a compromised renderer can send anything they can), so only
// the extension's own pages may drive the engine; tabs may only report their own capture/dwell.
// Pure functions only: no browser APIs, so they are unit-testable in node.

export interface SenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

/** From one of our own pages (app, popup, offscreen document, background), not a content script. */
export function isExtensionPage(sender: SenderLike, runtimeId: string, extensionBase: string): boolean {
  return sender.id === runtimeId && !!sender.url && sender.url.startsWith(extensionBase);
}

/** From our own background or offscreen document: an extension page that isn't in a tab. */
export function isExtensionContext(sender: SenderLike, runtimeId: string, extensionBase: string): boolean {
  return isExtensionPage(sender, runtimeId, extensionBase) && !sender.tab;
}

/** A content script reporting on its own page: `url` must be on the sending tab's origin. */
export function isOwnPageReport(sender: SenderLike, runtimeId: string, url: string): boolean {
  if (sender.id !== runtimeId || !sender.tab || !sender.url) return false;
  try {
    return new URL(url).origin === new URL(sender.url).origin;
  } catch {
    return false;
  }
}
