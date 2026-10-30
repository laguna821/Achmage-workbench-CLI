import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { HttpError } from "./errors.ts";

export type GitHubReader = { json(endpoint: string, body?: object, fresh?: boolean): Promise<unknown>; log(endpoint: string): Promise<string>; close(): Promise<void> };
export type GitHubWrite = { method: "POST" | "PATCH" | "PUT" | "DELETE"; endpoint: string; body?: object };
export type GitHubWriter = { write(request: GitHubWrite): Promise<{ status: number; value: unknown }> };
export class GitHubWriteError extends Error {
  readonly certain: boolean;
  constructor(message: string, certain: boolean) { super(message); this.certain = certain; }
}
type Raw = { status: number; headers: Record<string, string>; text: string };
class ResponseError extends HttpError {
  readonly response: Raw;
  constructor(status: number, code: string, message: string, response: Raw) { super(status, code, message); this.response = response; }
}
type Runner = (args: string[], input: string | undefined, signal: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;
export function githubRedact(text: string) {
  let value = text.replace(/(?:gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[인증 정보 가림]").replace(/(authorization\s*[:=]\s*)(?:bearer|token)\s+\S+/gi, "$1[가림]").replace(/https?:\/\/[^\s]+/g, (raw) => { try { const url = new URL(raw); if (url.username || url.password) { url.username = "[가림]"; url.password = ""; } if (url.search) url.search = "?[가림]"; return url.toString(); } catch { return "[주소 가림]"; } });
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) { const token = process.env[name]; if (token && token.length > 3) value = value.split(token).join("[인증 정보 가림]"); }
  return value;
}
export const githubLogText = (text: string) => githubRedact(stripVTControlCharacters(text)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
/** Includes only response headers, never gh's request debug trace. Redirect headers may precede the final response. */
export function githubResponse(output: string): Raw {
  let rest = output, status = 0, headers: Record<string, string> = {};
  while (/^HTTP\/\S+ \d{3}/.test(rest)) {
    const at = rest.search(/\r?\n\r?\n/); if (at < 0) break;
    const block = rest.slice(0, at).split(/\r?\n/); status = Number(block.shift()!.split(" ")[1]); headers = {};
    for (const row of block) { const colon = row.indexOf(":"); if (colon > 0) headers[row.slice(0, colon).toLowerCase()] = row.slice(colon + 1).trim(); }
    rest = rest.slice(at).replace(/^\r?\n\r?\n/, "");
  }
  return { status, headers, text: rest };
}
const execute: Runner = (args, input, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error("GitHub 읽기를 중단했습니다.")); return; }
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", PAGER: "cat", GH_BROWSER: "false", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
  for (const name of ["GH_DEBUG", "GH_REPO", "GH_FORCE_TTY", "GH_PATH", "CLICOLOR_FORCE"]) delete env[name];
  const child = spawn("gh", args, { env, cwd: process.cwd(), windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let failure: Error | null = null, size = 0, stderr = "", closed = false, kill: ReturnType<typeof setTimeout> | undefined;
  const chunks: Buffer[] = [];
  const stop = () => { if (closed) return; failure ??= new Error("GitHub 읽기가 중단되었거나 제한 시간을 넘었습니다."); const send = (sig: NodeJS.Signals) => { if (!closed && child.pid) try { if (process.platform === "win32") child.kill(sig); else process.kill(-child.pid, sig); } catch { /* Only this owned gh process. */ } }; send("SIGTERM"); kill ??= setTimeout(() => send("SIGKILL"), 1500); kill.unref(); };
  signal.addEventListener("abort", stop, { once: true });
  child.on("error", (error: NodeJS.ErrnoException) => { failure = new Error(error.code === "ENOENT" ? "GitHub CLI(gh)가 없습니다. 설치 후 gh auth login으로 연결하세요." : "GitHub CLI를 실행하지 못했습니다."); });
  child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) { failure = new Error("GitHub 응답이 8 MiB 제한을 넘었습니다. 범위를 줄이거나 GitHub에서 전체 결과를 확인하세요."); stop(); } else chunks.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") { failure = new Error("GitHub 요청을 전달하지 못했습니다."); stop(); } });
  child.on("close", (code) => { closed = true; clearTimeout(kill); signal.removeEventListener("abort", stop); if (failure) reject(failure); else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), stderr }); });
  child.stdin.end(input);
});

