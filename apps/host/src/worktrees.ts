import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { SessionWorktree, WorktreeChanges, WorktreeFile } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

// "격리 사본": a session that works in a git worktree of the work's repository, on a branch of its
// own, so its changes stay apart until the user looks at them and applies them to the original
// checkout (or throws them away). Only git does the work here; nothing is committed for the user.

const run = promisify(execFile);
/** File names as they are (Korean ones too), not quoted with octal escapes. */
const PLAIN = ["-c", "core.quotePath=false"];
const MAX_DIFF = 400_000;

async function git(cwd: string, args: string[], input?: string) {
  if (input !== undefined) {
    return new Promise<string>((resolve, reject) => {
      const child = execFile("git", [...PLAIN, "-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
        error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout)),
      );
      child.stdin?.end(input);
    });
  }
  const { stdout } = await run("git", [...PLAIN, "-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }).catch((error: { stderr?: string; message: string }) => {
    throw new Error(String(error.stderr || error.message).trim());
  });
  return stdout;
}

/** A worktree for a session: same commit as the repository now, a new branch, the same subfolder. */
export async function createWorktree(workCwd: string, dataDir: string, sessionId: string): Promise<SessionWorktree> {
  const root = (await git(workCwd, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new HttpError(409, "not_a_repository", "이 작업 폴더는 git 저장소가 아니어서 격리 사본을 만들 수 없습니다.");
  })).trim();
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

/** What the session changed against the commit it started from (new files included). */
export async function worktreeChanges(worktree: SessionWorktree): Promise<WorktreeChanges> {
  // New files count too: marked as intended to add (their content is not staged).
  await git(worktree.path, ["add", "--all", "--intent-to-add"]);
  const names = await git(worktree.path, ["diff", "--name-status", "-M", worktree.base]);
  const files = names
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [code, ...paths] = line.split("\t");
      return { path: paths.at(-1) ?? "", status: STATUS[(code ?? "M")[0]!] ?? "modified" };
    });
  const diff = await git(worktree.path, ["diff", "-M", worktree.base]);
  return { files, diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (너무 길어 줄였습니다)` : diff, branch: worktree.branch, base: worktree.base };
}

/**
 * Apply the session's changes to the original checkout's files (not its index), as a patch: when
 * the same lines changed there meanwhile it refuses and changes nothing.
 */
export async function applyWorktree(worktree: SessionWorktree) {
  await git(worktree.path, ["add", "--all", "--intent-to-add"]);
  const patch = await git(worktree.path, ["diff", "--binary", "-M", worktree.base]);
  if (!patch.trim()) throw new HttpError(409, "nothing_to_apply", "적용할 변경이 없습니다.");
  await git(worktree.root, ["apply", "--check", "--binary", "-"], patch).catch((error: unknown) => {
    throw new HttpError(409, "apply_conflict", `원래 폴더에 그대로 적용할 수 없습니다(같은 곳이 바뀌었을 수 있습니다): ${error instanceof Error ? error.message : String(error)}`);
  });
  await git(worktree.root, ["apply", "--binary", "-"], patch);
}

/** Throw the copy away: the worktree folder and its branch. */
export async function removeWorktree(worktree: SessionWorktree) {
  await git(worktree.root, ["worktree", "remove", "--force", worktree.path]).catch(() => undefined);
  await git(worktree.root, ["branch", "-D", worktree.branch]).catch(() => undefined);
}
