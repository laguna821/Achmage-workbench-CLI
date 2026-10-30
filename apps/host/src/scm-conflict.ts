import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ScmConflict, ScmConflictVersion, ScmResolution, ScmStatus } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { scmGit, scmText, type GitOptions } from "./scm-git.ts";
import { scmFileStamp, scmHash, scmPath } from "./scm-status.ts";

const TEXT_LIMIT = 2 * 1024 * 1024, FILE_LIMIT = 16 * 1024 * 1024, RECOVERY_LIMIT = 128 * 1024 * 1024;
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const missing = (): ScmConflictVersion => ({ kind: "missing", oid: null, mode: null, bytes: 0, text: null });
const conflictError = (message: string) => new HttpError(409, "scm_conflict", message);
export const hasConflictMarkers = (text: string, size = 7) => new RegExp(`^(?:<{${size},}|\\|{${size},}|={${size},}|>{${size},})(?:[^\\r\\n]*)\\r?$`, "m").test(text);

/** Never traverse a parent symlink; the final symlink itself is an inspectable Git object. */
function targetPath(root: string, path: string, createParents = false) {
  scmPath(path); const parts = path.split("/"); let at = root;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    try { const stat = lstatSync(at); if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflictError("파일의 상위 경로가 링크이거나 폴더가 아닙니다. 터미널에서 경로를 확인하세요."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (createParents) mkdirSync(at); }
  }
  return join(root, path);
}
function rawFile(root: string, path: string, limit = FILE_LIMIT): { mode: string; bytes: number; data: Buffer | null; kind: "file" | "link" | "directory" | "missing" } {
  const target = targetPath(root, path);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) { const data = Buffer.from(readlinkSync(target)); return { kind: "link", mode: "120000", bytes: data.length, data }; }
    if (stat.isDirectory()) return { kind: "directory", mode: "040000", bytes: 0, data: null };
    if (!stat.isFile()) throw conflictError("일반 파일과 Git 링크만 검토할 수 있습니다.");
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) throw conflictError("파일을 읽는 동안 경로가 바뀌었습니다.");
      const data = current.size <= limit ? readFileSync(fd) : null;
      if (data && data.length > limit) throw conflictError("파일을 읽는 동안 크기 제한을 넘었습니다. 새로고침하세요.");
      return { kind: "file", mode: current.mode & 0o111 ? "100755" : "100644", bytes: current.size, data };
    } finally { closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", mode: "", bytes: 0, data: null }; throw error; }
}
function describe(data: Buffer | null, bytes: number, mode: string, oid: string | null, path: string): ScmConflictVersion {
  if (mode === "160000" || mode === "040000") return { kind: mode === "160000" ? "gitlink" : "directory", oid, mode, bytes, text: null };
  if (!data) return { kind: "large", oid, mode, bytes, text: null };
  let text: string | null = null;
  if (bytes <= TEXT_LIMIT && !data.includes(0)) { try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch { /* Non-UTF8 bytes must never be silently rewritten. */ } }
  const mime = imageTypes[extname(path).toLowerCase()];
  return { kind: mode === "120000" ? "symlink" : text !== null ? "text" : bytes > TEXT_LIMIT ? "large" : "binary", oid, mode, bytes, text,
    ...(mime && bytes <= 8 * 1024 * 1024 && mode !== "120000" ? { image: `data:${mime};base64,${data.toString("base64")}` } : {}) };
}
export async function readScmConflict(state: ScmStatus, path: string): Promise<ScmConflict> {
  scmPath(path);
  if (!state.files.some((file) => file.path === path && file.conflicted)) throw conflictError("현재 충돌 목록에 없는 파일입니다. 변경 목록을 새로고침하세요.");
  const before = JSON.stringify(scmFileStamp(state.root, path));
  const raw = await scmText(state.root, ["ls-files", "--unmerged", "-z", "--", path]);
  const attribute = (await scmText(state.root, ["check-attr", "-z", "conflict-marker-size", "--", path])).split("\0")[2];
  const parsedSize = Number(attribute), markerSize = Number.isSafeInteger(parsedSize) && parsedSize > 0 && parsedSize <= 1024 ? parsedSize : 7;
  const versions: Record<string, ScmConflictVersion> = { "1": missing(), "2": missing(), "3": missing() };
  for (const entry of raw.split("\0").filter(Boolean)) {
    const match = entry.match(/^([0-7]{6}) ([a-f0-9]{40,64}) ([123])\t([\s\S]*)$/);
    if (!match || match[4] !== path) throw conflictError("Git 충돌 단계를 확인하지 못했습니다.");
    const [, mode, oid, stage] = match as [string, string, string, string, string];
    const size = mode === "160000" ? 0 : Number((await scmText(state.root, ["cat-file", "-s", oid])).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw conflictError("Git 파일 크기를 확인하지 못했습니다.");
    const data = mode === "160000" || size > FILE_LIMIT ? null : await scmGit(state.root, ["cat-file", "blob", oid], { limit: FILE_LIMIT });
    versions[stage] = describe(data, size, mode, oid, path);
  }
  const working = rawFile(state.root, path), description = working.kind === "missing" ? missing() : describe(working.data, working.bytes, working.mode, null, path);
  if (before !== JSON.stringify(scmFileStamp(state.root, path))) throw conflictError("충돌 파일을 읽는 동안 내용이 바뀌었습니다. 새로고침하세요.");
  return { path, statusRevision: state.revision, revision: scmHash(JSON.stringify([state.revision, raw, markerSize, before, working.data ? scmHash(working.data) : working.kind])), operation: state.operation, markerSize, base: versions["1"]!, ours: versions["2"]!, theirs: versions["3"]!, working: description };
}
export function validateResolution(value: ScmResolution | undefined): ScmResolution {
  if (!value || typeof value.path !== "string" || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision) || !["edited", "ours", "theirs", "working", "delete"].includes(value.choice) || typeof value.stage !== "boolean" || value.allowMarkers !== undefined && typeof value.allowMarkers !== "boolean") throw new HttpError(400, "scm_resolution", "검토한 충돌 파일과 해결 방법이 필요합니다.");
  if (value.choice === "edited" && (typeof value.content !== "string" || value.content.includes("\0") || Buffer.byteLength(value.content) > TEXT_LIMIT || Buffer.from(value.content).toString("utf8") !== value.content)) throw new HttpError(400, "scm_resolution", "편집 결과는 UTF-8 텍스트 2 MiB 이내여야 합니다.");
  return { path: scmPath(value.path), expectedRevision: value.expectedRevision, choice: value.choice, stage: value.stage, ...(value.choice === "edited" ? { content: value.content! } : {}), ...(value.allowMarkers ? { allowMarkers: true } : {}) };
}
export async function prepareResolution(state: ScmStatus, request: ScmResolution) {
  const view = await readScmConflict(state, request.path);
  if (view.revision !== request.expectedRevision) throw new HttpError(409, "scm_changed", "검토한 충돌 파일이나 Git 단계가 바뀌었습니다. 초안을 보관하고 새 상태를 확인하세요.");
  if ([view.ours, view.theirs].some((version) => version.kind === "gitlink") || view.working.kind === "directory") throw conflictError("서브모듈 또는 폴더 충돌은 작업공간 터미널에서 해결하세요.");
  const selected = request.choice === "ours" || request.choice === "theirs" ? view[request.choice] : view.working;
  if (request.choice === "edited" && !["text", "missing"].includes(view.working.kind)) throw conflictError("현재 파일은 텍스트로 덮어쓸 수 없습니다. 한쪽 전체 파일을 선택하거나 터미널에서 해결하세요.");
  if ((request.choice === "ours" || request.choice === "theirs") && (selected.kind === "missing" || selected.bytes > FILE_LIMIT)) throw conflictError("이 단계의 파일이 없거나 16 MiB를 넘습니다. 삭제를 직접 선택하거나 터미널에서 해결하세요.");
  if (request.stage && request.choice !== "delete") {
    if (selected.kind === "large" && selected.bytes > FILE_LIMIT) throw conflictError("16 MiB를 넘는 충돌 파일은 터미널에서 검토하고 스테이징하세요.");
    const text = request.choice === "edited" ? request.content! : selected.text;
    if (text !== null && hasConflictMarkers(text, view.markerSize) && !request.allowMarkers) throw conflictError("충돌 표식으로 보이는 줄이 남아 있습니다. 해결하거나 표식을 의도한 내용으로 유지한다고 확인하세요.");
  }
  return view;
}

