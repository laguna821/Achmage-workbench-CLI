import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { isAccessMode, parseSearchScope, type AccessMode, type Attachment, type CreateSessionRequest, type DocRef, type DocumentViewInput, type Provider, type SequencedEvent, type Timeline } from "@workbench/contracts";
import type { EventBus } from "./bus.ts";
import { HttpError, type SessionManager } from "./sessions.ts";
import { DESIGN_PRESETS, systemFonts, type DesignPreset } from "./design.ts";
import { parseCreate } from "./create.ts";
import { officeEditorKind, type EditorGrants } from "./editors.ts";
import { parseDrawRequest } from "./imagegen.ts";
import { parseStartRequest } from "./links.ts";
import type { AgentBrowser } from "./browse.ts";
import { routeDocImages, type DocImages } from "./doc-images.ts";
import { routeCalendar, type CalendarFeeds } from "./calendar-feeds.ts";
import { documentAccess } from "./document-registry.ts";
import { skillRoutes } from "./skills-http.ts";
import { OfficeOutputs } from "./office-output.ts";

export const MIME: Record<string, string> = {
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
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".weba": "audio/webm",
  ".wasm": "application/wasm",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
};

/** A rendered page image; revisions never change, so it can be kept. */
function sendPng(res: ServerResponse, file: string) {
  res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
  createReadStream(file).pipe(res);
}

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
        ...(typeof ref.sha256 === "string" ? { sha256: ref.sha256 } : {}),
        ...(ref.savedSnapshot === true ? { savedSnapshot: true } : {}),
        mode: ref.mode === "edit" ? "edit" : "review",
        selection:
          selection && typeof selection.text === "string"
            ? {
                from: Number(selection.from ?? 0),
                to: Number(selection.to ?? 0),
                text: selection.text,
                label: String(selection.label ?? "선택 범위"),
                ...(typeof selection.pageId === "string" ? { pageId: selection.pageId } : {}),
                ...(Array.isArray(selection.objectIds) ? { objectIds: selection.objectIds.filter((id): id is string => typeof id === "string").slice(0, 200) } : {}),
              }
            : null,
      } satisfies DocRef,
    ];
  });
}

export type HttpOptions = {
  token: string;
  webDir: string | null;
  onClientLog?: (message: string) => void;
  /** The office editors' own origin (editors.ts) and the grants that let one page open one document. */
  editors?: { grants: EditorGrants; origin: () => string | null };
  /** The agent browser (browse.ts). */
  browse?: AgentBrowser | null;
  /** Turns and revisions in `[since, until)` (or since a time), for home "흐름" (timeline.ts). */
  timeline?: (since: number, until?: number) => Timeline;
  /** Images pasted into Markdown documents (doc-images.ts). */
  docImages?: DocImages;
  /** Calendar feeds on home "흐름" (calendar-feeds.ts). */
  calendar?: CalendarFeeds;
  /** `/api/pkm/*` (pkm-http.ts): the vault mirror, views, rules and pages; true when it answered. */
  pkm?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  /** `/api/projects/*` (project-http.ts): a work as a project note; true when it answered. */
  projects?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  /** `/api/entry/*` (entry.ts): the live work of a folder, the location of new project folders. */
  entry?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
};

function sameToken(given: string | null, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", "요청이 너무 큽니다.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "JSON 형식이 아닙니다.");
  }
}

export function serveStatic(res: ServerResponse, webDir: string, pathname: string, pageHeaders: Record<string, string> = {}) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const rel = safe.replace(/^[/\\]+/, "");
  let file = join(webDir, safe);
  const found = file.startsWith(webDir) && existsSync(file) && !statSync(file).isDirectory();
  if (!found) {
    // The office editor pages ask for exact files (fonts, workers, pdf.js data): a missing one is an error.
    if (/^office([/\\]|$)/.test(rel)) return sendJson(res, 404, { code: "not_found", message: "편집기 파일이 없습니다." });
    // The design page is its own app under /design/; everything else falls back to the main UI.
    const app = rel.startsWith("design") ? join(webDir, "design", "index.html") : join(webDir, "index.html");
    file = existsSync(app) ? app : join(webDir, "index.html");
  }
  // Pages are fetched fresh after every update; only content-hashed build files (…/assets/…) are kept for good.
  const hashed = found && /(^|[/\\])assets[/\\]/.test(rel);
  const page = extname(file) === ".html";
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": page ? "no-store" : hashed ? "public, max-age=31536000, immutable" : "no-cache",
    ...(page ? pageHeaders : {}),
  });
  createReadStream(file).pipe(res);
}

