import { execFile } from "node:child_process";
import { delimiter, isAbsolute } from "node:path";

// Apps opened from the macOS Finder, a Linux desktop launcher or an AppImage get a short PATH:
// not the folders the user's shell adds (Homebrew, nvm, npm's prefix, ~/.local/bin). The gateway
// asks the user's login shell for its PATH once and appends the folders it lacks, so engines are
// found, and engine sessions find the same tools (node, git, python) as in a terminal.

const MARK = "__WORKBENCH_PATH__";

/** The PATH between the markers in a shell's output (rc files may print other lines around it). */
export function parseShellPath(output: string): string[] | null {
  const start = output.indexOf(MARK);
  const end = output.indexOf(MARK, start + MARK.length);
  if (start < 0 || end < 0) return null;
  const dirs = output
    .slice(start + MARK.length, end)
    .split(":")
    .map((dir) => dir.trim())
    .filter((dir) => dir && isAbsolute(dir));
  return dirs.length ? dirs : null;
}

/** Folders of `shellDirs` that `current` lacks, in the shell's order. */
export function missingDirs(current: string | undefined, shellDirs: string[]): string[] {
  const have = new Set((current ?? "").split(delimiter).filter(Boolean));
  const out: string[] = [];
  for (const dir of shellDirs) {
    if (have.has(dir)) continue;
    have.add(dir);
    out.push(dir);
  }
  return out;
}

/** The login shell's PATH (interactive, like a terminal), or null within a few seconds. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string[] | null> {
  const shell = env.SHELL;
  if (platform === "win32" || !shell || !isAbsolute(shell)) return Promise.resolve(null);
  // `printenv` prints PATH the same way in every shell (fish keeps PATH as a list).
  const script = `printf '%s' '${MARK}'; printenv PATH; printf '%s' '${MARK}'`;
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", script],
      // No terminal: rc files that wait for input get end of file at once.
      { timeout: 5000, maxBuffer: 1024 * 1024, env: { ...env, WORKBENCH_SHELL_PROBE: "1" }, windowsHide: true },
      (_error, stdout) => resolve(parseShellPath(String(stdout ?? ""))),
    ).stdin?.end();
  });
}

/** Folders the login shell added to this process's PATH (for showing where an engine was found). */
export const shellAdded: string[] = [];

/** Ask the login shell once and append what this process's PATH lacks (macOS, Linux). */
export async function adoptLoginShellPath(env: NodeJS.ProcessEnv = process.env) {
  if (env.WORKBENCH_SHELL_PATH === "0") return [];
  const dirs = await loginShellPath(env).catch(() => null);
  if (!dirs) return [];
  const added = missingDirs(env.PATH, dirs);
  if (added.length) {
    env.PATH = [env.PATH, ...added].filter(Boolean).join(delimiter);
    shellAdded.push(...added);
  }
  return added;
}