/** Private recovery files are raw bytes and JSON metadata, never executable symlinks. */
export async function createScmRecovery(state: ScmStatus, paths: string[], baseDir: string, jobId: string, onCreated?: (directory: string) => void) {
  const directory = join(baseDir, "scm-recovery", jobId); mkdirSync(directory, { recursive: true, mode: 0o700 });
  onCreated?.(directory);
  const gitDir = (await scmText(state.root, ["rev-parse", "--absolute-git-dir"])).replace(/\n$/, "");
  const index = readFileSync(join(gitDir, "index"));
  if (index.length > RECOVERY_LIMIT) throw conflictError("복구용 인덱스가 128 MiB를 넘습니다. 터미널에서 별도 백업 후 진행하세요.");
  writeFileSync(join(directory, "index.bin"), index, { flag: "wx", mode: 0o600 }); let total = index.length;
  const entries = [];
  for (const path of [...new Set(paths)]) {
    const raw = rawFile(state.root, path, RECOVERY_LIMIT - total);
    if (raw.kind === "file" && !raw.data) throw conflictError("복구할 파일이 합계 128 MiB를 넘습니다. 터미널에서 별도 백업 후 진행하세요.");
    const name: string | null = raw.data ? `${entries.length}.bin` : null;
    if (raw.data) { total += raw.data.length; writeFileSync(join(directory, name!), raw.data, { flag: "wx", mode: 0o600 }); }
    entries.push({ path, kind: raw.kind, mode: raw.mode, bytes: raw.bytes, storedAs: name, sha256: raw.data ? scmHash(raw.data) : null });
  }
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, root: state.root, operation: state.operation, statusRevision: state.revision, head: state.head, branch: state.branch, createdAt: Date.now(), entries }, null, 2), { flag: "wx", mode: 0o600 });
  return directory;
}

