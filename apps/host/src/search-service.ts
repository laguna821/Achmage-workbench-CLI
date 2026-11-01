import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** The one native Fast Find process owned by a gateway. Collection/cache and app permissions
 * stay in the host; this transport never reads a vault, opens a window or starts an AI model. */
export type FastFindMetadata = {
  kind: string; scope: string; workId?: string | null; sessionId?: string | null;
  provider?: string | null; archived?: boolean; hidden?: boolean; dedupKey?: string | null;
};
export type FastFindDocument = {
  key: string; revision: number; mtime: number; text: string; metadata: FastFindMetadata;
  fields?: { title?: string; aliases?: string[]; tags?: string[]; properties?: { key: string; values: string[] }[]; pathSegments?: string[] };
};
export type FastFindScope = {
  keys?: string[]; kinds?: string[]; scopes?: string[]; workIds?: string[]; sessionIds?: string[];
  providers?: string[]; excludedKeys?: string[]; excludedWorkIds?: string[]; excludedSessionIds?: string[];
  archived?: boolean; properties?: { key: string; value?: string | null }[];
};
export type FastFindHit = {
  path: string; title: string; tier: number; score: number;
  badge: "Title" | "Alias" | "H1" | "H2" | "H3" | "Tag" | "Link" | "Path" | "Body" | "Property";
  titleNorm: string; titleRanges: [number, number][];
  heading: { text: string; line: number; level: number } | null;
  excerpt: { text: string; ranges: [number, number][] } | null;
  line: number | null; isGhost: boolean; ghostRefs: number; similarCount: number; expanded: boolean;
};
export type FastFindOptions = {
  scope?: FastFindScope; mode?: "all" | "filesOnly"; offset?: number; limit?: number;
  group?: "none" | "work" | "session"; perGroup?: number; nowSecs?: number; includeCandidates?: boolean;
};
export type FastFindResult = {
  hits: FastFindHit[]; total: number; totalDocs: number; counts: Record<string, number>;
  groups: { key: string; total: number }[]; elapsedUs: number; generation: number; offset: number; limit: number;
  candidates: { key: string; tier: number; score: number }[] | null;
};
export type FastFindStatus = { protocol: number; upstream: string; documents: number; generation: number };
type Mutation = { changed: number; generation: number; documents: number };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void };
type SearchServiceOptions = { binary?: string; args?: string[]; timeoutMs?: number };
const FRAME_LIMIT = 32 * 1024 * 1024;

