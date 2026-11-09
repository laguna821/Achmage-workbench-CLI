import { randomUUID } from "node:crypto";
import type { RemoteFrame, RemoteRequest, EventCursor } from "@workbench/contracts";
import { REMOTE_BODY_LIMIT, REMOTE_CHUNK_BYTES } from "@workbench/contracts";
import type { DeviceRegistry } from "../devices.ts";
import type { SessionManager } from "../sessions.ts";
import type { EventBus } from "../bus.ts";
import { HttpError } from "../errors.ts";
import { checkReferences, scopedEvent, scopedRoute, scopedSnapshot } from "./scope.ts";
import type { ProtectedSocket as PaseoProtectedSocket } from "./transport.ts";
import { sendProtectedServerInfo } from "./transport.ts";
import { RemoteMediaAccess } from "./media.ts";

export interface ProtectedSocket {
  send(data: string | Uint8Array | ArrayBuffer): void | Promise<void>;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
}
type Upload = { request: RemoteRequest; chunks: Buffer[]; size: number };
export class DeviceGateway {
  private readonly sockets = new Set<ProtectedSocket>();
  private readonly media: RemoteMediaAccess;
  private readonly options: {
    registry: DeviceRegistry; manager: SessionManager; bus: EventBus;
    localOrigin: () => string | null; localToken: string; dataDir: string;
  };
  constructor(options: DeviceGateway["options"]) { this.options = options; this.media = new RemoteMediaAccess(options.dataDir, options.manager); }
  close() { for (const socket of this.sockets) socket.close(1000, "remote access disabled"); this.sockets.clear(); }
  attach = async (socket: ProtectedSocket) => {
    if (this.sockets.size >= 32) { socket.close(1008, "connection limit"); return; }
    this.sockets.add(socket);
    const { registry, manager, bus } = this.options;
    const connectionId = randomUUID(), uploads = new Map<string, Upload>(), requests = new Map<string, AbortController>();
    let credential = "", deviceId = "", rotating = false, closed = false, queued: Promise<void> = Promise.resolve(), releaseEvents: (() => void) | undefined;
    let queuedBytes = 0, uploadBytes = 0;
    const send = (message: Record<string, unknown>) => closed ? Promise.resolve() : Promise.resolve(socket.send(JSON.stringify({ type: "workbench", ...message })));
    const reply = (id: string, value: unknown) => send({ op: "result", id, value });
    const failure = (id: string, error: unknown) => {
      const e = error as { status?: number; code?: string; message?: string };
      return send({ op: "error", id, status: e.status ?? 400, code: e.code ?? "remote_request", message: e.message ?? "연결 요청을 처리하지 못했습니다." });
    };
    const authenticated = () => {
      const grant = registry.authenticate(credential);
      if (!grant) throw new HttpError(401, "DEVICE_REVOKED", "이 기기 연결이 만료되거나 해제되었습니다.");
      return grant;
    };
    const stop = () => {
      if (closed) return; closed = true; releaseEvents?.(); releaseRegistry();
      clearInterval(expiry); this.sockets.delete(socket);
      for (const controller of requests.values()) controller.abort();
      requests.clear(); uploads.clear();
    };
    const releaseRegistry = registry.subscribe(event => {
      // Abort streams too when the owner narrows a still-valid grant. Reconnect
      // obtains a fresh scoped snapshot rather than retaining old project data.
      if (!rotating && credential && ((event.type === "updated" && event.deviceId === deviceId) || !registry.authenticate(credential))) { socket.close(4001, "device grant changed"); stop(); }
    });
    const expiry = setInterval(() => {
      if (credential && !registry.authenticate(credential)) { socket.close(4001, "device grant expired"); stop(); }
    }, 15_000);
    expiry.unref();
    const response = async (id: string, result: Response) => {
      const headers: Record<string, string> = {};
      result.headers.forEach((value, name) => { if (["content-type", "content-disposition", "cache-control"].includes(name)) headers[name] = value; });
      await send({ op: "response", id, status: result.status, headers });
      const reader = result.body?.getReader();
      if (reader) try {
        while (!closed) {
          authenticated();
          const next = await reader.read(); if (next.done) break;
          for (let offset = 0; offset < next.value.byteLength; offset += REMOTE_CHUNK_BYTES) {
            await send({ op: "data", id, data: Buffer.from(next.value.subarray(offset, offset + REMOTE_CHUNK_BYTES)).toString("base64") });
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      await send({ op: "end", id });
    };
    const execute = async (upload: Upload) => {
      const { request } = upload, abort = new AbortController(); requests.set(request.id, abort);
      try {
        const grant = authenticated(), bytes = Buffer.concat(upload.chunks);
        const pathname = new URL(request.path, "http://workbench.invalid").pathname;
        const attachmentUpload = pathname === "/api/attachments" && request.method === "POST";
        let body: Record<string, unknown> = {};
        if (!attachmentUpload && bytes.length && (request.headers["content-type"] ?? "").includes("application/json")) {
          const parsed = JSON.parse(bytes.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json", "JSON 요청을 확인해 주세요.");
          body = parsed;
        }
        const route = scopedRoute(manager, request.method, request.path, body, { grant, headers: request.headers, media: this.media });
        registry.authorize(credential, route.permission, route.workId);
        checkReferences(manager, grant, body);
        this.media.requireReferences(grant, body);
        const json = (value: unknown) => Response.json(value);
        let result: Response;
        if (pathname === "/api/snapshot") result = json(scopedSnapshot(manager.snapshot(), grant));
        else if (pathname === "/api/tasks") {
          const tasks = manager.tasks.list(); result = json({ ...tasks, tasks: tasks.tasks.filter(t => grant.workIds.includes(t.workId)) });
        } else if (pathname === "/api/attention") result = json(scopedSnapshot(manager.snapshot(), grant).attention);
        else if (pathname === "/api/attention/presence") {
          result = json(manager.notifications.observe({ clientId: "remote:" + grant.deviceId + ":" + connectionId,
            sessionId: typeof body.sessionId === "string" ? body.sessionId : null, visible: body.visible === true }));
        }
        else if (pathname === "/api/prefs") {
          // Device layout preferences are held by its own client, not another desktop's UI.
          result = json(request.method === "GET" ? {} : body);
        } else {
          const origin = this.options.localOrigin();
          if (!origin) throw new HttpError(503, "host_starting", "호스트를 시작하고 있습니다.");
          const headers = new Headers();
          for (const name of ["content-type", "x-file-name", "x-workbench-view", "x-workbench-write"]) {
            const value = request.headers[name]; if (typeof value === "string") headers.set(name, value);
          }
          headers.set("authorization", "Bearer " + this.options.localToken);
          result = await fetch(origin + request.path, { method: request.method, headers, body: bytes.length ? bytes : undefined, signal: abort.signal, redirect: "error" });
          if (attachmentUpload && result.ok) {
            // The existing attachment store keeps bytes; this sidecar binds the
            // upload to the approving device/project until it enters a transcript.
            const attachment = await result.json() as import("@workbench/contracts").Attachment;
            registry.authorize(credential, "send", route.workId);
            this.media.remember(grant, route.workId!, attachment);
            result = Response.json(attachment, { status: 201 });
          }
        }
        await response(request.id, result);
      } catch (error) { if (!closed) await failure(request.id, error).catch(() => {}); }
      finally { requests.delete(request.id); }
    };
    const handle = async (message: RemoteFrame) => {
      const id = typeof message.id === "string" && message.id.length <= 100 ? message.id : "";
      if (!id && message.op !== "unsubscribe") throw new HttpError(400, "remote_id", "요청 식별자가 없습니다.");
      if (message.op === "pair") {
        const offer = message.offer as { offerId?: string; token?: string };
        return reply(id, registry.requestPairing({ offerId: String(offer?.offerId ?? ""), token: String(offer?.token ?? ""), name: String(message.name ?? ""), platform: String(message.platform ?? ""), connectionId }));
      }
      if (message.op === "claim") return reply(id, registry.claimCredential({ requestId: String(message.requestId ?? ""), claimToken: String(message.claimToken ?? ""), connectionId }));
      if (message.op === "authenticate") {
        credential = String(message.credential ?? ""); const grant = authenticated();
        deviceId = grant.deviceId;
        return reply(id, { grant, hostId: manager.snapshot().hostId, cursor: { epoch: bus.epoch, seq: bus.currentSeq } });
      }
      if (message.op === "unsubscribe") { releaseEvents?.(); releaseEvents = undefined; return; }
      authenticated();
      if (message.op === "rotate") {
        rotating = true;
        try { const rotated = registry.rotate(credential); credential = rotated.credential; return reply(id, rotated); } finally { rotating = false; }
      }
      if (message.op === "subscribe") {
        registry.authorize(credential, "read");
        releaseEvents?.();
        const cursor = message.cursor as EventCursor | undefined;
        const events = cursor ? bus.replay(cursor.seq, cursor.epoch) : null;
        if (!events) { await send({ op: "resync" }); return reply(id, { subscribed: false }); }
        const emit = async (event: import("@workbench/contracts").SequencedEvent) => {
          const liveGrant = registry.authorize(credential, "read"), scoped = scopedEvent(event, manager, liveGrant);
          if (scoped) await send({ op: "event", event: scoped });
          else await send({ op: "cursor", cursor: { epoch: bus.epoch, seq: event.seq } });
        };
        // Subscribe before yielding; append replay and new events to one ordered queue.
        let delivery = Promise.resolve();
        for (const event of events) delivery = delivery.then(() => emit(event));
        releaseEvents = bus.subscribe(event => { delivery = delivery.then(() => emit(event)).catch(() => { socket.close(4001, "event connection ended"); stop(); }); });
        await send({ op: "cursor", cursor: { epoch: bus.epoch, seq: cursor!.seq } });
        return reply(id, { subscribed: true });
      }
      if (message.op === "request") {
        if (requests.size + uploads.size >= 8 || uploads.has(id) || requests.has(id)) throw new HttpError(429, "remote_capacity", "처리 중인 요청을 기다려 주세요.");
        const request = message.request as RemoteRequest;
        if (!request || typeof request.path !== "string" || request.path.length > 16000 || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
            !Number.isSafeInteger(request.bytes) || request.bytes < 0 || request.bytes > REMOTE_BODY_LIMIT || !request.headers || typeof request.headers !== "object") throw new HttpError(400, "remote_request", "요청 형식을 확인해 주세요.");
        const upload = { request: { ...request, id }, chunks: [], size: 0 };
        if (request.bytes === 0) void execute(upload);
        else uploads.set(id, upload);
        return;
      }
      if (message.op === "upload") {
        const upload = uploads.get(id);
        if (!upload || typeof message.data !== "string" || message.data.length > REMOTE_CHUNK_BYTES * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) throw new HttpError(400, "remote_upload", "파일 전송 순서를 확인해 주세요.");
        const bytes = Buffer.from(message.data, "base64");
        upload.size += bytes.length; uploadBytes += bytes.length;
        if (upload.size > upload.request.bytes || uploadBytes > REMOTE_BODY_LIMIT) { socket.close(1009, "upload limit"); stop(); return; }
        upload.chunks.push(bytes);
        if (upload.size === upload.request.bytes) { uploads.delete(id); uploadBytes -= upload.size; void execute(upload); }
        return;
      }
      if (message.op === "cancel") {
        const upload = uploads.get(id); if (upload) { uploadBytes -= upload.size; uploads.delete(id); }
        requests.get(id)?.abort(); return;
      }
      throw new HttpError(400, "remote_method", "지원하지 않는 연결 요청입니다.");
    };
    socket.on("message", data => {
      if (closed) return;
      const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
      if (text.length > REMOTE_CHUNK_BYTES * 1.5 || queuedBytes + text.length > REMOTE_BODY_LIMIT) { socket.close(1009, "message limit"); stop(); return; }
      queuedBytes += text.length;
      queued = queued.then(async () => {
        let message: RemoteFrame | null = null;
        try {
          message = JSON.parse(text) as RemoteFrame;
          if (!message || message.type !== "workbench") throw new Error("Workbench 연결 메시지가 아닙니다.");
          await handle(message);
        } catch (error) { await failure(message?.id ?? "", error); }
        finally { queuedBytes -= text.length; }
      }).catch(() => { socket.close(1011, "connection failure"); stop(); });
    });
    socket.on("close", stop); socket.on("error", stop);
    await sendProtectedServerInfo(socket as PaseoProtectedSocket, { serverId: manager.snapshot().hostId, hostname: manager.snapshot().hostLabel, version: "0.4.0" });
  };
}
