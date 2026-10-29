import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class ScmGitError extends Error {
  readonly code: number | null; readonly stdout: Buffer;
  constructor(code: number | null, message: string, stdout: Buffer) { super(message); this.code = code; this.stdout = stdout; }
}
export type GitOptions = { input?: string | Buffer; signal?: AbortSignal; accepted?: number[]; limit?: number; onOutput?: (text: string) => void };

/** No shell, optional index refresh, textconv, pager or inherited alternate repository. */
export function scmGit(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" };
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) delete (env as NodeJS.ProcessEnv)[key];
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error("Git 작업을 중단했습니다.")); return; }
    const child = spawn("git", ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let size = 0, stderr = "", failure: Error | null = null;
    let closed = false, stopTimer: ReturnType<typeof setTimeout> | undefined;
    const signalOwned = (signal: NodeJS.Signals) => {
      if (closed || !child.pid) return;
      try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* The owned process already exited. */ }
    };
    const stop = () => { failure ??= new Error("Git 작업을 중단했습니다. 현재 파일과 Git 상태를 확인하세요."); signalOwned("SIGTERM"); stopTimer ??= setTimeout(() => signalOwned("SIGKILL"), 2000); stopTimer.unref(); };
    options.signal?.addEventListener("abort", stop, { once: true });
    const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
    child.on("error", (error) => { failure = error; });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.limit ?? 16 * 1024 * 1024)) { failure ??= new Error("Git 결과가 너무 큽니다. 파일 범위를 줄여 확인하세요."); stop(); return; }
      chunks.push(chunk); options.onOutput?.(out.write(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => { const text = err.write(chunk); stderr = (stderr + text).slice(-128 * 1024); options.onOutput?.(text); });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") failure ??= error; });
    child.on("close", (code) => {
      closed = true; clearTimeout(stopTimer); options.signal?.removeEventListener("abort", stop);
      options.onOutput?.(out.end() + err.end());
      const stdout = Buffer.concat(chunks);
      if (failure) reject(failure);
      else if (!(options.accepted ?? [0]).includes(code ?? -1)) reject(new ScmGitError(code, stderr.trim() || `Git 작업 실패 (${code})`, stdout));
      else resolve(stdout);
    });
    child.stdin.end(options.input);
  });
}
export async function scmText(cwd: string, args: string[], options?: GitOptions) { return (await scmGit(cwd, args, options)).toString("utf8"); }
