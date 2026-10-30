import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Documents } from "./artifacts.ts";
import type { EditorGrants } from "./editors.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import type { OfficeAiChat, OfficeAiEngine, OfficeAiStream } from "./office-ai-engine.mjs";

export const OFFICE_AI_INPUT_LIMIT = 20_000_000;
const OUTPUT_LIMIT = 32_000_000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, limit = 8_000_000): value is string => typeof value === "string" && value.length <= limit;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const list = (value: unknown, limit: number, valid: (value: unknown) => boolean) => Array.isArray(value) && value.length <= limit && value.every(valid);
function callOf(value: unknown) {
  return record(value) && identifier(value.id) && identifier(value.name) && record(value.input)
    && optional(value.inputError, text) && optional(value.signature, text) && optional(value.truncated, (x) => typeof x === "boolean");
}
function messageOf(value: unknown) {
  if (!record(value)) return false;
  if (value.role === "tool") return list(value.results, 256, (item) => record(item) && identifier(item.id) && identifier(item.name) && text(item.output) && optional(item.isError, (x) => typeof x === "boolean"));
  if (!text(value.text)) return false;
  if (value.role === "assistant") return optional(value.reasoning, text) && optional(value.toolCalls, (items) => list(items, 256, callOf));
  return value.role === "user" && optional(value.images, (items) => list(items, 100, (image) => record(image) && text(image.base64, OFFICE_AI_INPUT_LIMIT) && /^[A-Za-z0-9+/]*={0,2}$/.test(image.base64) && typeof image.mime === "string" && /^image\/(png|jpeg|webp|gif)$/.test(image.mime)));
}
function invalid(): never { throw new HttpError(400, "office_ai_request", "Office AI 요청 형식이 올바르지 않습니다."); }
export function officeAiRequest(value: unknown, stream: true): OfficeAiStream;
export function officeAiRequest(value: unknown, stream: false): OfficeAiChat;
export function officeAiRequest(value: unknown, stream: boolean): OfficeAiStream | OfficeAiChat {
  if (!record(value) || !record(value.settings) || !text(value.system)) return invalid();
  if (!stream) { if (!text(value.user)) return invalid(); return value as OfficeAiChat; }
  if (!identifier(value.requestId) || !optional(value.sessionId, identifier)
    || !list(value.messages, 10_000, messageOf)
    || !optional(value.tools, (items) => list(items, 256, (tool) => record(tool) && identifier(tool.name) && text(tool.description) && record(tool.inputSchema)))
    || !optional(value.maxTokens, (n) => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= 1_000_000)) return invalid();
  return value as unknown as OfficeAiStream;
}

/** Common provider calls, with one owner per document view and a disposable response stream.
 * Does not expose Electron IPC, arbitrary settings writes, filesystem tools or saved credentials.
 * Original editor tools still execute in their own renderer and save through document CAS. */
