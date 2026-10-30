import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { extname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ScmComparison, ScmComparisonDiff, ScmComparisonFile, ScmComparisonRequest, ScmStatus } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { scmGit, type GitOptions } from "./scm-git.ts";
import { scmFileStamp, scmHash, scmPath, scmPathText } from "./scm-status.ts";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_BLOB = 8 * 1024 * 1024, MAX_PATCH = 512 * 1024;
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames=50%", "-l1000", "--ignore-submodules=none", "--submodule=short"];
const patchFlags = ["--patch", "--full-index", "--unified=3", "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/", "--line-prefix=", "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= "];
const git = (root: string, args: string[], options: GitOptions = {}) => scmGit(root, ["--no-replace-objects", ...args], { signal: AbortSignal.timeout(30_000), ...options, noLazyFetch: true });
const text = async (root: string, args: string[]) => (await git(root, args)).toString("utf8");
function ref(value: unknown, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\0\r\n]/.test(value) || value.startsWith("-")) throw new HttpError(400, "scm_compare_ref", "비교할 브랜치·태그·커밋을 입력하세요.");
  return value.trim();
}
export function comparisonRequest(value: ScmComparisonRequest, defaultBase: string | null): ScmComparisonRequest {
  if (!value || !["combined", "branch", "commit"].includes(value.mode)) throw new HttpError(400, "scm_comparison", "비교 방식을 선택하세요.");
  if (value.mode === "commit") {
    const parent = value.parent ?? 1;
    if (!Number.isInteger(parent) || parent < 1 || parent > 100) throw new HttpError(400, "scm_compare_parent", "비교할 부모 번호를 확인하세요.");
    return { mode: value.mode, headRef: ref(value.headRef, "HEAD"), parent };
  }
  if (value.mergeBase !== undefined && typeof value.mergeBase !== "boolean") throw new HttpError(400, "scm_comparison", "공통 조상 비교 설정을 확인하세요.");
  return { mode: value.mode, baseRef: ref(value.baseRef, defaultBase ?? ""), ...(value.mode === "branch" ? { headRef: ref(value.headRef, "HEAD"), mergeBase: value.mergeBase !== false } : {}) };
}
async function resolveCommit(root: string, value: string) {
  let result: string;
  try { result = (await text(root, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`])).trim(); }
  catch { throw new HttpError(400, "scm_compare_ref", `커밋으로 확인할 수 없는 기준입니다: ${value}`); }
  if (!OID.test(result)) throw new HttpError(400, "scm_compare_ref", "하나의 정확한 커밋을 선택하세요.");
  return result;
}
function parseNames(raw: string): ScmComparisonFile[] {
  const parts = raw.split("\0"), files: ScmComparisonFile[] = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const change = parts[i++]!;
    if (!/^[ACDMRTUXB][0-9]*$/.test(change) || !parts[i]) throw new Error("Git 비교 파일 목록을 읽지 못했습니다.");
    const first = scmPath(parts[i++]!); let path = first, oldPath: string | undefined;
    if (/^[RC]/.test(change)) { if (!parts[i]) throw new Error("Git 이름 변경 경로가 없습니다."); oldPath = first; path = scmPath(parts[i++]!); }
    files.push({ path, ...(oldPath ? { oldPath } : {}), change: change[0]!, conflicted: change === "U", untracked: false, intermediateOnly: false });
  }
  return files;
}
function treeArgs(before: string | null, after: string) { return before ? ["diff", ...diffFlags, before, after] : ["diff-tree", "--root", "--no-commit-id", "-r", ...diffFlags, after]; }
const identity = (root: string, commonDir: string) => { const s = lstatSync(root, { bigint: true }); return JSON.stringify([root, commonDir, String(s.dev), String(s.ino)]); };
const fileStamps = (state: ScmStatus, file: ScmComparisonFile) => JSON.stringify([scmFileStamp(state.root, file.path), ...(file.oldPath ? [scmFileStamp(state.root, file.oldPath)] : [])]);
type Snapshot = { view: ScmComparison; identity: string; localRevision: string; stamps: Map<string, string> };
export type ScmBlob = { kind: "missing" | "file" | "link" | "gitlink" | "directory" | "large"; data: Buffer | null; mode: string | null };
export async function commitBlob(root: string, oid: string | null, path: string): Promise<ScmBlob> {
  if (!oid) return { kind: "missing", data: null, mode: null };
  const raw = scmPathText(await git(root, ["ls-tree", "-z", oid, "--", path]));
  const entry = raw.split("\0").find((line) => line.slice(line.indexOf("\t") + 1) === path);
  if (!entry) return { kind: "missing", data: null, mode: null };
  const match = entry.match(/^(\d{6}) (blob|commit|tree) ([a-f0-9]+)\t/);
  if (!match || !OID.test(match[3]!)) throw new Error("Git 파일 객체를 읽지 못했습니다.");
  const [, mode, type, object] = match;
  if (type === "commit") return { kind: "gitlink", mode: mode!, data: Buffer.from(`Subproject commit ${object}\n`) };
  if (type === "tree") return { kind: "directory", mode: mode!, data: null };
  const size = Number((await text(root, ["cat-file", "-s", object!])).trim());
  if (!Number.isFinite(size) || size < 0) throw new Error("Git 파일 크기를 확인하지 못했습니다.");
  if (size > MAX_BLOB) return { kind: "large", mode: mode!, data: null };
  return { kind: mode === "120000" ? "link" : "file", mode: mode!, data: await git(root, ["cat-file", "blob", object!], { limit: MAX_BLOB }) };
}
export function workingBlob(root: string, path: string): ScmBlob {
  const parts = scmPath(path).replace(/\/$/, "").split("/"); let at = root;
  try {
    for (let i = 0; i < parts.length; i++) {
      at = join(at, parts[i]!); const stat = lstatSync(at);
      if (i < parts.length - 1) { if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HttpError(409, "scm_compare_path", "링크나 파일로 바뀐 상위 폴더를 통해 읽을 수 없습니다."); continue; }
      if (stat.isSymbolicLink()) return { kind: "link", data: Buffer.from(readlinkSync(at)), mode: "120000" };
      if (stat.isDirectory()) return { kind: "directory", data: null, mode: "040000" };
      if (!stat.isFile()) throw new HttpError(409, "scm_compare_path", "일반 파일이 아닌 항목은 직접 확인하세요.");
      return { kind: stat.size > MAX_BLOB ? "large" : "file", data: stat.size > MAX_BLOB ? null : readFileSync(at), mode: stat.mode & 0o111 ? "100755" : "100644" };
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { kind: "missing", data: null, mode: null };
}
function raster(blob: ScmBlob, path: string) { const mime = imageTypes[extname(path).toLowerCase()]; return mime && blob.kind === "file" && blob.data ? `data:${mime};base64,${blob.data.toString("base64")}` : null; }
function fallbackPatch(before: ScmBlob, after: ScmBlob, file: ScmComparisonFile) {
  if ([before, after].some((b) => ["large", "directory", "gitlink"].includes(b.kind))) return { raw: Buffer.alloc(0), notice: "크기가 8 MiB를 넘거나 폴더·서브모듈인 항목입니다. 해당 파일 또는 작업공간에서 확인하세요." };
  const a = before.data ?? Buffer.alloc(0), b = after.data ?? Buffer.alloc(0);
  if (a.equals(b) && before.kind === after.kind && before.mode === after.mode) return { raw: Buffer.alloc(0) };
  try { new TextDecoder("utf-8", { fatal: true }).decode(a); new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch { return { raw: Buffer.from("Binary files differ\n") }; }
  if (a.includes(0) || b.includes(0)) return { raw: Buffer.from("Binary files differ\n") };
  const patch = createTwoFilesPatch(JSON.stringify(`a/${file.oldPath ?? file.path}`), JSON.stringify(`b/${file.path}`), a.toString("utf8"), b.toString("utf8"), undefined, undefined, { context: 3, timeout: 500, maxEditLength: 20000 });
  return { raw: Buffer.from(`${before.mode !== after.mode ? `old mode ${before.mode ?? "missing"}\nnew mode ${after.mode ?? "missing"}\n` : ""}${patch ?? ""}`), ...(patch === undefined ? { notice: "차이 계산 한도를 넘었습니다. 파일 전체를 직접 확인하세요." } : {}) };
}

export class ScmComparisons {
  private snapshots = new Map<string, Snapshot>();
  async create(state: ScmStatus, value: ScmComparisonRequest, defaultBase: string | null): Promise<ScmComparison> {
    const request = comparisonRequest(value, defaultBase); let baseOid: string | null = null, beforeOid: string | null = null, headOid = state.head, parents: string[] = [];
    if (request.mode === "commit") {
      headOid = await resolveCommit(state.root, request.headRef!);
      // Parse the actual object, so shallow boundaries cannot masquerade as root commits.
      const commit = await text(state.root, ["cat-file", "commit", headOid]);
      parents = commit.split("\n\n", 1)[0]!.split("\n").filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
      if (parents.some((oid) => !OID.test(oid)) || request.parent! > Math.max(1, parents.length)) throw new HttpError(400, "scm_compare_parent", "이 커밋에 없는 부모 번호입니다.");
      beforeOid = parents[request.parent! - 1] ?? null; baseOid = beforeOid;
    } else {
      baseOid = request.baseRef ? await resolveCommit(state.root, request.baseRef) : null; beforeOid = baseOid;
      if (request.mode === "branch") {
        if (!baseOid) throw new HttpError(400, "scm_compare_ref", "기준 브랜치를 입력하세요.");
        headOid = await resolveCommit(state.root, request.headRef!);
        if (request.mergeBase) {
          const bases = (await text(state.root, ["merge-base", "--all", baseOid, headOid]).catch(() => "")).trim().split("\n");
          if (bases.length !== 1 || !OID.test(bases[0]!)) throw new HttpError(409, "scm_compare_ancestor", "공통 조상이 없거나 여러 개입니다. 두 끝점 비교를 선택하세요.");
          beforeOid = bases[0]!;
        }
      }
    }
    let files: ScmComparisonFile[];
    if (request.mode === "combined") {
      files = beforeOid ? parseNames(scmPathText(await git(state.root, ["diff", ...diffFlags, "--name-status", "-z", beforeOid, "--"]))) : [];
      const map = new Map(files.map((file) => [file.path, file]));
      for (const local of state.files) {
        let file = map.get(local.path);
        if (!file) { file = { path: local.path, change: beforeOid ? "=" : "A", conflicted: local.conflicted, untracked: false, intermediateOnly: !!beforeOid }; map.set(file.path, file); }
        file.conflicted ||= local.conflicted;
        if (local.index === "?") { file.untracked = true; file.intermediateOnly = false; file.change = file.change === "D" ? "M" : "A"; }
      }
      files = [...map.values()];
    } else files = parseNames(scmPathText(await git(state.root, [...treeArgs(beforeOid, headOid!), "--name-status", "-z", "--"])));
    if (files.length > 20_000) throw new HttpError(413, "scm_too_many_files", "비교 파일이 20,000개를 넘습니다. 기준 범위를 줄여 주세요.");
    files.sort((a, b) => a.path.localeCompare(b.path));
    const createdAt = Date.now(), view: ScmComparison = { id: randomUUID(), workspaceId: state.workspaceId, request, revision: scmHash(JSON.stringify([request, beforeOid, baseOid, headOid, files, request.mode === "combined" ? state.localRevision : null])), baseOid, beforeOid, headOid, after: request.mode === "combined" ? "working" : "commit", parents, files, createdAt, expiresAt: createdAt + 30 * 60_000 };
    for (const [id, entry] of this.snapshots) if (entry.view.expiresAt <= createdAt) this.snapshots.delete(id);
    while (this.snapshots.size >= 32 || [...this.snapshots.values()].reduce((n, e) => n + e.view.files.length, files.length) > 50_000) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(view.id, { view, identity: identity(state.root, state.commonDir), localRevision: state.localRevision, stamps: new Map(view.after === "working" ? files.map((file) => [file.path, fileStamps(state, file)]) : []) });
    return view;
  }
  private snapshot(state: ScmStatus, id: string, revision: string) {
    const entry = this.snapshots.get(id);
    if (!entry || entry.view.workspaceId !== state.workspaceId || entry.view.expiresAt <= Date.now()) throw new HttpError(409, "scm_compare_expired", "비교 기준을 다시 불러오세요. 파일은 변경하지 않았습니다.");
    if (entry.view.revision !== revision || entry.identity !== identity(state.root, state.commonDir)) throw new HttpError(409, "scm_compare_changed", "검토한 저장소나 비교 기준이 바뀌었습니다.");
    if (entry.view.after === "working" && entry.localRevision !== state.localRevision) throw new HttpError(409, "scm_compare_changed", "작업 파일이나 Git 상태가 바뀌었습니다. 비교를 새로고침하세요.");
    return entry;
  }
  view(state: ScmStatus, id: string, revision: string) { return this.snapshot(state, id, revision).view; }
  assertCurrent(state: ScmStatus, view: Pick<ScmComparison, "id" | "revision">) { this.snapshot(state, view.id, view.revision); }
  async diff(state: ScmStatus, id: string, revision: string, path: string): Promise<ScmComparisonDiff> {
    const snapshot = this.snapshot(state, id, revision), view = snapshot.view, file = view.files.find((file) => file.path === path);
    if (!file) throw new HttpError(404, "scm_compare_file", "이 비교 목록에 없는 파일입니다.");
    const assertFile = () => {
      if (view.after !== "working") return;
      if (snapshot.stamps.get(path) !== fileStamps(state, file)) throw new HttpError(409, "scm_compare_changed", "비교 파일이 바뀌었습니다. 새로고침하세요.");
      for (const name of [path, ...(file.oldPath ? [file.oldPath] : [])]) {
        const stamp = scmFileStamp(state.root, name);
        if (stamp[1] === "parent-not-directory" || stamp[1] === "link" && Number(stamp[2]) < name.replace(/\/$/, "").split("/").length - 1) throw new HttpError(409, "scm_compare_path", "링크나 파일로 바뀐 상위 폴더를 통해 읽을 수 없습니다.");
      }
    };
    assertFile();
    if (file.conflicted) return { path, comparisonId: id, comparisonRevision: revision, revision: scmHash(`${revision}:${path}:conflict`), patch: "", binary: false, truncated: false, notice: "충돌 파일입니다. 스테이징·커밋 탭의 3방향 검토에서 해결하세요." };
    let raw: Buffer | undefined, notice: string | undefined, images: ScmComparisonDiff["images"];
    const needsBlobs = !!imageTypes[extname(path).toLowerCase()] || file.untracked || !view.beforeOid && view.after === "working";
    if (needsBlobs) {
      const before = await commitBlob(state.root, view.beforeOid, file.oldPath ?? path), after = view.after === "commit" ? await commitBlob(state.root, view.headOid, path) : workingBlob(state.root, path);
      if (imageTypes[extname(path).toLowerCase()] && ![before, after].some((b) => ["link", "gitlink", "directory"].includes(b.kind))) images = { before: raster(before, file.oldPath ?? path), after: raster(after, path) };
      if (file.untracked || !view.beforeOid && view.after === "working") ({ raw, notice } = fallbackPatch(before, after, file));
    }
    if (!raw) raw = await git(state.root, [...(view.after === "commit" ? treeArgs(view.beforeOid, view.headOid!) : ["diff", ...diffFlags, view.beforeOid!]), ...patchFlags, "--", ...(file.oldPath ? [file.oldPath, path] : [path])]);
    assertFile();
    const patch = raw.toString("utf8"), lines = patch.split("\n"), truncated = raw.length > MAX_PATCH || lines.length > 6000;
    try { new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { notice = "UTF-8로 표시할 수 없는 바이트가 있습니다. 원본 파일의 인코딩으로 확인하세요."; }
    return { path, comparisonId: id, comparisonRevision: revision, revision: scmHash(JSON.stringify([revision, path, scmHash(raw), images])), patch: truncated ? Buffer.from(lines.slice(0, 6000).join("\n")).subarray(0, MAX_PATCH).toString("utf8") : patch, truncated, binary: /^Binary files |^GIT binary patch/m.test(patch) || raw.includes(0), ...(images ? { images } : {}), ...(notice ? { notice } : !patch ? { notice: "기준과 현재 파일의 최종 차이가 없습니다. 중간 스테이징 변경은 스테이징·커밋 탭에서 확인하세요." } : {}) };
  }
  clear() { this.snapshots.clear(); }
}
