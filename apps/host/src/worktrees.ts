import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { SessionWorktree, WorktreeChanges, WorktreeFile } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

// "격리 사본": a session that works in a git worktree of the work's repository, on a branch of its
// own, so its changes stay apart until the user looks at them and applies them to the original
// checkout (or throws them away). Only git does the work here; nothing is committed for the user.

const run = promisify(execFile);
/** File names as they are (Korean ones too), not quoted with octal escapes. */
const PLAIN = ["--no-optional-locks", "-c", "core.quotePath=false"];
const MAX_DIFF = 400_000;
const pathLine = (value: string) => value.replace(/\n$/, "");

class GitCommandError extends Error {
  readonly code: string | number | undefined;
  readonly stdout: string;
  constructor(message: string, code: string | number | undefined, stdout: string) {
    super(message);
    this.code = code;
    this.stdout = stdout;
  }
}

export async function git(cwd: string, args: string[], input?: string, signal?: AbortSignal) {
  if (input !== undefined) {
    return new Promise<string>((resolve, reject) => {
      const child = execFile("git", [...PLAIN, "-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
        error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout)),
      );
      child.stdin?.end(input);
    });
  }
  const { stdout } = await run("git", [...PLAIN, "-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal }).catch((error: { stderr?: string; stdout?: string; message: string; code?: string | number }) => {
    throw new GitCommandError(String(error.stderr || error.message).trim(), error.code, String(error.stdout ?? ""));
  });
  return stdout;
}

