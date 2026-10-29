/** Live editor views. These records do not own files, revisions, AI turns or saved layouts. */
export type DocumentPresence = {
  viewId: string;
  windowId: string;
  artifactId: string;
  sessionId: string | null;
  label: string;
  mode: "write" | "read";
  dirty: boolean;
  revision: number;
  expiresAt: number;
};
export type DocumentViewInput = {
  viewId: string;
  windowId: string;
  sessionId?: string | null;
  label?: string;
  /** Claim explicitly on open or on the user's request; a heartbeat never takes over. */
  claim?: boolean;
  dirty?: boolean;
  revision?: number;
};
export type DocumentRegistration = {
  view: DocumentPresence;
  writer: DocumentPresence | null;
  writeToken: string | null;
};
/** A scoped UI write. An expired capability never falls back to an unscoped API write. */
export type DocumentAccess = { viewId: string; writeToken: string | null };
