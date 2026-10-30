import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ScmFile, ScmOperation, ScmStatus, Workspace } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { scmText } from "./scm-git.ts";

export const scmHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const line = (value: string) => value.replace(/\n$/, "");
export function scmPath(path: string) {
  if (!path || path.includes("\0") || isAbsolute(path) || /^[a-z]:/i.test(path) || path.split(process.platform === "win32" ? /[\\/]/ : /\//).some((part) => part === ".." || part === "." || part.toLowerCase() === ".git")) throw new HttpError(400, "scm_path", "저장소 안의 파일 경로가 필요합니다.");
  return path;
}

/** Porcelain v2 -z: split the fixed header fields, never split or trim the filename. */
export function parseScmStatus(raw: string) {
  const files: ScmFile[] = []; let head: string | null = null, branch: string | null = null, upstream: string | null = null, ahead = 0, behind = 0;
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.startsWith("# branch.oid ")) { const value = field.slice(13); head = value === "(initial)" ? null : value; }
    else if (field.startsWith("# branch.head ")) { const value = field.slice(14); branch = value === "(detached)" ? null : value; }
    else if (field.startsWith("# branch.upstream ")) upstream = field.slice(18);
    else if (field.startsWith("# branch.ab ")) { const match = field.match(/\+(\d+) -(\d+)/); ahead = Number(match?.[1] ?? 0); behind = Number(match?.[2] ?? 0); }
    else if (field.startsWith("? ")) files.push({ path: field.slice(2), index: "?", working: "?", conflicted: false, submodule: false });
    else if (/^[12u] /.test(field)) {
      const count = field[0] === "1" ? 8 : field[0] === "2" ? 9 : 10;
      let offset = 0;
      for (let n = 0; n < count; n++) { const next = field.indexOf(" ", offset); if (next < 0) throw new Error("Git 상태 형식을 읽지 못했습니다."); offset = next + 1; }
      const xy = field.slice(2, 4), oldPath = field[0] === "2" ? fields[++i] : undefined;
      files.push({ path: field.slice(offset), ...(oldPath === undefined ? {} : { oldPath }), index: xy[0]!, working: xy[1]!, conflicted: field[0] === "u", submodule: field[5] === "S" });
    }
  }
  return { files, head, branch, upstream, ahead, behind };
}

/** Preserve links as links; do not read through a symlinked parent into another directory. */
export function scmFileStamp(root: string, path: string) {
  scmPath(path); const parts = path.replace(/\/$/, "").split("/"); let at = root;
  try {
    for (let i = 0; i < parts.length; i++) {
      at = join(at, parts[i]!); const stat = lstatSync(at, { bigint: true });
      if (stat.isSymbolicLink()) return [path, "link", i, readlinkSync(at), String(stat.ctimeNs)];
      if (i === parts.length - 1) return [path, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
      if (!stat.isDirectory()) return [path, "parent-not-directory", i];
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, "missing"]; throw error; }
  return [path];
}
function indexStamp(gitDir: string) {
  try { return scmHash(readFileSync(join(gitDir, "index"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
function operation(gitDir: string): ScmOperation {
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) return "rebase";
  for (const [file, kind] of [["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const) if (existsSync(join(gitDir, file))) return kind;
  try { const todo = readFileSync(join(gitDir, "sequencer", "todo"), "utf8"); if (/^pick /m.test(todo)) return "cherry-pick"; if (/^revert /m.test(todo)) return "revert"; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return null;
}
/** Pin operation contents, not just its kind: another rebase step may have the same HEAD/index. */
function operationStamp(gitDir: string) {
  return ["HEAD", "ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_AUTOSTASH", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD",
    ...["rebase-merge", "rebase-apply", "sequencer"].flatMap((dir) => ["head", "head-name", "orig-head", "onto", "stopped-sha", "msgnum", "end", "next", "last", "done", "git-rebase-todo", "todo", "opts", "message", "message-squash", "message-fixup", "autostash"].map((file) => `${dir}/${file}`))]
    .map((path) => { try { const stat = lstatSync(join(gitDir, path)); if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new HttpError(409, "scm_operation_state", "진행 중인 Git 작업의 상태 파일을 확인할 수 없습니다."); return [path, scmHash(readFileSync(join(gitDir, path)))]; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, "missing"]; throw error; } });
}
export async function readScmStatus(workspace: Workspace, sharedLinks: ReadonlySet<string> = new Set()): Promise<ScmStatus> {
  const root = realpathSync(line(await scmText(workspace.cwd, ["rev-parse", "--show-toplevel"])));
  const gitDir = realpathSync(line(await scmText(root, ["rev-parse", "--absolute-git-dir"])));
  const commonDir = realpathSync(line(await scmText(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
  const rel = relative(root, realpathSync(workspace.cwd));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || workspace.worktree && (realpathSync(workspace.worktree.path) !== root || workspace.worktree.commonDir && realpathSync(workspace.worktree.commonDir) !== commonDir)) throw new HttpError(409, "scm_repository_changed", "작업공간의 Git 저장소가 바뀌었습니다.");
  const before = indexStamp(gitDir), operationBefore = JSON.stringify(operationStamp(gitDir)), raw = await scmText(root, ["-c", "status.renames=true", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  const parsed = parseScmStatus(raw);
  if (parsed.files.length > 20_000) throw new HttpError(413, "scm_too_many_files", "변경 파일이 20,000개를 넘습니다. 불필요한 생성 파일의 Git 제외 설정을 먼저 확인하세요.");
  const stamps = [...new Set(parsed.files.flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]))].sort().map((path) => scmFileStamp(root, path));
  const op = operation(gitDir), after = indexStamp(gitDir);
  const operationAfter = JSON.stringify(operationStamp(gitDir));
  if (before !== after || operationBefore !== operationAfter) throw new HttpError(409, "scm_changed", "Git 상태를 읽는 동안 인덱스나 진행 중인 작업이 바뀌었습니다. 새로고침해 주세요.");
  const identity = lstatSync(root, { bigint: true });
  const revision = scmHash(JSON.stringify([root, commonDir, String(identity.dev), String(identity.ino), raw, after, op, operationAfter, stamps]));
  const localRevision = scmHash(JSON.stringify([root, commonDir, String(identity.dev), String(identity.ino), parsed.head, parsed.branch, parsed.files, after, op, operationAfter, stamps]));
  return { ...parsed, files: parsed.files.filter((file) => file.index !== "?" || !sharedLinks.has(file.path)), workspaceId: workspace.id, root, commonDir, operation: op, revision, localRevision };
}
