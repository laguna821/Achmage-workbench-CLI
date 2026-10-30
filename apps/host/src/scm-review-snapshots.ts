import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { scmPatchRows, type ScmComparisonDiff, type ScmDiff, type ScmReviewAnchor, type ScmReviewPlacement, type ScmReviewSelection, type ScmReviewSnapshot, type ScmReviewSource, type ScmStatus } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { commitBlob, workingBlob, type ScmBlob } from "./scm-comparison.ts";
import { scmGit } from "./scm-git.ts";
import { scmHash, scmPathText } from "./scm-status.ts";

type Text = { lines: string[]; hash: string };
type Entry = { info: ScmReviewSnapshot; workspaceId: string; anchor: ScmReviewAnchor; before: Text | null; after: Text | null; visible: { before: Set<number>; after: Set<number> }; weight: number };
const LIMIT = 2 * 1024 * 1024;
const git = (root: string, args: string[], limit?: number) => scmGit(root, ["--no-replace-objects", ...args], { noLazyFetch: true, signal: AbortSignal.timeout(30_000), ...(limit ? { limit } : {}) });
async function indexBlob(root: string, path: string): Promise<ScmBlob> {
  const entries = scmPathText(await git(root, ["ls-files", "--stage", "-z", "--", path])).split("\0");
  const entry = entries.find((line) => line.slice(line.indexOf("\t") + 1) === path && /^\d{6} [a-f0-9]+ 0\t/.test(line));
  if (!entry) return { kind: "missing", mode: null, data: null };
  const [mode, oid] = entry.split(" ");
  if (mode !== "100644" && mode !== "100755") return { kind: "link", mode: mode!, data: null };
  const size = Number((await git(root, ["cat-file", "-s", oid!])).toString("utf8").trim());
  if (!Number.isFinite(size) || size < 0 || size > LIMIT) return { kind: "large", mode: mode!, data: null };
  return { kind: "file", mode: mode!, data: await git(root, ["cat-file", "blob", oid!], LIMIT) };
}
function asText(blob: ScmBlob): Text | null {
  if (blob.kind === "missing") return { lines: [], hash: scmHash("") };
  if (blob.kind !== "file" || !blob.data || blob.data.length > LIMIT || blob.data.includes(0)) return null;
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob.data), lines = value.split("\n");
    if (value.endsWith("\n")) lines.pop();
    if (!value) lines.length = 0;
    if (lines.length > 50_000) return null;
    return { lines: lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line), hash: scmHash(blob.data) };
  } catch { return null; }
}
function sameScope(a: ScmReviewAnchor, b: ScmReviewAnchor) {
  const x = a.source, y = b.source;
  if (x.kind !== y.kind) return false;
  if (x.kind === "local" && y.kind === "local") return x.area === y.area && !(a.selection?.side === "before" && x.area === "staged" && x.head !== y.head);
  if (x.kind === "comparison" && y.kind === "comparison") {
    if (JSON.stringify(x.request) !== JSON.stringify(y.request)) return false;
    if (x.request.mode === "commit") return x.beforeOid === y.beforeOid && x.headOid === y.headOid;
    return a.selection?.side !== "before" || x.beforeOid === y.beforeOid;
  }
  return false;
}
export class ScmReviewSnapshots {
  private entries = new Map<string, Entry>();
  clear() { this.entries.clear(); }
  async capture(state: ScmStatus, diff: ScmDiff | ScmComparisonDiff, source: ScmReviewSource, oldPath?: string, unavailable = false): Promise<ScmReviewSnapshot> {
    let before: Text | null = null, after: Text | null = null;
    const parsed = scmPatchRows(diff.patch);
    let reason = unavailable || diff.binary || diff.truncated || !parsed.valid ? "이 비교는 파일 의견을 남길 수 있습니다. 행 의견은 완전한 단일 텍스트 비교에서 지원합니다." : "";
    if (!reason) {
      try {
        const blobs = source.kind === "local"
          ? await Promise.all([source.area === "staged" ? commitBlob(state.root, state.head, oldPath ?? diff.path) : indexBlob(state.root, diff.path), source.area === "staged" ? indexBlob(state.root, diff.path) : workingBlob(state.root, diff.path)])
          : await Promise.all([commitBlob(state.root, source.beforeOid, oldPath ?? diff.path), source.after === "commit" ? commitBlob(state.root, source.headOid, diff.path) : workingBlob(state.root, diff.path)]);
        [before, after] = blobs.map(asText) as [Text | null, Text | null];
        if (!before || !after) reason = "행 의견은 UTF-8 일반 파일 2 MiB·5만 행 이내에서 지원합니다. 파일 의견을 남길 수 있습니다.";
        else for (const row of parsed.rows) for (const side of ["before", "after"] as const) if (row[side] !== undefined) {
          const text = row.text.slice(1).replace(/\r$/, ""), line = row[side]!;
          if ((side === "before" ? before : after).lines[line - 1] !== text) reason = "표시된 차이와 원본 행이 다릅니다. 파일 의견을 사용하세요.";
        }
      } catch { reason = "원본 텍스트를 확인하지 못했습니다. 파일 의견을 남기거나 비교를 다시 불러오세요."; }
    }
    const now = Date.now(), info: ScmReviewSnapshot = { id: randomUUID(), expiresAt: now + 30 * 60_000, lines: !reason, ...(reason ? { reason } : {}) };
    if (reason) { before = null; after = null; }
    const weight = JSON.stringify([before, after]).length * 2 + parsed.rows.length * 32;
    for (const [id, entry] of this.entries) if (entry.info.expiresAt <= now) this.entries.delete(id);
    while (this.entries.size && (this.entries.size >= 32 || [...this.entries.values()].reduce((n, e) => n + e.weight, weight) > 32 * 1024 * 1024)) this.entries.delete(this.entries.keys().next().value!);
    const visible = { before: new Set<number>(), after: new Set<number>() };
    if (!reason) for (const row of parsed.rows) for (const side of ["before", "after"] as const) if (row[side] !== undefined) visible[side].add(row[side]!);
    const repositoryId = scmHash(JSON.stringify([state.root, state.commonDir, ...[state.root, state.commonDir].map((path) => { const stat = lstatSync(path, { bigint: true }); return [String(stat.dev), String(stat.ino)]; })]));
    this.entries.set(info.id, { info, workspaceId: state.workspaceId, before, after, visible, weight, anchor: { repositoryId, path: diff.path, ...(oldPath ? { oldPath } : {}), source, diffRevision: diff.revision, selection: null, quote: [], prefix: [], suffix: [], contentHash: null } });
    return info;
  }
  private get(workspaceId: string, id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.workspaceId !== workspaceId || entry.info.expiresAt <= Date.now()) throw new HttpError(409, "scm_review_expired", "검토 화면이 만료되었습니다. 입력한 의견을 유지한 채 파일 비교를 다시 불러오세요.");
    return entry;
  }
  anchor(workspaceId: string, id: string, selection: ScmReviewSelection | null): ScmReviewAnchor {
    const entry = this.get(workspaceId, id);
    if (selection === null) return structuredClone(entry.anchor);
    if (!selection || !["before", "after"].includes(selection.side) || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) || selection.start < 1 || selection.end < selection.start || selection.end - selection.start >= 100) throw new HttpError(400, "scm_review_range", "의견의 행 범위를 1~100행 이내로 선택하세요.");
    const text = entry[selection.side];
    if (!entry.info.lines || !text) throw new HttpError(409, "scm_review_lines", entry.info.reason ?? "행 원문을 확인할 수 없습니다.");
    for (let line = selection.start; line <= selection.end; line++) if (!entry.visible[selection.side].has(line)) throw new HttpError(400, "scm_review_range", "표시된 연속 행 안에서 범위를 선택하세요.");
    const quote = text.lines.slice(selection.start - 1, selection.end), prefix = text.lines.slice(Math.max(0, selection.start - 4), selection.start - 1), suffix = text.lines.slice(selection.end, selection.end + 3);
    if (Buffer.byteLength(JSON.stringify([quote, prefix, suffix])) > 64 * 1024) throw new HttpError(413, "scm_review_range", "선택 원문이 64 KiB를 넘습니다. 행 범위를 줄이세요.");
    return { ...structuredClone(entry.anchor), selection: { side: selection.side, start: selection.start, end: selection.end }, quote, prefix, suffix, contentHash: text.hash };
  }
  place(workspaceId: string, id: string | undefined, anchor: ScmReviewAnchor): ScmReviewPlacement {
    if (!id) return { kind: "unavailable" };
    let entry: Entry;
    try { entry = this.get(workspaceId, id); } catch { return { kind: "unavailable" }; }
    if (anchor.path !== entry.anchor.path && anchor.path !== entry.anchor.oldPath) return { kind: "other-file" };
    if (anchor.repositoryId !== entry.anchor.repositoryId || !sameScope(anchor, entry.anchor)) return { kind: "other-scope" };
    const range = anchor.selection;
    if (!range) return { kind: "file" };
    const text = entry[range.side];
    if (!text) return { kind: "unavailable" };
    if (text.hash === anchor.contentHash) return { kind: anchor.path === entry.anchor.path ? "same" : "moved", start: range.start, end: range.end };
    const matches: number[] = [];
    for (let i = 0; i <= text.lines.length - anchor.quote.length; i++) if (anchor.quote.every((line, n) => text.lines[i + n] === line)) matches.push(i);
    let candidates = matches;
    if (matches.length > 1) candidates = matches.filter((i) => anchor.prefix.every((line, n) => text.lines[i - anchor.prefix.length + n] === line) && anchor.suffix.every((line, n) => text.lines[i + anchor.quote.length + n] === line));
    if (!matches.length) return { kind: "changed" };
    if (candidates.length !== 1) return { kind: "ambiguous" };
    const start = candidates[0]! + 1;
    return { kind: start === range.start && anchor.path === entry.anchor.path ? "same" : "moved", start, end: start + anchor.quote.length - 1 };
  }
}
