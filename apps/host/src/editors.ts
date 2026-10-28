import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname } from "node:path";
import type { DocFormat, OfficeEditorKind } from "@workbench/contracts";
import type { Documents } from "./artifacts.ts";
import { HttpError } from "./errors.ts";
import { fontFace, matchFont } from "./fonts.ts";
import { MIME, readBody, sendJson, serveStatic } from "./http.ts";

// The office editors (IeumOffice's editor screens, apps/office) run on their own origin, a second
// port on 127.0.0.1. Their code is third-party and reads documents from anywhere, so it never
// shares a window, storage or the gateway token with the Workbench UI: each page gets a grant that
// reads and saves the one document it shows, and nothing else is served there.

/** Which editor page edits a format, if any. */
export function officeEditorKind(format: DocFormat): OfficeEditorKind | null {
  return format === "docx" ? "docs" : format === "pptx" ? "slides" : format === "xlsx" ? "sheets" : null;
}

/** Tokens that open one document each, for as long as the gateway runs (the most recent ones). */
export class EditorGrants {
  private readonly grants = new Map<string, string>();
  private readonly limit: number;
  constructor(limit = 500) {
    this.limit = limit;
  }

  issue(artifactId: string) {
    const token = randomBytes(24).toString("base64url");
    this.grants.set(token, artifactId);
    while (this.grants.size > this.limit) this.grants.delete(this.grants.keys().next().value!);
    return token;
  }

  allows(token: string | null, artifactId: string) {
    return Boolean(token && this.grants.get(token) === artifactId);
  }

  /** Any open page (for what is not a document: the system's fonts). */
  allowsAny(token: string | null) {
    return Boolean(token && this.grants.has(token));
  }
}

/** Pages may be framed by the Workbench window (any local origin: the app, or the dev server). */
const PAGE_HEADERS = {
  "content-security-policy": "frame-ancestors http://127.0.0.1:* http://localhost:*",
  "x-content-type-options": "nosniff",
};

export function createEditorsServer(documents: Documents, grants: EditorGrants, webDir: string | null): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (/^\/office\//.test(path) && method === "GET") {
        if (!webDir) throw new HttpError(404, "no_web", "편집기 화면이 빌드되지 않았습니다.");
        return serveStatic(res, webDir, path, PAGE_HEADERS);
      }
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      // System fonts the slides editor measures and draws text with.
      if (path.startsWith("/api/fonts/") && method === "GET") {
        if (!grants.allowsAny(bearer)) throw new HttpError(401, "unauthorized", "편집기 권한이 없습니다.");
        if (path === "/api/fonts/match") {
          const family = url.searchParams.get("family") ?? "";
          if (!family || family.length > 200) throw new HttpError(400, "bad_family", "글꼴 이름이 없습니다.");
          return sendJson(res, 200, matchFont(family, url.searchParams.get("bold") === "1", url.searchParams.get("italic") === "1", url.searchParams.get("lang") ?? undefined));
        }
        const face = /^\/api\/fonts\/face\/([a-f0-9]{20})$/.exec(path);
        const bytes = face ? fontFace(face[1]!) : null;
        if (!bytes) throw new HttpError(404, "no_font", "글꼴을 찾지 못했습니다.");
        res.writeHead(200, { "content-type": "font/ttf", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
        res.end(bytes);
        return;
      }
      const match = /^\/api\/artifacts\/([^/]+)\/(raw|bytes)$/.exec(path);
      if (!match) throw new HttpError(404, "not_found", "없는 주소입니다.");
      const [, artifactId, action] = match as unknown as [string, string, "raw" | "bytes"];
      if (!grants.allows(bearer, artifactId)) throw new HttpError(401, "unauthorized", "이 문서를 열 권한이 없습니다.");
      if (method === "GET" && action === "raw") {
        const artifact = documents.check(artifactId);
        const revision = url.searchParams.get("revision") ? Number(url.searchParams.get("revision")) : artifact.revision;
        const file = documents.revisionPath(artifactId, revision);
        res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
        createReadStream(file).pipe(res);
        return;
      }
      if (method === "PUT" && action === "bytes") {
        const data = await readBody(req, 200_000_000);
        return sendJson(res, 200, documents.saveBytes(artifactId, Number(url.searchParams.get("expectedRevision")), data));
      }
      throw new HttpError(405, "method_not_allowed", "허용되지 않은 요청입니다.");
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, { code: error.code, message: error.message });
      else sendJson(res, 500, { code: "internal", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
