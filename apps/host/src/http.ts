import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { DocRef, Provider, SequencedEvent } from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import { HttpError, type SessionManager } from "./sessions.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".hwpx": "application/octet-stream",
  ".hwp": "application/octet-stream",
};

/**
 * HTML previews run as an opaque origin (CSP sandbox): scripts work, but the page cannot read the
 * app's storage, token or API. Tickets are random and bound to one revision of one document.
 */
const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";

type PreviewTicket = { file: string; folder: string; name: string; expires: number };

function parseRefs(value: unknown): DocRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const ref = entry as Record<string, unknown>;
    if (typeof ref.artifactId !== "string" || typeof ref.revision !== "number") return [];
    const selection = ref.selection as Record<string, unknown> | null | undefined;
    return [
      {
        artifactId: ref.artifactId,
        revision: ref.revision,
        mode: ref.mode === "edit" ? "edit" : "review",
        selection:
          selection && typeof selection.text === "string"
            ? { from: Number(selection.from ?? 0), to: Number(selection.to ?? 0), text: selection.text, label: String(selection.label ?? "선택 범위") }
            : null,
      } satisfies DocRef,
    ];
  });
}

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
  const tickets = new Map<string, PreviewTicket>();
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path.startsWith("/preview/")) {
        const [, , ticketId, ...rest] = path.split("/");
        const ticket = tickets.get(ticketId ?? "");
        if (!ticket || ticket.expires < Date.now()) throw new HttpError(404, "preview_expired", "미리보기가 만료되었습니다.");
        const wanted = decodeURIComponent(rest.join("/"));
        // The document itself comes from its pinned revision; neighbours (images, css) from its folder.
        const file = wanted === ticket.name ? ticket.file : resolve(ticket.folder, wanted);
        if (file !== ticket.file && !file.startsWith(ticket.folder + sep)) throw new HttpError(403, "outside", "허용되지 않은 경로입니다.");
        if (!existsSync(file) || statSync(file).isDirectory()) throw new HttpError(404, "not_found", wanted);
        res.writeHead(200, {
          "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-security-policy": PREVIEW_CSP,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        createReadStream(file).pipe(res);
        return;
      }
      if (!path.startsWith("/api/")) {
        if (options.webDir) {
          serveStatic(res, options.webDir, path);
        } else {
          sendJson(res, 404, { code: "no_web", message: "web UI is served by the dev server" });
        }
        return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      // A token in the URL is accepted only for the event stream (EventSource cannot set headers).
      const queryToken = req.method === "GET" && path === "/api/events" ? url.searchParams.get("token") : null;
      if (!sameToken(bearer ?? queryToken, options.token)) {
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
          manager.createSession(parts[1], {
            provider: body.provider as Provider,
            purpose: body.purpose as string | undefined,
            model: (body.model as string | null) ?? null,
            effort: (body.effort as string | null) ?? null,
          }),
        );
      }
      if (parts[0] === "sessions" && parts[1]) {
        const sessionId = parts[1];
        if (method === "GET" && parts[2] === "items") return sendJson(res, 200, manager.items(sessionId));
        if (method === "PATCH" && parts.length === 2) {
          const body = await readJson(req);
          return sendJson(
            res,
            200,
            manager.updateSession(sessionId, {
              purpose: typeof body.purpose === "string" ? body.purpose : undefined,
              model: body.model === undefined ? undefined : ((body.model as string | null) ?? null),
              effort: body.effort === undefined ? undefined : ((body.effort as string | null) ?? null),
            }),
          );
        }
        if (method === "POST" && parts[2] === "messages") {
          const body = await readJson(req);
          return sendJson(res, 202, await manager.send(sessionId, String(body.requestId ?? ""), String(body.text ?? ""), parseRefs(body.refs)));
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
      if (parts[0] === "works" && parts[1] && parts[2] === "artifacts" && method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, manager.openFile(parts[1], String(body.path ?? "")));
      }
      if (parts[0] === "artifacts" && parts[1]) {
        const documents = manager.documents;
        const artifactId = parts[1];
        const revision = url.searchParams.get("revision") ? Number(url.searchParams.get("revision")) : undefined;
        if (method === "GET" && parts[2] === "text") return sendJson(res, 200, await documents.text(artifactId, revision));
        if (method === "GET" && parts[2] === "pages") return sendJson(res, 200, await documents.pages(artifactId, revision));
        if (method === "PUT" && parts[2] === "text") {
          const body = await readJson(req);
          return sendJson(res, 200, await documents.saveText(artifactId, Number(body.expectedRevision), String(body.text ?? "")));
        }
        if (method === "GET" && parts[2] === "revisions") return sendJson(res, 200, documents.revisions(artifactId));
        if (method === "GET" && parts[2] === "raw") {
          const artifact = documents.check(artifactId);
          const file = documents.revisionPath(artifactId, revision ?? artifact.revision);
          res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
          createReadStream(file).pipe(res);
          return;
        }
        if (method === "POST" && parts[2] === "adopt-disk") return sendJson(res, 200, documents.adoptDisk(artifactId));
        if (method === "POST" && parts[2] === "revert") {
          const body = await readJson(req);
          return sendJson(res, 200, documents.revert(artifactId, Number(body.toRevision)));
        }
        if (method === "POST" && parts[2] === "preview") {
          const artifact = documents.check(artifactId);
          const target = revision ?? artifact.revision;
          const ticketId = randomBytes(18).toString("base64url");
          tickets.set(ticketId, { file: documents.revisionPath(artifactId, target), folder: dirname(artifact.path), name: artifact.name, expires: Date.now() + 6 * 3600_000 });
          return sendJson(res, 200, { url: `/preview/${ticketId}/${encodeURIComponent(artifact.name)}`, revision: target });
        }
        if (method === "POST" && parts[2] === "pdf-edit") {
          const body = await readJson(req);
          return sendJson(res, 200, await manager.editPdf(artifactId, body as never));
        }
      }
      if (parts[0] === "proposals" && parts[1]) {
        const documents = manager.documents;
        if (method === "GET" && parts.length === 2) return sendJson(res, 200, await documents.proposalTexts(parts[1]));
        if (method === "POST" && parts[2] === "apply") return sendJson(res, 200, await documents.applyProposal(parts[1]));
        if (method === "POST" && parts[2] === "discard") return sendJson(res, 200, documents.discardProposal(parts[1]));
      }
      if (method === "POST" && path === "/api/handoffs") {
        const body = await readJson(req);
        return sendJson(
          res,
          202,
          await manager.handoff({
            requestId: String(body.requestId ?? ""),
            sourceSessionId: String(body.sourceSessionId ?? ""),
            targetSessionId: String(body.targetSessionId ?? ""),
            text: String(body.text ?? ""),
            refs: parseRefs(body.refs),
          }),
        );
      }
      if (method === "POST" && parts[0] === "providers" && parts[2] === "login") {
        return sendJson(res, 200, await manager.login(parts[1] as Provider));
      }
      if (method === "PUT" && path === "/api/prefs") {
        const body = await readJson(req);
        return sendJson(res, 200, { prefs: manager.setPrefs(body.prefs) });
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