/** A worktree for a session: same commit as the repository now, a new branch, the same subfolder. */
export async function createWorktree(workCwd: string, dataDir: string, sessionId: string): Promise<SessionWorktree> {
  const root = pathLine(await git(workCwd, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new HttpError(409, "not_a_repository", "이 작업 폴더는 git 저장소가 아니어서 격리 사본을 만들 수 없습니다.");
  }));
  const base = (await git(root, ["rev-parse", "HEAD"]).catch(() => {
    throw new HttpError(409, "no_commit", "저장소에 커밋이 하나도 없어 격리 사본을 만들 수 없습니다.");
  })).trim();
  const short = sessionId.slice(0, 8);
  const branch = `workbench/${short}`;
  const path = join(dataDir, "worktrees", short);
  mkdirSync(join(dataDir, "worktrees"), { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, path, base]).catch((error: unknown) => {
    throw new HttpError(409, "worktree_failed", `격리 사본을 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  });
  // Git keeps no empty folders: the work's subfolder may have nothing committed in it yet.
  const cwd = join(path, relative(root, workCwd));
  mkdirSync(cwd, { recursive: true });
  return { root, path, branch, base, cwd };
}

const STATUS: Record<string, WorktreeFile["status"]> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified" };

/** NUL-delimited paths preserve tabs, newlines and non-ASCII names. Rename/copy has two paths. */
function changedFiles(names: string): WorktreeFile[] {
  const tokens = names.split("\0");
  const files: WorktreeFile[] = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const code = tokens[i++]![0]!;
    const first = tokens[i++];
    const path = code === "R" || code === "C" ? tokens[i++] : first;
    if (path) files.push({ path, status: STATUS[code] ?? "modified" });
  }
  return files;
}

async function untrackedFiles(path: string) {
  return (await git(path, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
}

/** A no-index diff returns 1 when it found a difference; other errors must still propagate. */
async function addedFilePatch(path: string, file: string, binary: boolean) {
  return git(path, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", ...(binary ? ["--binary"] : []), "--", "/dev/null", file]).catch((error: unknown) => {
    if (error instanceof GitCommandError && error.code === 1) return error.stdout;
    throw error;
  });
}

async function worktreePatch(worktree: SessionWorktree, binary: boolean, untracked: string[]) {
  let patch = await git(worktree.path, ["diff", "--no-ext-diff", "--no-textconv", ...(binary ? ["--binary"] : []), "-M", worktree.base, "--"]);
  for (const file of untracked) patch += await addedFilePatch(worktree.path, file, binary);
  return patch;
}

/** A saved descriptor must still name this checkout, in this repository, on this branch. */
async function verifyWorktree(worktree: SessionWorktree) {
  const actualRoot = pathLine(await git(worktree.path, ["rev-parse", "--show-toplevel"]));
  const ownCommon = pathLine(await git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const originalCommon = pathLine(await git(worktree.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (realpathSync(actualRoot) !== realpathSync(worktree.path) || realpathSync(worktree.path) === realpathSync(worktree.root) || realpathSync(ownCommon) !== realpathSync(originalCommon)) {
    throw new HttpError(409, "worktree_changed", "격리 사본의 경로나 저장소가 바뀌었습니다. 작업공간을 다시 확인해 주세요.");
  }
  if (worktree.commonDir && realpathSync(ownCommon) !== worktree.commonDir) throw new HttpError(409, "worktree_changed", "연결한 Git 저장소가 바뀌었습니다. 작업공간을 다시 확인해 주세요.");
  const branch = (await git(worktree.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  if (branch !== worktree.branch) throw new HttpError(409, "worktree_branch_changed", "격리 사본의 브랜치가 바뀌었습니다. 작업공간을 다시 확인해 주세요.");
}

/** What the session changed against the commit it started from (new files included). */
export async function worktreeChanges(worktree: SessionWorktree, sharedLinks: ReadonlySet<string> = new Set()): Promise<WorktreeChanges> {
  await verifyWorktree(worktree);
  const untracked = (await untrackedFiles(worktree.path)).filter((path) => !sharedLinks.has(path));
  const names = await git(worktree.path, ["diff", "--name-status", "-z", "-M", worktree.base, "--"]);
  const files = [...changedFiles(names), ...untracked.map((path): WorktreeFile => ({ path, status: "added" }))];
  const diff = await worktreePatch(worktree, false, untracked);
  return { files, diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (너무 길어 줄였습니다)` : diff, branch: worktree.branch, base: worktree.base };
}

/**
 * Apply the session's changes to the original checkout's files (not its index), as a patch: when
 * the same lines changed there meanwhile it refuses and changes nothing.
 */
export async function applyWorktree(worktree: SessionWorktree, sharedLinks: ReadonlySet<string> = new Set()) {
  await verifyWorktree(worktree);
  const patch = await worktreePatch(worktree, true, (await untrackedFiles(worktree.path)).filter((path) => !sharedLinks.has(path)));
  if (!patch.trim()) throw new HttpError(409, "nothing_to_apply", "적용할 변경이 없습니다.");
  await git(worktree.root, ["apply", "--check", "--binary", "-"], patch).catch((error: unknown) => {
    throw new HttpError(409, "apply_conflict", `원래 폴더에 그대로 적용할 수 없습니다(같은 곳이 바뀌었을 수 있습니다): ${error instanceof Error ? error.message : String(error)}`);
  });
  await git(worktree.root, ["apply", "--binary", "-"], patch);
}

/** Discard the copy's working files. Keep history that has not reached the original checkout. */
export async function removeWorktree(worktree: SessionWorktree) {
  await verifyWorktree(worktree);
  const merged = await git(worktree.root, ["merge-base", "--is-ancestor", `refs/heads/${worktree.branch}`, "HEAD"])
    .then(() => true).catch((error: unknown) => {
      if (error instanceof GitCommandError && error.code === 1) return false;
      throw error;
    });
  await git(worktree.root, ["worktree", "remove", "--force", worktree.path]).catch((error: unknown) => {
    throw new HttpError(409, "worktree_remove_failed", `격리 사본을 삭제하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (merged) {
    await git(worktree.root, ["branch", "-d", "--", worktree.branch]).catch((error: unknown) => {
      throw new HttpError(409, "worktree_branch_cleanup_failed", `격리 사본 폴더는 삭제했지만 브랜치를 정리하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return { branchRetained: !merged };
}
