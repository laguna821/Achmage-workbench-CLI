import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Provider, SequencedEvent } from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import { HttpError, type SessionManager } from "./sessions.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export type HttpOptions = { token: string; webDir: string | null; onClientLog?: (message: string) => void };

function sameToken(given: string | null, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "too_large", "요청이 너무 큽니다.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "JSON 형식이 아닙니다.");
  }
}

function serveStatic(res: ServerResponse, webDir: string, pathname: string) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(webDir, safe);
  if (!file.startsWith(webDir) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(webDir, "index.html");
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(res);
}

function streamEvents(req: IncomingMessage, res: ServerResponse, bus: EventBus, since: number) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const write = (event: SequencedEvent) => res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  const backlog = bus.replay(since);
  if (backlog === null) {
    // The client is too far behind; it must reload the snapshot.
    res.write(`event: resync\ndata: {}\n\n`);
  } else {
    backlog.forEach(write);
  }
  const unsubscribe = bus.subscribe(write);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export function createHttpServer(manager: SessionManager, bus: EventBus, options: HttpOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (!path.startsWith("/api/")) {
        if (options.webDir) {
          serveStatic(res, options.webDir, path);
        } else {
          sendJson(res, 404, { code: "no_web", message: "web UI is served by the dev server" });
        }
        return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      if (!sameToken(bearer ?? url.searchParams.get("token"), options.token)) {
        throw new HttpError(401, "unauthorized", "인증 토큰이 맞지 않습니다.");
      }
      const parts = path.split("/").filter(Boolean).slice(1);
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/api/snapshot") return sendJson(res, 200, manager.snapshot());
      if (method === "GET" && path === "/api/events") {
        return streamEvents(req, res, bus, Number(url.searchParams.get("since") ?? bus.currentSeq));
      }
      if (method === "POST" && path === "/api/folders") {
        const body = await readJson(req);
        return sendJson(res, 201, manager.createFolder(String(body.name ?? ""), (body.parentId as string | null) ?? null));
      }
      if (method === "POST" && path === "/api/works") {
        const body = await readJson(req);
        return sendJson(
          res,
          201,
          manager.createWork({ title: String(body.title ?? ""), folderId: (body.folderId as string | null) ?? null, cwd: (body.cwd as string | null) ?? null }),
        );
      }
      if (parts[0] === "works" && parts[1] && method === "PATCH" && parts.length === 2) {
        const body = await readJson(req);
        return sendJson(res, 200, manager.updateWork(parts[1], body as never));
      }
      if (parts[0] === "works" && parts[1] && parts[2] === "sessions" && method === "POST") {
        const body = await readJson(req);
        return sendJson(
          res,
          201,
          manager.createSession(parts[1], { provider: body.provider as Provider, purpose: body.purpose as string | undefined, model: (body.model as string | null) ?? null }),
        );
      }
      if (parts[0] === "sessions" && parts[1]) {
        const sessionId = parts[1];
        if (method === "GET" && parts[2] === "items") return sendJson(res, 200, manager.items(sessionId));
        if (method === "PATCH" && parts.length === 2) {
          const body = await readJson(req);
          return sendJson(res, 200, manager.renameSession(sessionId, String(body.purpose ?? "")));
        }
        if (method === "POST" && parts[2] === "messages") {
          const body = await readJson(req);
          return sendJson(res, 202, await manager.send(sessionId, String(body.requestId ?? ""), String(body.text ?? "")));
        }
        if (method === "POST" && parts[2] === "interrupt") {
          await manager.interrupt(sessionId);
          return sendJson(res, 202, { ok: true });
        }
        if (method === "POST" && parts[2] === "approvals" && parts[3]) {
          const body = await readJson(req);
          await manager.answerApproval(sessionId, decodeURIComponent(parts[3]), body.decision as never);
          return sendJson(res, 200, { ok: true });
        }
      }
      if (method === "POST" && parts[0] === "providers" && parts[2] === "login") {
        return sendJson(res, 200, await manager.login(parts[1] as Provider));
      }
      if (method === "POST" && path === "/api/client-log") {
        const body = await readJson(req);
        options.onClientLog?.(String(body.message ?? "").slice(0, 4000));
        return sendJson(res, 204, {});
      }
      if (method === "POST" && path === "/api/providers/refresh") {
        return sendJson(res, 200, await manager.refreshProviders());
      }
      throw new HttpError(404, "not_found", `${method} ${path}`);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { code: error.code, message: error.message });
      } else {
        sendJson(res, 500, { code: "internal", message: error instanceof Error ? error.message : String(error) });
      }
    }
  });
}
