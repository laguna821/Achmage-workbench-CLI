import type { Artifact } from "./index.ts";

export type PdfNoteAction = "open" | "insert" | "take";
export type PdfNoteRequest = { type: "office:pdf-note"; requestId: string; action: PdfNoteAction; request?: unknown };
export type PdfNoteReply = { type: "office:pdf-note-result"; requestId: string; value?: unknown; error?: string };
export type PdfNoteResult = { ok: boolean; reason?: "cancelled" | "failed" | "busy" | "unsaved" | "unavailable"; message?: string; choosePath?: string; artifact?: Artifact };
