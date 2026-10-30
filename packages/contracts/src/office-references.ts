import type { DocRef } from "./index.ts";

/** Original Ieum attachment shapes; paths are identities, never filesystem authority. */
export type OfficeAttachment = { path: string; name: string; ext: string; sizeBytes: number };
/** Written by the host from its frozen selection, never accepted from the editor as authority. */
export type OfficeStoredAttachment = OfficeAttachment & { artifactId?: string; fileId?: string };
export type OfficeDocumentChoice = { path: string; name: string; dir: string; group: "open" | "recent"; state: "ok" | "modified" };
export type OfficeReferenceRequest = {
  type: "office:references"; requestId: string;
} & ({ action: "list" | "pick" | "pick-files" } | { action: "upload"; file: File } | { action: "add"; paths: string[] } | { action: "read"; path: string; offset?: number; length?: number } | { action: "read-image"; path: string; frozen?: boolean });
export type OfficeReferenceResult = { type: "office:references-result"; requestId: string; value?: unknown; error?: string };
export type OfficeReferenceSnapshot = { id: string; refs: DocRef[] };