export async function applyResolution(state: ScmStatus, request: ScmResolution, view: ScmConflict, options: GitOptions, assertCurrent: () => Promise<void>) {
  let data: Buffer | null = null, mode = view.working.mode ?? view.ours.mode ?? view.theirs.mode ?? "100644";
  if (request.choice === "edited") {
    let content = request.content!;
    // Browser textareas normalize CRLF. Preserve the existing uniform line ending on edit.
    if (view.working.text?.includes("\r\n") && !/(?<!\r)\n/.test(view.working.text)) content = content.replace(/\r?\n/g, "\r\n");
    data = Buffer.from(content);
  } else if (request.choice === "ours" || request.choice === "theirs") {
    const selected = view[request.choice]; mode = selected.mode!;
    data = await scmGit(state.root, mode === "120000" ? ["cat-file", "blob", selected.oid!] : ["cat-file", "--filters", `--path=${request.path}`, selected.oid!], { ...options, onOutput: undefined, limit: FILE_LIMIT });
  }
  await assertCurrent();
  if (options.signal?.aborted) throw new Error("Git 작업을 중단했습니다.");
  const target = targetPath(state.root, request.path, data !== null);
  const stamp = () => JSON.stringify(scmFileStamp(state.root, request.path));
  if (request.choice === "delete") { try { unlinkSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  else if (data !== null) {
    const temp = join(dirname(target), `.workbench-conflict-${randomUUID()}`);
    try {
      if (mode === "120000") symlinkSync(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data), temp);
      else {
        let permissions = (mode === "100755" ? 0o755 : 0o644) & ~process.umask();
        try { const current = lstatSync(target); if (current.isFile()) { permissions = current.mode & 0o777; if (request.choice !== "edited") permissions = mode === "100755" ? permissions | (permissions & 0o444) >> 2 : permissions & ~0o111; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const fd = openSync(temp, "wx", permissions); try { writeFileSync(fd, data); fchmodSync(fd, permissions); fsyncSync(fd); } finally { closeSync(fd); }
      }
      targetPath(state.root, request.path); renameSync(temp, target);
    } finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
  const after = stamp();
  if (request.stage) {
    const actual = rawFile(state.root, request.path);
    if (actual.data && !actual.data.includes(0) && hasConflictMarkers(actual.data.toString("utf8"), view.markerSize) && !request.allowMarkers) throw conflictError("저장된 파일에 충돌 표식이 남아 스테이징하지 않았습니다. 파일과 복구 사본을 확인하세요.");
    // Add only this path. A saved result remains on disk if Git/filter/index admission fails.
    await scmText(state.root, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], { ...options, input: request.path + "\0" });
    if (after !== stamp()) throw conflictError("스테이징 도중 작업 파일이 바뀌었습니다. 스테이징과 현재 파일을 다시 비교하세요.");
  }
  options.onOutput?.(`${request.path}: ${request.stage ? "해결 결과를 스테이징했습니다." : "작업 파일에 저장했습니다. 충돌 해결을 마치면 스테이징하세요."}\n`);
}