export class OfficeAi {
  private engine: Promise<OfficeAiEngine> | null = null;
  private readonly active = new Map<string, { owner: string; controller: AbortController }>();
  private readonly load: () => Promise<OfficeAiEngine>;
  private closed = false;
  constructor(dataDir: string, engine?: OfficeAiEngine) {
    this.load = engine ? () => Promise.resolve(engine) : async () => (await import("./office-ai-engine.mjs")).createOfficeAiEngine(dataDir);
  }
  get activeCount() { return this.active.size; }
  close() {
    this.closed = true;
    for (const run of this.active.values()) run.controller.abort();
  }
  async shutdownProviders() {
    if (this.engine) (await import("./office-ai-engine.mjs")).shutdownOfficeAiProviders();
  }
  private begin(owner: string, id: string, response: ServerResponse) {
    if (this.closed) throw new HttpError(503, "office_ai_closed", "앱을 종료하고 있습니다.");
    const key = `${owner}/${id}`;
    if (this.active.has(key)) throw new HttpError(409, "office_ai_duplicate", "같은 AI 요청이 이미 진행 중입니다.");
    if (this.active.size >= 16 || [...this.active.values()].filter((run) => run.owner === owner).length >= 2) throw new HttpError(429, "office_ai_busy", "진행 중인 AI 요청을 마친 뒤 다시 요청해 주세요.");
    const controller = new AbortController(), abort = () => controller.abort();
    if (response.destroyed || response.writableEnded) abort();
    else response.once("close", abort);
    this.active.set(key, { owner, controller });
    return { signal: controller.signal, abort, finish: () => { response.off("close", abort); this.active.delete(key); } };
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, bearer: string | null, documents: Documents, grants: EditorGrants): Promise<boolean> {
    const match = /^\/api\/artifacts\/([^/]+)\/ai\/(settings|statuses|stream|chat|cancel)$/.exec(url.pathname);
    if (!match) return false;
    const [, artifactId, operation] = match;
    const authorize = () => {
      if (!grants.allows(bearer, artifactId!)) throw new HttpError(401, "unauthorized", "이 문서의 AI를 사용할 권한이 없습니다.");
      documents.get(artifactId!);
      if (this.closed) throw new HttpError(503, "office_ai_closed", "앱을 종료하고 있습니다.");
      return `${artifactId}:${grants.previewInfo(bearer!).baseUrl}`;
    };
    const owner = authorize();
    const get = operation === "settings" || operation === "statuses";
    if (req.method !== (get ? "GET" : "POST")) throw new HttpError(405, "method_not_allowed", "허용되지 않은 AI 요청입니다.");
    // No startup status probing, CLI process, model invocation or settings write before a request.
    const engine = await (this.engine ??= this.load().catch((error) => { this.engine = null; throw error; }));
    authorize();
    if (get) {
      const value = operation === "settings" ? engine.settings() : await engine.statuses(url.searchParams.get("refresh") === "1");
      authorize(); sendJson(res, 200, value); return true;
    }
    let raw: unknown;
    try { raw = JSON.parse((await readBody(req, OFFICE_AI_INPUT_LIMIT)).toString("utf8")); } catch (error) {
      if (error instanceof HttpError) throw error;
      return invalid();
    }
    authorize();
    if (operation === "cancel") {
      if (!record(raw) || !identifier(raw.requestId)) return invalid();
      this.active.get(`${owner}/${raw.requestId}`)?.controller.abort();
      sendJson(res, 200, { ok: true }); return true;
    }
    if (operation === "chat") {
      const request = officeAiRequest(raw, false), run = this.begin(owner, randomUUID(), res);
      try { const result = await engine.chat(request, run.signal); if (!res.destroyed) sendJson(res, 200, result); }
      finally { run.finish(); }
      return true;
    }
    const request = officeAiRequest(raw, true), run = this.begin(owner, request.requestId, res);
    // The original Codex session pool must not join two documents that chose the same id.
    const sessionId = createHash("sha256").update(`${owner}/${request.sessionId ?? request.requestId}`).digest("hex");
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.flushHeaders();
    let size = 0, overflow = false;
    try {
      await engine.stream(request, sessionId, run.signal, (chunk) => {
        if (res.destroyed || res.writableEnded || overflow) return;
        const line = `${JSON.stringify(chunk)}\n`;
        size += Buffer.byteLength(line);
        if (size > OUTPUT_LIMIT || res.writableLength > 4_000_000) {
          overflow = true; run.abort();
          res.end(`${JSON.stringify({ requestId: request.requestId, type: "error", error: "AI 응답의 전송 한도를 넘었습니다. 요청을 나눠 다시 시도해 주세요." })}\n`);
        } else res.write(line);
      });
    } catch {
      if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify({ requestId: request.requestId, type: "error", error: "Office AI 요청을 완료하지 못했습니다. 설정과 연결을 확인해 주세요." })}\n`);
    } finally { run.finish(); if (!res.destroyed && !res.writableEnded) res.end(); }
    return true;
  }
}
