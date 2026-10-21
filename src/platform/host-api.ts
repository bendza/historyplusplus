// The "engine host" owns the SQLite engine worker, the embedding worker and the model download.
// Chromium (MV3): it lives in the offscreen document and the background talks to it by runtime
// messages (OffscreenHost below). Firefox (MV2): no offscreen API, so the persistent background
// page hosts it directly (src/platform/engine-host.ts). UI pages never see the difference: they
// always message the background ({to:'bg'}), see src/shared/protocol.ts.
import type { EngineRequest, EngineResponse, ModelState, Settings } from '../shared/protocol';

export interface BackupBlob {
  url: string; // blob: URL owned by the host; revoke with revokeBlob when the download is done
  bytes: number;
}

export interface HostApi {
  engine(req: EngineRequest): Promise<EngineResponse>;
  settings(s: Settings): void;
  model(action: 'download' | 'remove'): Promise<void>;
  backupBlob(): Promise<BackupBlob>;
  revokeBlob(url: string): void;
}

// ---- internal background <-> offscreen messages (not part of the UI contract) ----
export type HostMessage =
  | { to: 'offscreen'; kind: 'model'; action: 'download' | 'remove' }
  | { to: 'offscreen'; kind: 'backupBlob' }
  | { to: 'offscreen'; kind: 'revokeBlob'; url: string };

/** Host -> background: model state changes (offscreen documents can't write chrome.storage). */
export interface ModelStateMessage {
  to: 'bg';
  kind: 'modelState';
  state: ModelState;
  /** Sent once when the host starts: what Cache Storage actually holds. */
  init?: boolean;
}

export type HostReply<T> = { ok: true; result: T } | { ok: false; error: string };