/** Separate read/cache and explicit write paths. A write is never retried or coalesced here. */
export class GhReader implements GitHubReader, GitHubWriter {
  private readonly run: Runner; private readonly now: () => number;
  private stopped = false; private blockedUntil = 0;
  private readonly cache = new Map<string, { at: number; value: unknown; bytes: number }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly running = new Map<AbortController, Promise<unknown>>();
  constructor(run: Runner = execute, now: () => number = Date.now) { this.run = run; this.now = now; }
  private async request(endpoint: string, body?: object, rawLog = false, writeMethod?: GitHubWrite["method"], started?: () => void): Promise<Raw> {
    if (this.stopped) throw new HttpError(409, "github_stopped", "GitHub 연결을 종료했습니다.");
    if (this.blockedUntil > this.now()) throw new HttpError(429, "github_rate_limit", `GitHub 요청 제한으로 ${new Date(this.blockedUntil).toLocaleTimeString()} 이후 다시 확인할 수 있습니다.`);
    if (writeMethod) {
      const graphql = endpoint === "graphql" && writeMethod === "POST" && /^mutation[\s({]/.test(String((body as { query?: unknown } | undefined)?.query));
      const rest = writeMethod === "PUT" && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/\d+\/merge-async$/.test(endpoint) || writeMethod === "POST" && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:actions\/runs\/\d+\/rerun(?:-failed-jobs)?|check-runs\/\d+\/rerequest)$/.test(endpoint);
      if (!graphql && !rest) throw new Error("허용되지 않은 GitHub 변경 경로입니다.");
    } else if (body ? endpoint !== "graphql" || !/^query[\s({]/.test(String((body as { query?: unknown }).query)) : !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|\?|$)/.test(endpoint)) throw new Error("허용되지 않은 GitHub 읽기 경로입니다.");
    if (/[\r\n\0{}]/.test(endpoint) || endpoint.split("?")[0]!.split("/").some((part) => part === "." || part === "..")) throw new Error("잘못된 GitHub 읽기 경로입니다.");
    if (rawLog && !/^repos\/[^/]+\/[^/]+\/actions\/jobs\/\d+\/logs$/.test(endpoint)) throw new Error("연결된 Actions 작업 로그만 읽을 수 있습니다.");
    const args = ["api", "--hostname", "github.com", "--method", writeMethod ?? (body ? "POST" : "GET"), "--include", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint, ...(body ? ["--input", "-"] : []), ...(rawLog ? ["--allow-escape-sequences"] : [])];
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000); timer.unref();
    started?.(); const running = this.run(args, body ? JSON.stringify(body) : undefined, controller.signal); this.running.set(controller, running);
    try {
      const result = await running, response = githubResponse(result.stdout), h = response.headers;
      const rateLimited = response.status === 429 || (response.status === 403 && (h["x-ratelimit-remaining"] === "0" || h["retry-after"] || /rate limit|secondary rate/i.test(response.text + result.stderr)));
      if (rateLimited) {
        const retry = Number(h["retry-after"]), reset = Number(h["x-ratelimit-reset"]);
        this.blockedUntil = Math.max(this.now() + 60000, Number.isFinite(retry) && retry > 0 ? this.now() + retry * 1000 : 0, Number.isFinite(reset) ? reset * 1000 : 0);
        throw new ResponseError(429, "github_rate_limit", `GitHub 요청 제한입니다. ${new Date(this.blockedUntil).toLocaleTimeString()} 이후 다시 확인하세요.`, response);
      }
      if (result.code !== 0 || response.status < 200 || response.status >= 300) {
        if (rawLog && /unknown flag.*allow-escape-sequences/i.test(result.stderr)) throw new HttpError(409, "github_version", "CI 로그 읽기에는 GitHub CLI 2.97 이상이 필요합니다. gh를 업데이트한 뒤 다시 확인하세요.");
        const note = githubRedact(result.stderr || response.text || "GitHub 응답을 읽지 못했습니다.").slice(0, 2000);
        throw new ResponseError(response.status === 401 ? 401 : 502, response.status === 401 ? "github_auth" : "github_read", `${response.status === 401 ? "GitHub 인증을 확인하세요. gh auth login" : "GitHub 요청 실패"} · ${note}`, response);
      }
      return response;
    } finally { clearTimeout(timer); this.running.delete(controller); }
  }
  async json(endpoint: string, body?: object, fresh = false): Promise<unknown> {
    const key = JSON.stringify([endpoint, body]), cached = this.cache.get(key);
    if (!fresh && cached && this.now() - cached.at < 30000 && !this.stopped) return cached.value;
    const previous = this.pending.get(key); if (previous) return previous;
    const done = (async () => {
      const response = await this.request(endpoint, body); let value: unknown;
      try { value = JSON.parse(response.text); } catch { throw new HttpError(502, "github_json", "GitHub에서 올바른 JSON을 받지 못했습니다."); }
      if (body && value && typeof value === "object" && "errors" in value) throw new HttpError(502, "github_graphql", "GitHub 검사 일부를 읽지 못했습니다. 권한과 연결 상태를 확인하세요.");
      this.cache.delete(key); this.cache.set(key, { at: this.now(), value, bytes: Buffer.byteLength(response.text) });
      while (this.cache.size > 64 || [...this.cache.values()].reduce((sum, item) => sum + item.bytes, 0) > 16 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value!);
      return value;
    })();
    this.pending.set(key, done); try { return await done; } finally { this.pending.delete(key); }
  }
  async log(endpoint: string) { return githubLogText((await this.request(endpoint, undefined, true)).text); }
  async write(request: GitHubWrite) {
    let attempted = false;
    const parse = (response: Raw) => { try { return response.text.trim() ? JSON.parse(response.text) as unknown : null; } catch { throw new GitHubWriteError("GitHub 변경 응답을 읽지 못했습니다. 원격 결과를 확인하세요.", false); } };
    try {
      const response = await this.request(request.endpoint, request.body, false, request.method, () => { attempted = true; });
      const value = parse(response);
      if (request.endpoint === "graphql" && value && typeof value === "object" && "errors" in value) throw new GitHubWriteError(`GitHub 변경 응답에 오류가 있습니다. ${githubRedact(JSON.stringify((value as { errors: unknown }).errors)).slice(0, 1800)}`, false);
      return { status: response.status, value };
    } catch (error) {
      if (error instanceof ResponseError && error.response.status === 409 && request.endpoint.endsWith("/merge-async")) return { status: 409, value: parse(error.response) };
      if (error instanceof GitHubWriteError) throw error;
      const status = error instanceof ResponseError ? error.response.status : 0;
      throw new GitHubWriteError(githubRedact(error instanceof Error ? error.message : String(error)), !attempted || (status >= 400 && status < 500 && status !== 408));
    } finally { if (attempted) this.cache.clear(); }
  }
  async close() { this.stopped = true; for (const controller of this.running.keys()) controller.abort(); await Promise.allSettled([...this.running.values()]); this.cache.clear(); }
}