export class SearchService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private started: Promise<FastFindStatus> | null = null;
  private done: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private failed: Error | null = null;
  private readonly pending = new Map<number, Pending>();
  private writes: Promise<void> = Promise.resolve();
  private nextId = 1;
  private readonly binary: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(options: SearchServiceOptions = {}) {
    const standalone = process.env.WORKBENCH_SEARCH_WORKER_BIN;
    this.binary = options.binary ?? standalone ?? process.env.WORKBENCH_APP_BIN ?? "";
    this.args = options.args ?? (standalone && !options.binary ? [] : ["--search-worker"]);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Diagnostic identity only. Ownership is the live child handle, never a saved pid. */
  get pid() { return this.child?.pid ?? null; }

  start(): Promise<FastFindStatus> {
    if (this.stopping) return Promise.reject(new Error("검색 서비스가 종료 중입니다."));
    if (this.failed) return Promise.reject(this.failed);
    if (this.started) return this.started;
    if (!this.binary) return Promise.reject(new Error("Rust 검색 실행기가 없습니다. 데스크톱 앱 또는 WORKBENCH_SEARCH_WORKER_BIN을 사용해 주세요."));
    const child = spawn(this.binary, this.args, { stdio: "pipe", windowsHide: true });
    this.child = child;
    let stderr = "", buffer = "";
    this.done = new Promise<void>((resolve) => {
      child.once("close", (code) => {
        if (buffer.trim()) this.fail(new Error("검색 실행기가 불완전한 응답을 남기고 종료했습니다."));
        if (this.pending.size || !this.stopping) this.fail(new Error(stderr.trim() || `검색 실행기가 종료되었습니다 (${code ?? "signal"}).`));
        this.child = null;
        resolve();
      });
    });
    child.once("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        if (end > FRAME_LIMIT) { this.fail(new Error("검색 응답이 크기 한도를 넘었습니다.")); buffer = ""; return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line) as { version: number; id: number; ok: boolean; result?: unknown; error?: string };
          if (reply.version !== 1 || !Number.isSafeInteger(reply.id) || typeof reply.ok !== "boolean") throw new Error("지원하지 않는 검색 응답입니다.");
          const pending = this.pending.get(reply.id);
          if (!pending) continue; // a locally aborted caller; other consumers are unaffected
          this.pending.delete(reply.id); pending.cleanup();
          if (reply.ok) pending.resolve(reply.result);
          else pending.reject(new Error(reply.error || "검색 요청을 처리하지 못했습니다."));
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      }
      if (buffer.length > FRAME_LIMIT) { this.fail(new Error("검색 응답이 크기 한도를 넘었습니다.")); buffer = ""; }
    });
    this.started = this.send<FastFindStatus>({ op: "status" });
    return this.started;
  }

  private fail(error: Error) {
    this.failed ??= error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(this.failed); }
    this.pending.clear();
    // EOF is the worker's normal shutdown path; no unowned process is signalled.
    this.child?.stdin.end();
  }

  private send<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    if (signal?.aborted) return Promise.reject(aborted());
    const id = this.nextId++;
    const line = JSON.stringify({ ...request, version: 1, id }) + "\n";
    if (Buffer.byteLength(line) > FRAME_LIMIT) return Promise.reject(new Error("검색 요청이 크기 한도를 넘었습니다."));
    return new Promise<T>((resolve, reject) => {
      const finish = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); pending.cleanup(); reject(error);
      };
      const onAbort = () => finish(aborted());
      const timer = setTimeout(() => finish(new Error("검색 실행기 응답 시간이 초과되었습니다.")), this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } });
      signal?.addEventListener("abort", onAbort, { once: true });
      // Ordered writes with pipe backpressure, but not a chain of search responses. Aborting a
      // caller removes only its pending response; it never replaces a shared latest-search id.
      this.writes = this.writes.then(async () => {
        if (!this.pending.has(id)) return;
        const child = this.child;
        if (!child || this.failed) { finish(this.failed ?? new Error("검색 실행기가 종료되었습니다.")); return; }
        await new Promise<void>((written) => child.stdin.write(line, (error) => { if (error) this.fail(error); written(); }));
      }).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private async request<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    await this.start();
    if (this.stopping) throw new Error("검색 서비스가 종료 중입니다.");
    return this.send<T>(request, signal);
  }

  upsert(documents: FastFindDocument[]) { return this.request<Mutation>({ op: "upsert", documents }); }
  remove(documents: { key: string; revision: number }[]) { return this.request<Mutation>({ op: "remove", documents }); }
  search(query: string, options: FastFindOptions = {}, signal?: AbortSignal) {
    return this.request<FastFindResult>({ op: "search", query, nowSecs: Date.now() / 1000, ...options }, signal);
  }
  preview(key: string, scope: FastFindScope = {}, signal?: AbortSignal) {
    return this.request<{ found: boolean; key?: string; text?: string; revision?: number; generation: number }>({ op: "preview", key, scope }, signal);
  }
  similar(key: string, scope: FastFindScope = {}, limit = 20, signal?: AbortSignal) {
    return this.request<{ hits: { path: string; title: string; reason: unknown; score: number }[]; generation: number }>({ op: "similar", key, scope, limit }, signal);
  }
  recordOpen(key: string, query: string) { return this.request({ op: "recordOpen", key, query, nowSecs: Date.now() / 1000 }); }
  setAccess(key: string, timestamps: number[]) { return this.request({ op: "setAccess", key, timestamps }); }
  clearFrecency() { return this.request({ op: "clearFrecency" }); }
  warmUp() { return this.request<{ generation: number }>({ op: "warmUp" }); }
  status() { return this.request<FastFindStatus>({ op: "status" }); }

  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (!this.child) return;
      if (!this.failed) await this.send({ op: "shutdown" }).catch(() => {});
      await this.writes;
      this.child?.stdin.end();
      // Only this still-owned worker is addressed if normal EOF cannot finish shutdown.
      const timer = setTimeout(() => this.child?.kill("SIGTERM"), 2000);
      timer.unref();
      try { await this.done; } finally { clearTimeout(timer); }
    })();
    return this.stopping;
  }
}

function aborted() { const error = new Error("검색 요청이 취소되었습니다."); error.name = "AbortError"; return error; }
