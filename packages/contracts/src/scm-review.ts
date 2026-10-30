import type { Provider, SessionStatus } from "./index.ts";
import type { ScmArea, ScmComparisonRequest } from "./source-control.ts";

export type ScmReviewSide = "before" | "after";
export type ScmReviewSelection = { side: ScmReviewSide; start: number; end: number };
export type ScmReviewSource =
  | { kind: "local"; area: ScmArea; head: string | null; statusRevision: string }
  | { kind: "comparison"; request: ScmComparisonRequest; beforeOid: string | null; headOid: string | null; after: "working" | "commit" };
export type ScmReviewSnapshot = { id: string; expiresAt: number; lines: boolean; reason?: string };
export type ScmReviewAnchor = {
  repositoryId: string;
  path: string; oldPath?: string; source: ScmReviewSource; diffRevision: string;
  selection: ScmReviewSelection | null; quote: string[]; prefix: string[]; suffix: string[]; contentHash: string | null;
};
export type ScmReviewNote = {
  id: string; workspaceId: string; version: number; anchor: ScmReviewAnchor; body: string;
  resolved: boolean; deleted: boolean; createdAt: number; updatedAt: number;
};
export type ScmReviewCreate = { requestId: string; snapshotId: string; selection: ScmReviewSelection | null; body: string };
export type ScmReviewEdit = { version: number; body?: string; resolved?: boolean; deleted?: boolean };
export type ScmReviewPlacement = { kind: "same" | "moved" | "changed" | "ambiguous" | "unavailable" | "other-file" | "other-scope" | "file"; start?: number; end?: number };
export type ScmReviewTarget = { id: string; purpose: string; provider: Provider; status: SessionStatus };
export type ScmReviewBatchRequest = { requestId: string; sessionId: string; notes: { id: string; version: number }[] };
export type ScmReviewBatch = {
  id: string; workspaceId: string; requestId: string; fingerprint: string; sessionId: string; target: ScmReviewTarget;
  notes: ScmReviewNote[]; text: string; phase: "sending" | "queued" | "accepted" | "failed" | "uncertain" | "changed";
  detail: string | null; createdAt: number; updatedAt: number;
};
export type ScmReviewList = { notes: ScmReviewNote[]; placements: Record<string, ScmReviewPlacement>; batches: ScmReviewBatch[]; targets: ScmReviewTarget[] };

/** One file, ordinary unified diff. Counters distinguish code starting +++/--- from headers. */
export type ScmPatchRow = { text: string; kind: "hunk" | "add" | "del" | "context" | "meta"; before?: number; after?: number };
export function scmPatchRows(patch: string): { rows: ScmPatchRow[]; valid: boolean } {
  let old = 0, next = 0, oldLeft = 0, nextLeft = 0, files = 0, valid = true, hunks = 0;
  const rows = patch.split("\n").map((text): ScmPatchRow => {
    if (/^diff --(?:git|cc|combined) /.test(text)) { files++; if (oldLeft || nextLeft || !text.startsWith("diff --git ")) valid = false; }
    const match = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      if (oldLeft || nextLeft) valid = false;
      old = Number(match[1]); next = Number(match[3]); oldLeft = Number(match[2] ?? 1); nextLeft = Number(match[4] ?? 1); hunks++;
      if (![old, next, oldLeft, nextLeft].every(Number.isSafeInteger)) valid = false;
      return { text, kind: "hunk" };
    }
    if ((oldLeft || nextLeft) && /^[ +\-]/.test(text)) {
      const kind = text[0] === "+" ? "add" : text[0] === "-" ? "del" : "context";
      const row: ScmPatchRow = { text, kind };
      if (kind !== "add") { if (oldLeft <= 0 || old <= 0) valid = false; row.before = old++; oldLeft--; }
      if (kind !== "del") { if (nextLeft <= 0 || next <= 0) valid = false; row.after = next++; nextLeft--; }
      return row;
    }
    if ((oldLeft || nextLeft) && !text.startsWith("\\ No newline")) valid = false;
    return { text, kind: "meta" };
  });
  return { rows, valid: valid && files <= 1 && hunks > 0 && oldLeft === 0 && nextLeft === 0 };
}
