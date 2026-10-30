import type { DocRef } from "./index.ts";

/** Original Ieum attachment shapes; paths are identities, never filesystem authority. */
export type OfficeAttachment = { path: string; name: string; ext: string; sizeBytes: number };
export type OfficeDocumentChoice = { path: string; name: string; dir: string; group: "open" | "recent"; state: "ok" | "modified" };
export type OfficeReferenceRequest = {
  type: "office:references"; requestId: string;
} & ({ action: "list" | "pick" } | { action: "add"; paths: string[] } | { action: "read"; path: string; offset?: number; length?: number });
export type OfficeReferenceResult = { type: "office:references-result"; requestId: string; value?: unknown; error?: string };
export type OfficeReferenceSnapshot = { id: string; refs: DocRef[] };