function streamEvents(req: IncomingMessage, res: ServerResponse, bus: EventBus, since: number) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  // Send the headers at once: the browser reports the stream as open only when they arrive.
  res.write(": open\n\n");
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
  const userSkills = skillRoutes(manager);
  const outputs = new OfficeOutputs(manager.documents, (source, path) => manager.openFile(source.workId, path, source.workspaceId));
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
        // The office editors are served only from their own origin (editors.ts).
        if (/^\/office(\/|$)/.test(path)) throw new HttpError(404, "not_here", "편집기는 따로 열립니다.");
        if (options.webDir) {
          serveStatic(res, options.webDir, path);
        } else {
          sendJson(res, 404, { code: "no_web", message: "web UI is served by the dev server" });
        }
        return;
      }
      // The vendored design editor asks a doory server for optional catalogues; there is none.
      if (path.startsWith("/api/v1/")) throw new HttpError(404, "no_doory_server", "doory 서버 없이 동작합니다.");
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      // A token in the URL is accepted only for the event stream (EventSource cannot set headers).
      const queryToken = req.method === "GET" && path === "/api/events" ? url.searchParams.get("token") : null;
      if (!sameToken(bearer ?? queryToken, options.token)) {
        throw new HttpError(401, "unauthorized", "인증 토큰이 맞지 않습니다.");
      }
      const parts = path.split("/").filter(Boolean).slice(1);
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/api/snapshot") return sendJson(res, 200, manager.snapshot());
      if (await userSkills(req, res, url)) return;
      if (path.startsWith("/api/pkm/") && options.pkm && (await options.pkm(req, res, url))) return;
      if (path.startsWith("/api/projects/") && options.projects && (await options.projects(req, res, url))) return;
      if (path.startsWith("/api/entry/") && options.entry && (await options.entry(req, res, url))) return;
      if (method === "GET" && path === "/api/events") {
        return streamEvents(req, res, bus, Number(url.searchParams.get("since") ?? bus.currentSeq));
      }
      if (method === "POST" && path === "/api/folders") {
        const body = await readJson(req);
        return sendJson(res, 201, manager.createFolder(String(body.name ?? ""), (body.parentId as string | null) ?? null));
      }
      if (parts[0] === "folders" && parts[1] && method === "PATCH" && parts.length === 2) {
        const body = await readJson(req);
        return sendJson(
          res,
          200,
          manager.updateFolder(parts[1], {
            name: typeof body.name === "string" ? body.name : undefined,
            parentId: body.parentId === undefined ? undefined : ((body.parentId as string | null) ?? null),
            sort: body.sort === undefined ? undefined : Number(body.sort),
            archived: typeof body.archived === "boolean" ? body.archived : undefined,
            color: body.color === undefined ? undefined : (body.color as string | null),
            icon: body.icon === undefined ? undefined : (body.icon as string | null),
          }),
        );
      }
      // "폴더만 지우기": what was inside moves up (folders.ts).
      if (parts[0] === "folders" && parts[1] && method === "DELETE" && parts.length === 2) return sendJson(res, 200, manager.deleteFolder(parts[1]));
      if (method === "GET" && path === "/api/search") {
        // "찾는 길" (search.ts): scope, paging and totals; q/provider/archived/folderId as before.
        const provider = url.searchParams.get("provider");
        const number = (name: string) => (url.searchParams.has(name) ? Number(url.searchParams.get(name)) || 0 : undefined);
        return sendJson(
          res,
          200,
          manager.search(url.searchParams.get("q") ?? "", {
            archived: url.searchParams.get("archived") === "1",
            provider: provider === "claude" || provider === "codex" ? provider : null,
            folderId: url.searchParams.get("folderId"),
            scope: parseSearchScope(url.searchParams.get("scope")),
            offset: number("offset"),
            limit: number("limit"),
            per: number("per"),
            group: url.searchParams.get("group"),
            legacy: url.searchParams.get("legacy") !== "0",
          }),
        );
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
        return sendJson(
          res,
          200,
          manager.updateWork(parts[1], {
            title: typeof body.title === "string" ? body.title : undefined,
            folderId: body.folderId === undefined ? undefined : ((body.folderId as string | null) ?? null),
            activeSessionId: body.activeSessionId === undefined ? undefined : ((body.activeSessionId as string | null) ?? null),
            pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
            sort: body.sort === undefined ? undefined : Number(body.sort),
            archived: typeof body.archived === "boolean" ? body.archived : undefined,
            tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
          }),
        );
      }
      if (parts[0] === "works" && parts[1] && parts[2] === "workspaces" && parts.length === 3) {
        if (method === "GET") return sendJson(res, 200, { workspaces: manager.workspaces.list().filter((entry) => entry.workId === parts[1]) });
        if (method === "POST") {
          const body = await readJson(req);
          return sendJson(res, 201, manager.createWorkspace(parts[1], { cwd: String(body.cwd ?? ""), label: typeof body.label === "string" ? body.label : undefined }));
        }
      }
      if (parts[0] === "workspaces" && parts[1] && parts.length === 2 && method === "PATCH") {
        const body = await readJson(req);
        return sendJson(res, 200, manager.updateWorkspace(parts[1], { label: typeof body.label === "string" ? body.label : undefined, archived: typeof body.archived === "boolean" ? body.archived : undefined }));
      }
      if (parts[0] === "workspaces" && parts[1] && parts[2] === "repository" && parts.length === 3 && method === "GET") {
        return sendJson(res, 200, await manager.worktreeWorkspaces.inspect(parts[1]));
      }
      if (parts[0] === "works" && parts[1] && parts[2] === "environment" && parts.length === 3) {
        if (method === "GET") return sendJson(res, 200, manager.preparation.settings(parts[1]));
        if (method === "PUT") { const body = await readJson(req); return sendJson(res, 200, manager.preparation.saveSettings(parts[1], body.expectedRevision, body.settings)); }
      }
      if (parts[0] === "workspaces" && parts[1] && parts[2] === "preparations") {
        if (parts.length === 3 && method === "GET") return sendJson(res, 200, { jobs: manager.preparation.list(parts[1]) });
        if (parts.length === 3 && method === "POST") return sendJson(res, 201, await manager.preparation.start(parts[1], await readJson(req) as unknown as import("@workbench/contracts").ApplyPreparationRequest));
        if (parts.length === 4 && parts[3] === "preview" && method === "POST") return sendJson(res, 200, await manager.preparation.preview(parts[1], await readJson(req) as unknown as import("@workbench/contracts").PreparationOptions));
      }
      if (parts[0] === "preparations" && parts[1] && parts.length === 2) {
        if (method === "GET") return sendJson(res, 200, manager.preparation.get(parts[1]));
        if (method === "DELETE") return sendJson(res, 200, await manager.preparation.cancel(parts[1]));
      }
      if (parts[0] === "workspaces" && parts[1] && parts[2] === "scm") {
        if (parts.length === 4 && parts[3] === "github" && method === "GET") return sendJson(res, 200, await manager.github.binding(parts[1]));
        if (parts.length === 4 && parts[3] === "github" && method === "POST") return sendJson(res, 200, await manager.github.load(parts[1], await readJson(req, 16 * 1024) as unknown as import("@workbench/contracts").GitHubSelection));
        if (parts.length === 5 && parts[3] === "github" && ["check", "log"].includes(parts[4]!) && method === "POST") {
          const body = await readJson(req, 16 * 1024), args = [parts[1], String(body.id ?? ""), String(body.revision ?? ""), String(body.item ?? "")] as const;
          return sendJson(res, 200, await (parts[4] === "check" ? manager.github.details(...args) : manager.github.log(...args)));
        }
        if (parts.length === 4 && parts[3] === "reviews" && method === "GET") return sendJson(res, 200, manager.scmReviews.list(parts[1], url.searchParams.get("snapshot") ?? undefined));
        if (parts.length === 4 && parts[3] === "reviews" && method === "POST") return sendJson(res, 201, manager.scmReviews.create(parts[1], await readJson(req, 96 * 1024) as unknown as import("@workbench/contracts").ScmReviewCreate));
        if (parts.length === 5 && parts[3] === "reviews" && method === "PATCH") return sendJson(res, 200, manager.scmReviews.edit(parts[1], parts[4]!, await readJson(req, 96 * 1024) as unknown as import("@workbench/contracts").ScmReviewEdit));
        if (parts.length === 4 && parts[3] === "review-batches" && method === "POST") return sendJson(res, 201, await manager.scmReviews.send(parts[1], await readJson(req, 16 * 1024) as unknown as import("@workbench/contracts").ScmReviewBatchRequest));
        if (parts.length === 4 && parts[3] === "compare-preferences" && method === "GET") return sendJson(res, 200, { preferences: manager.sourceControl.comparisonPreferences(parts[1]) });
        if (parts.length === 4 && parts[3] === "compare-preferences" && method === "PUT") return sendJson(res, 200, { preferences: manager.sourceControl.saveComparisonPreferences(parts[1], await readJson(req, 12 * 1024) as unknown as import("@workbench/contracts").ScmComparisonPreferences) });
        if (parts.length === 4 && parts[3] === "compare" && method === "POST") return sendJson(res, 200, await manager.sourceControl.compare(parts[1], await readJson(req) as unknown as import("@workbench/contracts").ScmComparisonRequest));
        if (parts.length === 4 && parts[3] === "compare-diff" && method === "POST") { const body = await readJson(req); return sendJson(res, 200, await manager.sourceControl.compareDiff(parts[1], String(body.id ?? ""), String(body.revision ?? ""), String(body.path ?? ""))); }
        if (parts.length === 4 && parts[3] === "remotes" && method === "GET") return sendJson(res, 200, await manager.sourceControl.remoteInventory(parts[1]));
        if (parts.length === 4 && parts[3] === "push-preview" && method === "POST") return sendJson(res, 200, await manager.sourceControl.pushPreview(parts[1], await readJson(req) as unknown as import("@workbench/contracts").ScmRemoteRequest));
        if (parts.length === 3 && method === "GET") return sendJson(res, 200, await manager.sourceControl.status(parts[1]));
        if (parts.length === 4 && parts[3] === "diff" && method === "POST") { const body = await readJson(req); return sendJson(res, 200, await manager.sourceControl.diff(parts[1], String(body.path ?? ""), body.area as import("@workbench/contracts").ScmArea, String(body.expectedRevision ?? ""))); }
        if (parts.length === 4 && parts[3] === "conflict" && method === "POST") { const body = await readJson(req); return sendJson(res, 200, await manager.sourceControl.conflict(parts[1], String(body.path ?? ""), String(body.expectedRevision ?? ""))); }
        if (parts.length === 4 && parts[3] === "jobs" && method === "GET") return sendJson(res, 200, { jobs: manager.sourceControl.list(parts[1]) });
        if (parts.length === 4 && parts[3] === "jobs" && method === "POST") return sendJson(res, 201, await manager.sourceControl.start(parts[1], await readJson(req, 16 * 1024 * 1024) as unknown as import("@workbench/contracts").ScmRequest));
      }
      if (parts[0] === "scm-jobs" && parts[1] && parts.length === 2 && method === "GET") return sendJson(res, 200, manager.sourceControl.get(parts[1]));
      if (parts[0] === "scm-jobs" && parts[1] && parts.length === 2 && method === "DELETE") return sendJson(res, 200, await manager.sourceControl.interrupt(parts[1]));
      if (parts[0] === "workspaces" && parts[1] && parts[2] === "terminals" && parts.length === 3) {
        if (method === "GET") return sendJson(res, 200, manager.terminals.list(parts[1]));
        if (method === "POST") return sendJson(res, 201, manager.terminals.create(parts[1], await readJson(req) as unknown as import("@workbench/contracts").CreateTerminalRequest));
      }
      if (parts[0] === "terminals" && parts[1]) {
        if (parts.length === 2 && method === "GET") return sendJson(res, 200, manager.terminals.output(parts[1], Number(url.searchParams.get("cursor") ?? 0)));
        if (parts.length === 2 && method === "DELETE") return sendJson(res, 200, await manager.terminals.close(parts[1]));
        if (parts.length === 3 && method === "POST") {
          const body = await readJson(req);
          if (parts[2] === "input") return sendJson(res, 200, manager.terminals.input(parts[1], body.data));
          if (parts[2] === "resize") return sendJson(res, 200, manager.terminals.resize(parts[1], body.cols, body.rows));
        }
      }
      if (parts[0] === "workspaces" && parts[1] && parts[2] === "worktrees" && parts.length === 3 && method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 201, await manager.worktreeWorkspaces.connect(parts[1], String(body.path ?? ""), String(body.expectedHead ?? "")));
      }
      if (parts[0] === "works" && parts[1] && parts[2] === "worktree-creations" && parts.length === 3) {
        if (method === "GET") return sendJson(res, 200, manager.worktreeWorkspaces.list(parts[1]));
        if (method === "POST") return sendJson(res, 202, manager.worktreeWorkspaces.start(parts[1], await readJson(req) as unknown as import("@workbench/contracts").CreateWorktreeWorkspaceRequest));
      }
      if (parts[0] === "worktree-creations" && parts[1] && parts.length === 2 && method === "DELETE") {
        return sendJson(res, 200, manager.worktreeWorkspaces.cancel(parts[1]));
      }
      if (parts[0] === "layouts" && parts[1] && parts.length === 2) {
        if (method === "GET") return sendJson(res, 200, { record: manager.layouts.read(parts[1]) });
        if (method === "PUT") {
          const body = await readJson(req);
          return sendJson(res, 200, { record: manager.layouts.write(parts[1], body.expectedRevision, body.layout) });
        }
      }
      if (parts[0] === "works" && parts[1] && parts[2] === "sessions" && method === "POST") {
        const body = await readJson(req);
        return sendJson(
          res,
          201,
          await (body.worktree === true ? manager.createIsolatedSession.bind(manager) : async (workId: string, request: CreateSessionRequest) => manager.createSession(workId, request))(parts[1], {
            provider: body.provider as Provider,
            workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : undefined,
            purpose: body.purpose as string | undefined,
            model: (body.model as string | null) ?? null,
            effort: (body.effort as string | null) ?? null,
            access: isAccessMode(body.access) ? body.access : null,
            browser: body.browser === true,
          }),
        );
      }
      // "그림": draw with GPT Image through Codex, the drawings, templates, and picture files of a work.
      if (parts[0] === "sessions" && parts[1] && parts[2] === "images" && method === "POST" && parts.length === 3) {
        return sendJson(res, 202, await manager.images.draw(parts[1], parseDrawRequest(await readJson(req))));
      }
      if (parts[0] === "images" && parts[1] && method === "GET" && parts.length === 2) return sendJson(res, 200, manager.images.get(decodeURIComponent(parts[1])));
      if (path === "/api/image-templates" && method === "GET") return sendJson(res, 200, manager.images.templates());
      if (path === "/api/image-templates" && method === "PUT") return sendJson(res, 200, manager.images.saveTemplates(await readJson(req)));
      if (parts[0] === "works" && parts[1] && parts[2] === "image" && method === "GET") {
        const file = manager.images.file(parts[1], url.searchParams.get("path") ?? "", url.searchParams.get("workspaceId") ?? undefined);
        res.writeHead(200, { "content-type": file.type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        createReadStream(file.path).pipe(res);
        return;
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
              pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
              sort: body.sort === undefined ? undefined : Number(body.sort),
              archived: typeof body.archived === "boolean" ? body.archived : undefined,
              seen: typeof body.seen === "boolean" ? body.seen : undefined,
              access: body.access === undefined ? undefined : body.access === null ? null : (body.access as AccessMode),
              browser: typeof body.browser === "boolean" ? body.browser : undefined,
              muted: typeof body.muted === "boolean" ? body.muted : undefined,
            }),
          );
        }
        if (method === "POST" && parts[2] === "compact") return sendJson(res, 202, await manager.compact(sessionId));
        if (method === "GET" && parts[2] === "commands") return sendJson(res, 200, { commands: await manager.commands(sessionId) });
        if (method === "POST" && parts[2] === "fork") return sendJson(res, 201, await manager.forkBefore(sessionId, String((await readJson(req)).itemId ?? "")));
        if (method === "GET" && parts[2] === "worktree" && parts.length === 3) return sendJson(res, 200, await manager.worktreeChanges(sessionId));
        if (method === "POST" && parts[2] === "worktree" && parts[3] === "apply") return sendJson(res, 200, await manager.applyWorktree(sessionId));
        if (method === "POST" && parts[2] === "worktree" && parts[3] === "discard") return sendJson(res, 200, await manager.discardWorktree(sessionId));
        if (method === "POST" && parts[2] === "export") {
          const body = await readJson(req);
          const target = body.target === "path" ? "path" : body.target === "text" ? "text" : "work";
          return sendJson(res, 200, manager.exportMarkdown(sessionId, { target, path: typeof body.path === "string" ? body.path : undefined, tools: body.tools === true }));
        }
        if (method === "POST" && parts[2] === "messages") {
          const body = await readJson(req);
          return sendJson(
            res,
            202,
            await manager.send(
              sessionId,
              String(body.requestId ?? ""),
              String(body.text ?? ""),
              parseRefs(body.refs),
              null,
              parseCreate(body.create),
              body.mode === "steer" || body.mode === "queue" ? body.mode : "auto",
              {
                attachments: parseAttachments(body.attachments),
                plan: body.plan === true,
                notes: Array.isArray(body.notes) ? body.notes.filter((note): note is string => typeof note === "string").slice(0, 20) : [],
                omitChanges: Array.isArray(body.omitChanges) ? body.omitChanges.filter((line): line is string => typeof line === "string").slice(0, 50) : [],
              },
            ),
          );
        }
        if (parts[2] === "queue" && parts[3]) {
          const queuedId = decodeURIComponent(parts[3]);
          if (method === "DELETE" && parts.length === 4) return sendJson(res, 200, manager.cancelQueued(sessionId, queuedId));
          if (method === "PATCH" && parts.length === 4) {
            const body = await readJson(req);
            return sendJson(res, 200, manager.updateQueued(sessionId, queuedId, String(body.text ?? "")));
          }
          if (method === "POST" && parts[4] === "send") return sendJson(res, 202, await manager.sendQueued(sessionId, queuedId));
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
      if (parts[0] === "works" && parts[1] && parts[2] === "pages" && method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 201, manager.createPage(parts[1], typeof body.name === "string" ? body.name : "", typeof body.workspaceId === "string" ? body.workspaceId : undefined));
      }
      if (parts[0] === "works" && parts[1] && parts[2] === "designs" && method === "POST") {
        const body = await readJson(req, 64_000_000);
        const preset = (typeof body.preset === "string" && body.preset in DESIGN_PRESETS ? body.preset : "square") as DesignPreset;
        return sendJson(res, 201, manager.createDesign(parts[1], String(body.name ?? ""), preset, typeof body.text === "string" ? body.text : null, typeof body.workspaceId === "string" ? body.workspaceId : undefined));
      }
      if (path === "/api/schedules" && method === "GET") return sendJson(res, 200, { schedules: manager.schedules.all() });
      if (path === "/api/schedules" && method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 201, manager.schedules.create({ sessionId: String(body.sessionId ?? ""), text: String(body.text ?? ""), when: body.when as never }));
      }
      if (parts[0] === "schedules" && parts[1] && parts.length === 2 && method === "PATCH") {
        const body = await readJson(req);
        return sendJson(res, 200, manager.schedules.update(decodeURIComponent(parts[1]), { enabled: typeof body.enabled === "boolean" ? body.enabled : undefined }));
      }
      if (parts[0] === "schedules" && parts[1] && parts.length === 2 && method === "DELETE") {
        manager.schedules.remove(decodeURIComponent(parts[1]));
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/import") {
        const provider = url.searchParams.get("provider");
        if (provider !== "claude" && provider !== "codex") throw new HttpError(400, "invalid_provider", "엔진을 골라 주세요.");
        return sendJson(res, 200, { candidates: await manager.importCandidates(provider, url.searchParams.get("q") ?? "") });
      }
      if (method === "POST" && path === "/api/import") {
        const body = await readJson(req);
        if (body.provider !== "claude" && body.provider !== "codex") throw new HttpError(400, "invalid_provider", "엔진을 골라 주세요.");
        return sendJson(res, 201, await manager.importSession({ provider: body.provider, nativeSessionId: String(body.nativeSessionId ?? "") }));
      }
      if (method === "POST" && path === "/api/attachments") {
        const data = await readBody(req, 26 * 1024 * 1024);
        const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "첨부"));
        return sendJson(res, 201, manager.attachments.save(data, name, String(req.headers["content-type"] ?? "")));
      }
      if (method === "GET" && parts[0] === "attachments" && parts[1] && parts.length === 2) {
        const file = manager.attachments.path(decodeURIComponent(parts[1]));
        res.writeHead(200, { "content-type": attachmentType(file), "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
        createReadStream(file).pipe(res);
        return;
      }
      if (method === "GET" && path === "/api/views/timeline" && options.timeline) {
        const since = Number(url.searchParams.get("since") ?? 0);
        // An explicit window (a past week or month); without `until`, everything since `since` as before.
        const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : NaN;
        const from = Number.isFinite(since) ? since : 0;
        return sendJson(res, 200, options.timeline(from, Number.isFinite(until) && until > from ? until : undefined));
      }
      if (method === "GET" && path === "/api/fonts") return sendJson(res, 200, { fonts: systemFonts() });
      if (method === "GET" && path === "/api/document-views") return sendJson(res, 200, { views: manager.documents.registry.list() });
      if (method === "POST" && path === "/api/document-references") {
        const body = await readJson(req);
        return sendJson(res, 200, { refs: manager.documents.resolveReferences(body.refs) });
      }
      if (method === "DELETE" && parts[0] === "document-views" && parts[1]) {
        const body = await readJson(req);
        manager.documents.registry.close(parts[1], String(body.windowId ?? ""));
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/tools") return sendJson(res, 200, manager.tools());
      if (method === "POST" && path === "/api/tools/refresh") return sendJson(res, 200, await manager.refreshTools());
      if (method === "POST" && path === "/api/tools/ieumoffice/install") return sendJson(res, 202, manager.installIeumOffice());
      if (method === "GET" && path === "/api/integrations") return sendJson(res, 200, await manager.integrations());
      if (method === "POST" && path.startsWith("/api/integrations/")) {
        const body = await readJson(req);
        const to = body.to === "claude" ? "claude" : body.to === "codex" ? "codex" : null;
        if (!to) throw new HttpError(400, "bad_target", "어느 엔진에 넣을지 정해 주세요.");
        if (path === "/api/integrations/mcp/copy") return sendJson(res, 200, await manager.copyMcp(String(body.name ?? ""), to));
        if (path === "/api/integrations/skills/copy") return sendJson(res, 200, await manager.copySkill(String(body.name ?? ""), to));
        if (path === "/api/integrations/ieum-skill") return sendJson(res, 200, await manager.installIeumSkill(to));
      }
      if (parts[0] === "works" && parts[1] && parts[2] === "artifacts" && method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, manager.openFile(parts[1], String(body.path ?? ""), typeof body.workspaceId === "string" ? body.workspaceId : undefined));
      }
      // Pictures in documents: R2 settings, pasted images, Markdown preview pictures, the desktop clipboard's picture.
      if (options.docImages && (await routeDocImages(options.docImages, req, res, url))) return;
      if (options.calendar && (await routeCalendar(options.calendar, req, res, url))) return;
      if (parts[0] === "artifacts" && parts[1]) {
        const documents = manager.documents;
        const artifactId = parts[1];
        const revision = url.searchParams.get("revision") ? Number(url.searchParams.get("revision")) : undefined;
        if (method === "POST" && parts[2] === "outputs") {
          if (parts[3]) return sendJson(res, 201, await outputs.commit(artifactId, parts[3], await readBody(req, 201_000_004), url.searchParams.get("replace") === "1"));
          const body = await readJson(req);
          return sendJson(res, 200, outputs.prepare(artifactId, Number(body.revision), String(body.path ?? "")));
        }
        if (method === "POST" && parts[2] === "views") return sendJson(res, 200, documents.registry.open(artifactId, await readJson(req) as DocumentViewInput));
        if (method === "GET" && parts[2] === "text") return sendJson(res, 200, await documents.text(artifactId, revision));
        if (method === "GET" && parts[2] === "pages") return sendJson(res, 200, await documents.pages(artifactId, revision));
        if (method === "PUT" && parts[2] === "text") {
          const body = await readJson(req, 64_000_000);
          return sendJson(res, 200, await documents.saveText(artifactId, Number(body.expectedRevision), String(body.text ?? ""), documentAccess(req)));
        }
        if (method === "GET" && parts[2] === "revisions") return sendJson(res, 200, documents.revisions(artifactId));
        if (method === "GET" && parts[2] === "raw") {
          const artifact = documents.check(artifactId);
          const file = documents.revisionPath(artifactId, revision ?? artifact.revision);
          res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
          createReadStream(file).pipe(res);
          return;
        }
        // A page of the office editors for this document: its own origin, and a token for this document only.
        if (method === "POST" && parts[2] === "editor") {
          const artifact = documents.check(artifactId);
          const kind = officeEditorKind(artifact.format);
          if (!kind) throw new HttpError(415, "no_editor", "이 형식은 아직 Workbench 안에서 편집하지 못합니다.");
          const origin = options.editors?.origin();
          if (!options.editors || !origin) throw new HttpError(503, "editors_not_ready", "편집기를 준비하는 중입니다. 잠시 뒤 다시 열어 주세요.");
          return sendJson(res, 200, { url: `${origin}/office/${kind}.html`, origin, token: options.editors.grants.issue(artifactId, documentAccess(req)) });
        }
        if (method === "PUT" && parts[2] === "bytes") {
          const data = await readBody(req, 200_000_000);
          return sendJson(res, 200, documents.saveBytes(artifactId, Number(url.searchParams.get("expectedRevision")), data, documentAccess(req)));
        }
        if (method === "POST" && parts[2] === "assets") {
          const data = await readBody(req, 50_000_000);
          const name = decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
          return sendJson(res, 201, documents.saveAsset(artifactId, data, String(req.headers["content-type"] ?? ""), name));
        }
        if (method === "POST" && parts[2] === "exports") {
          const data = await readBody(req, 500_000_000);
          return sendJson(res, 201, manager.exportDesign(artifactId, data, decodeURIComponent(String(req.headers["x-file-name"] ?? ""))));
        }
        if (method === "GET" && parts[2] === "asset") {
          const file = documents.assetPath(artifactId, url.searchParams.get("src") ?? "");
          res.writeHead(200, {
            "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
            "cache-control": "private, max-age=86400",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          });
          createReadStream(file).pipe(res);
          return;
        }
        if (method === "GET" && parts[2] === "office-pages") return sendJson(res, 200, await documents.officePages(artifactId, revision));
        if (method === "GET" && parts[2] === "office-page") {
          const artifact = documents.get(artifactId);
          return sendPng(res, await documents.officePagePath(artifactId, revision ?? artifact.revision, Number(url.searchParams.get("page") ?? 1)));
        }
        if (method === "POST" && parts[2] === "open-external") return sendJson(res, 200, manager.openExternal(artifactId));
        if (method === "POST" && parts[2] === "adopt-disk") return sendJson(res, 200, documents.adoptDisk(artifactId));
        if (method === "POST" && parts[2] === "revert") {
          const body = await readJson(req);
          return sendJson(res, 200, documents.revert(artifactId, Number(body.toRevision), documentAccess(req)));
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
        if (method === "POST" && parts[2] === "apply") return sendJson(res, 200, await documents.applyProposal(parts[1], documentAccess(req)));
        if (method === "GET" && (parts[2] === "office-pages" || parts[2] === "office-page")) {
          const side = url.searchParams.get("side") === "base" ? "base" : "proposed";
          const pages = await documents.proposalPages(parts[1], side);
          if (parts[2] === "office-pages") return sendJson(res, 200, { side, pages: pages.map(({ page, width, height }) => ({ page, width, height })) });
          const found = pages.find((entry) => entry.page === Number(url.searchParams.get("page") ?? 1));
          if (!found) throw new HttpError(404, "page_not_found", "그 쪽이 없습니다.");
          return sendPng(res, found.file);
        }
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
            attachments: parseAttachments(body.attachments),
          }),
        );
      }
      // "다시 보내기": a request another session did not answer, sent again as a new one.
      if (method === "POST" && parts[0] === "handoffs" && parts[1] && parts[2] === "resend") {
        const body = await readJson(req);
        const requestId = String(body.requestId ?? "");
        if (!requestId) throw new HttpError(400, "missing_request_id", "requestId가 필요합니다.");
        return sendJson(res, 202, await manager.resendHandoff(parts[1], requestId));
      }
      // "세션 잇기": start, pause, go on, cut, one more round, and what was exchanged.
      if (parts[0] === "links") {
        const links = manager.links;
        if (method === "POST" && parts.length === 1) return sendJson(res, 201, await links.start(parseStartRequest(await readJson(req))));
        const linkId = parts[1] ?? "";
        if (method === "GET" && parts[2] === "turns") return sendJson(res, 200, links.turns(linkId));
        if (method === "POST" && parts[2] === "pause") return sendJson(res, 200, links.pause(linkId));
        if (method === "POST" && parts[2] === "resume") return sendJson(res, 200, await links.resume(linkId));
        if (method === "POST" && parts[2] === "stop") return sendJson(res, 200, await links.stop(linkId));
        if (method === "POST" && parts[2] === "extend") return sendJson(res, 200, links.extend(linkId));
        if (method === "POST" && parts[2] === "export") {
          const body = await readJson(req);
          const target = body.target === "path" ? "path" : body.target === "text" ? "text" : "work";
          return sendJson(res, 200, links.exportMarkdown(linkId, { target, path: typeof body.path === "string" ? body.path : undefined }));
        }
      }
      if (method === "POST" && parts[0] === "providers" && (parts[1] === "claude" || parts[1] === "codex")) {
        const provider = parts[1] as Provider;
        const action = parts.slice(2).join("/");
        if (action === "login") return sendJson(res, 200, await manager.login(provider));
        if (action === "login/code") {
          const body = await readJson(req);
          return sendJson(res, 200, await manager.loginCode(provider, String(body.code ?? "")));
        }
        if (action === "login/cancel") return sendJson(res, 200, await manager.cancelLogin(provider));
        if (action === "install") return sendJson(res, 202, manager.installEngine(provider));
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
      if (parts[0] === "agent-browser") {
        const browse = options.browse;
        if (!browse) throw new HttpError(404, "no_browser", "에이전트 브라우저가 없는 게이트웨이입니다.");
        const action = parts.slice(1).join("/");
        if (method === "GET" && !action) return sendJson(res, 200, browse.status());
        if (method === "POST" && action === "install") return sendJson(res, 202, browse.install());
        if (method === "POST" && action === "login") {
          const body = await readJson(req);
          return sendJson(res, 200, await browse.openLogin(typeof body.url === "string" ? body.url : null));
        }
        if (method === "POST" && action === "login/close") return sendJson(res, 200, await browse.closeLogin());
        if (method === "POST" && action === "focus") return sendJson(res, 200, await browse.focus());
        if (method === "POST" && action === "pause") {
          const body = await readJson(req);
          return sendJson(res, 200, browse.setPaused(String(body.sessionId ?? ""), body.paused === true));
        }
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

/** Attachments named in a message body, shape-checked (the gateway resolves them to its own files). */
function parseAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .slice(0, 20)
    .map((entry) => ({ id: String(entry.id ?? ""), name: String(entry.name ?? "첨부"), mime: String(entry.mime ?? "application/octet-stream"), size: Number(entry.size ?? 0) }));
}

/** Pictures and PDFs show inline; anything else downloads (never rendered as a page of ours). */
function attachmentType(file: string) {
  const extension = extname(file).toLowerCase();
  const known: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf" };
  return known[extension] ?? "application/octet-stream";
}
