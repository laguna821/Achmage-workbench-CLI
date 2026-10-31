import { EpubEditors } from "./epub-editor.ts";
import { randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname } from "node:path";
import type { DocFormat, DocumentAccess, OfficeEditorKind } from "@workbench/contracts";
import type { Documents } from "./artifacts.ts";
import { HttpError } from "./errors.ts";
import { fontFace, matchFont } from "./fonts.ts";
import { MIME, readBody, sendJson, serveStatic } from "./http.ts";
import { decodeHwpSave, hwpFormat, hwpTabs, HWP_MAX_BYTES, openHwpBytes, prepareHwpSave } from "./hwp-codec.ts";
import { OFFICE_IMAGE_MAX_BYTES, readOfficeAsset, saveOfficeImage } from "./office-assets.ts";
import { buildPreviewDocument } from "../../../third_party/ieumoffice/text-assets/preview-document.ts";
import { PDF_MAX_BYTES, PDF_REQUEST_MAX_BYTES } from "../../../packages/contracts/src/pdf.ts";
import { decodePdfRequest } from "./pdf-codec.ts";
import { OfficeAi } from "./office-ai.ts";
import { OfficeReferences } from "./office-references.ts";
import { OfficeStyles } from "./office-styles.ts";

// The office editors (IeumOffice's editor screens, apps/office) run on their own origin, a second
// port on 127.0.0.1. Their code is third-party and reads documents from anywhere, so it never
// shares a window, storage or the gateway token with the Workbench UI: each page gets a grant that
// reads and saves the one document it shows. The common AI service also uses that document/view
// scope; this origin cannot write global settings, reveal saved keys or request filesystem tools.

/** Which editor page edits a format, if any. */
export function officeEditorKind(format: DocFormat): OfficeEditorKind | null {
  if (format === "epub") return "epub";
  if (format === "xmind") return "mindmap";
  return format === "docx" ? "docs" : format === "pptx" ? "slides" : format === "xlsx" ? "sheets" : format === "hwp" || format === "hwpx" ? "hwp" : format === "markdown" || format === "html" || format === "pdf" ? format : null;
}

/** Tokens that open one document each, for as long as the gateway runs (the most recent ones). */
export class EditorGrants {
  readonly references = new OfficeReferences();
  private readonly grants = new Map<string, { artifactId: string; access?: DocumentAccess; sessionId: string | null; preview: { id?: string; text?: string } }>();
  private readonly limit: number;
  constructor(limit = 500) {
    this.limit = limit;
  }

  issue(artifactId: string, access?: DocumentAccess, sessionId: string | null = null) {
    const token = randomBytes(24).toString("base64url");
    // Refreshing a view's writer lease must preserve the live preview URL already in its DOM.
    const prior = access ? [...this.grants.values()].find((grant) => grant.artifactId === artifactId && grant.access?.viewId === access.viewId) : undefined;
    this.grants.set(token, { artifactId, ...(access ? { access: { ...access } } : {}), sessionId, preview: prior?.preview ?? {} });
    while (this.grants.size > this.limit) this.grants.delete(this.grants.keys().next().value!);
    return token;
  }

  allows(token: string | null, artifactId: string) {
    return Boolean(token && this.grants.get(token)?.artifactId === artifactId);
  }

  access(token: string) { return this.grants.get(token)?.access; }
  session(token: string) { return this.grants.get(token)?.sessionId ?? null; }

  previewInfo(token: string) {
    const grant = this.grants.get(token);
    if (!grant) throw new HttpError(401, "unauthorized", "편집기 권한이 없습니다.");
    grant.preview.id ??= randomBytes(24).toString("base64url");
    return { url: `/preview/${grant.preview.id}/document.html`, baseUrl: `/preview/${grant.preview.id}/` };
  }

  updatePreview(token: string, text: string) {
    const grant = this.grants.get(token);
    if (!grant) throw new HttpError(401, "unauthorized", "편집기 권한이 없습니다.");
    const previews = new Set([...this.grants.values()].map((entry) => entry.preview));
    const total = [...previews].reduce((sum, entry) => sum + (entry === grant.preview ? 0 : (entry.text?.length ?? 0)), text.length);
    if (total > 16_000_000) throw new HttpError(413, "preview_limit", "열린 HTML 미리보기의 용량 한도를 넘었습니다.");
    grant.preview.text = text;
  }

  preview(id: string) {
    return [...this.grants.values()].find((grant) => grant.preview.id === id);
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

export function createEditorsServer(documents: Documents, grants: EditorGrants, webDir: string | null, ai = new OfficeAi(documents.dataDir)): Server {
  const epub = new EpubEditors(documents, grants);
  const styles = new OfficeStyles(documents, webDir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (/^\/office\//.test(path) && method === "GET") {
        if (decodeURIComponent(path).toLowerCase() === "/office/settings.html") throw new HttpError(404, "not_here", "설정은 전용 화면에서 열립니다.");
        if (!webDir) throw new HttpError(404, "no_web", "편집기 화면이 빌드되지 않았습니다.");
        return serveStatic(res, webDir, path, PAGE_HEADERS);
      }
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      if (await styles.handle(req, res, url, bearer, grants)) return;
      if (await ai.handle(req, res, url, bearer, documents, grants)) return;
      if (await epub.handle(req, res, url, bearer)) return;
      // Document scripts receive only this read-only preview URL, never the editor grant.
      // Enforce an opaque origin at the response as well as the renderer's iframe sandbox.
      const preview = /^\/preview\/([A-Za-z0-9_-]{32})\/(.+)$/.exec(path);
      if (preview && method === "GET") {
        const grant = grants.preview(preview[1]!);
        if (!grant) throw new HttpError(404, "preview_missing", "미리보기가 아직 준비되지 않았습니다.");
        const artifact = documents.get(grant.artifactId);
        const headers = { "cache-control": "no-store", "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self' http://127.0.0.1:* http://localhost:*", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
        if (preview[2] === "document.html" && artifact.format === "html") {
          if (grant.preview.text === undefined) throw new HttpError(404, "preview_missing", "미리보기가 아직 준비되지 않았습니다.");
          res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
          res.end(buildPreviewDocument(grant.preview.text, `/preview/${preview[1]}/`)); return;
        }
        let source: string;
        try { source = decodeURIComponent(preview[2] === "__image" ? url.searchParams.get("src") ?? "" : preview[2]!); }
        catch { if (preview[2] === "__image") source = url.searchParams.get("src") ?? ""; else throw new HttpError(400, "asset_path", "문서 자산 경로를 읽지 못했습니다."); }
        const asset = await readOfficeAsset(artifact.path, source, artifact.format === "markdown" || preview[2] === "__image", req.headers.accept ?? null);
        // Fonts need CORS in the opaque preview. Text assets stay unreadable to page fetch().
        res.writeHead(200, { ...headers, "content-type": asset.type, "content-length": asset.data.length, ...(asset.type.startsWith("font/") ? { "access-control-allow-origin": "*" } : {}) });
        res.end(asset.data); return;
      }
      const textEditor = /^\/api\/artifacts\/([^/]+)\/(text|html-preview|assets|image)$/.exec(path);
      if (textEditor) {
        const [, id, operation] = textEditor;
        if (!grants.allows(bearer, id!)) throw new HttpError(401, "unauthorized", "이 문서를 열 권한이 없습니다.");
        const artifact = documents.check(id!);
        if (artifact.format !== "markdown" && artifact.format !== "html") throw new HttpError(415, "not_text_editor", "Markdown·HTML 편집기 요청이 아닙니다.");
        if (operation === "assets" && method === "GET") return sendJson(res, 200, grants.previewInfo(bearer!));
        if (operation === "image") {
          if (method === "GET") {
            let source: string;
            try { source = decodeURIComponent(url.searchParams.get("src") ?? ""); }
            catch { source = url.searchParams.get("src") ?? ""; }
            const asset = await readOfficeAsset(artifact.path, source, true, "image/*");
            if (!["image/png", "image/jpeg", "image/gif"].includes(asset.type)) throw new HttpError(415, "image_type", "이 그림 형식은 문서 변환에 사용할 수 없습니다.");
            return sendJson(res, 200, { base64: asset.data.toString("base64"), mime: asset.type });
          }
          if (method === "POST") {
            documents.registry.assertWrite(id!, grants.access(bearer!));
            const bytes = await readBody(req, OFFICE_IMAGE_MAX_BYTES);
            // Recheck after receiving the body: an expired writer or changed document cannot add assets.
            documents.registry.assertWrite(id!, grants.access(bearer!));
            const latest = documents.check(id!);
            if (latest.revision !== Number(url.searchParams.get("expectedRevision"))) throw new HttpError(409, "revision_conflict", "문서가 바뀌었습니다. 최신 판에서 그림을 넣어 주세요.");
            if (latest.diskState !== "same") throw new HttpError(409, "disk_conflict", "파일이 외부에서 바뀌었습니다. 원문을 확인한 뒤 그림을 넣어 주세요.");
            return sendJson(res, 200, { path: await saveOfficeImage(latest.path, bytes, url.searchParams.get("name")) });
          }
        }
        if (operation === "text" && method === "PUT") {
          const bytes = await readBody(req, 16_000_000);
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
          catch { throw new HttpError(422, "invalid_utf8", "UTF-8 원문이 아니어서 저장하지 않았습니다."); }
          return sendJson(res, 200, await documents.saveText(id!, Number(url.searchParams.get("expectedRevision")), text, grants.access(bearer!)));
        }
        if (operation === "html-preview" && artifact.format === "html") {
          if (method === "GET") return sendJson(res, 200, grants.previewInfo(bearer!));
          if (method === "PUT") {
            grants.updatePreview(bearer!, (await readBody(req, 8_000_000)).toString("utf8"));
            return sendJson(res, 200, { ok: true });
          }
        }
        throw new HttpError(405, "method_not_allowed", "허용되지 않은 편집기 요청입니다.");
      }
      const mindmap = /^\/api\/artifacts\/([^/]+)\/mindmap\/(open|check|save)$/.exec(path);
      if (mindmap) {
        const [, id, operation] = mindmap;
        if (!grants.allows(bearer, id!)) throw new HttpError(401, "unauthorized", "이 문서를 열 권한이 없습니다.");
        const artifact = documents.check(id!);
        if (artifact.format !== "xmind") throw new HttpError(415, "not_mindmap", "마인드맵 문서가 아닙니다.");
        if (method !== (operation === "open" ? "GET" : "POST")) throw new HttpError(405, "method_not_allowed", "허용되지 않은 요청입니다.");
        const revision = Number(url.searchParams.get("revision"));
        if (!Number.isSafeInteger(revision) || revision < 1 || revision > artifact.revision) throw new HttpError(400, "revision_not_found", "마인드맵 문서 판이 올바르지 않습니다.");
        if (operation === "save") {
          documents.registry.assertWrite(id!, grants.access(bearer!));
          if (revision !== artifact.revision) throw new HttpError(409, "revision_conflict", "마인드맵의 판이 바뀌었습니다. 작성 중인 내용을 보관한 뒤 새 판을 확인해 주세요.");
          if (artifact.diskState === "changed") throw new HttpError(409, "disk_changed", "마인드맵 파일이 외부에서 바뀌었습니다.");
        }
        const engine = await import("./mindmap-ops.mjs");
        const original = readFileSync(documents.revisionPath(id!, revision));
        const status = await engine.inspectMindmap(original);
        if (operation === "open") {
          if (status !== "ok") return sendJson(res, 200, { status });
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" }); res.end(original); return;
        }
        if (status !== "ok") throw new HttpError(422, "mindmap_not_open", "열지 못한 마인드맵에는 저장할 수 없습니다.");
        const bytes = await readBody(req, engine.MINDMAP_MAX_BYTES);
        const submitted = await engine.inspectMindmap(bytes);
        if (operation === "check") return sendJson(res, 200, { status: submitted });
        if (submitted !== "ok") throw new HttpError(422, "invalid_mindmap", `저장할 마인드맵을 검증하지 못했습니다: ${submitted}`);
        return sendJson(res, 200, documents.saveMindmapBytes(id!, revision, bytes, grants.access(bearer!)));
      }
      const pdf = /^\/api\/artifacts\/([^/]+)\/pdf\/([a-z-]+)$/.exec(path);
      if (pdf) {
        const [, id, operation] = pdf;
        if (!grants.allows(bearer, id!)) throw new HttpError(401, "unauthorized", "이 문서를 열 권한이 없습니다.");
        const artifact = documents.check(id!);
        if (artifact.format !== "pdf") throw new HttpError(415, "not_pdf", "PDF 문서가 아닙니다.");
        if (method !== "POST") throw new HttpError(405, "method_not_allowed", "허용되지 않은 PDF 요청입니다.");
        const revision = Number(url.searchParams.get("revision"));
        if (!Number.isSafeInteger(revision) || revision < 1 || revision > artifact.revision) throw new HttpError(400, "revision_not_found", "PDF 문서 판이 올바르지 않습니다.");
        const writing = ["save", "blank-page", "page-size", "crop"].includes(operation!);
        if (writing) {
          documents.registry.assertWrite(id!, grants.access(bearer!));
          if (revision !== artifact.revision) throw new HttpError(409, "revision_conflict", "PDF 문서의 판이 바뀌었습니다. 편집을 보관한 뒤 새 판을 확인해 주세요.");
          if (artifact.diskState === "changed") throw new HttpError(409, "disk_changed", "PDF 파일이 외부에서 바뀌었습니다. 편집을 보관한 뒤 원문을 확인해 주세요.");
        }
        const { request, source } = decodePdfRequest(await readBody(req, PDF_MAX_BYTES + PDF_REQUEST_MAX_BYTES + 4));
        if (request.path !== undefined && request.path !== artifact.path) throw new HttpError(403, "pdf_path", "열린 PDF만 처리할 수 있습니다.");
        const engine = await import("./pdf-ops.mjs");
        if (operation === "fonts") return sendJson(res, 200, engine.listEditFonts());
        if (operation === "can-draw") {
          if (typeof request.text !== "string" || request.text.length > 100000 || (request.font !== undefined && (typeof request.font !== "string" || request.font.length > 200))) throw new HttpError(422, "invalid_pdf_request", "글꼴 확인 요청이 올바르지 않습니다.");
          return sendJson(res, 200, engine.canDrawText(request.text, request.font as string | undefined, request.bold === true, request.italic === true));
        }
        // A restored draft is already a complete PDF. Never apply its old edits to a newly
        // adopted revision: the caller sends these bytes until a successful save/reload.
        const original = readFileSync(documents.revisionPath(id!, revision));
        if (source || writing || operation === "recover") await engine.inspectPdf(original);
        const bytes = source ?? original;
        if (operation === "copy" || operation === "redact-copy") {
          if (operation === "redact-copy" && source) throw new HttpError(422, "pdf_redaction_unsaved", "복원한 편집을 먼저 저장한 뒤 영구 가림 사본을 만들어 주세요.");
          const { bytes: copied, ...skips } = await engine.copyPdf(bytes, request, operation === "redact-copy");
          if (Object.values(skips).some((items) => items.length)) throw new HttpError(422, "pdf_copy_incomplete", "일부 편집을 사본에 담지 못했습니다. 원본 탭에서 편집 내용을 확인해 주세요.");
          res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" }); res.end(copied); return;
        }
        if (operation === "save" || operation === "recover") {
          const { bytes: edited, ...skips } = await engine.editPdf(bytes, request);
          if (operation === "recover") {
            if (Object.values(skips).some((items) => items.length)) throw new HttpError(422, "pdf_recovery_incomplete", "일부 편집을 복구본에 담지 못했습니다. 이 탭을 열어 둔 채 저장 결과를 확인해 주세요.");
            res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" }); res.end(edited); return;
          }
          const saved = documents.savePdfBytes(id!, revision, edited, grants.access(bearer!));
          return sendJson(res, 200, { revision: saved.revision, ...skips });
        }
        if (writing) {
          const edited = await engine.transformPdf(bytes, operation!, request);
          await engine.inspectPdf(edited);
          const saved = documents.savePdfBytes(id!, revision, edited, grants.access(bearer!));
          return sendJson(res, 200, { revision: saved.revision });
        }
        return sendJson(res, 200, await engine.queryPdf(bytes, operation!, request));
      }
      const hwp = /^\/api\/artifacts\/([^/]+)\/hwp\/(open|tabs|save|repair)$/.exec(path);
      if (hwp) {
        const [, id, operation] = hwp;
        if (!grants.allows(bearer, id!)) throw new HttpError(401, "unauthorized", "이 문서를 열 권한이 없습니다.");
        const artifact = documents.check(id!), format = hwpFormat(artifact.format);
        const revision = Number(url.searchParams.get("revision"));
        if (!Number.isSafeInteger(revision) || revision < 1 || revision > artifact.revision) throw new HttpError(400, "revision_not_found", "한글 문서 판이 올바르지 않습니다.");
        if (operation === "open" && method === "GET") {
          const opened = await openHwpBytes(readFileSync(documents.revisionPath(id!, revision)), format);
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-workbench-tracking-dropped": String(opened.trackingDropped), "x-workbench-save-blocked": String(opened.saveBlocked) });
          res.end(opened.bytes); return;
        }
        if (operation === "tabs" && method === "POST") return sendJson(res, 200, await hwpTabs(await readBody(req, HWP_MAX_BYTES), hwpFormat(url.searchParams.get("format") ?? format)));
        if ((operation === "save" || operation === "repair") && method === "POST") {
          if (operation === "save") documents.registry.assertWrite(id!, grants.access(bearer!));
          const { bytes, metadata } = decodeHwpSave(await readBody(req, HWP_MAX_BYTES + 1_000_004));
          const original = readFileSync(documents.revisionPath(id!, revision));
          const fixed = await prepareHwpSave(original, bytes, format, metadata, operation === "repair" ? "recovery" : "save");
          if (operation === "repair") {
            // Repair returns a draft to this document's frame, without writing any file.
            // A view whose writer lease expired must still be able to keep its unsaved edits.
            res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" }); res.end(fixed); return;
          }
          return sendJson(res, 200, documents.saveHwpBytes(id!, revision, fixed, grants.access(bearer!)));
        }
        throw new HttpError(405, "method_not_allowed", "허용되지 않은 한글 요청입니다.");
      }
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
        return sendJson(res, 200, documents.saveBytes(artifactId, Number(url.searchParams.get("expectedRevision")), data, grants.access(bearer!)));
      }
      throw new HttpError(405, "method_not_allowed", "허용되지 않은 요청입니다.");
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) sendJson(res, error.status, { code: error.code, message: error.message });
      else sendJson(res, 500, { code: "internal", message: error instanceof Error ? error.message : String(error) });
    }
  });
  server.once("close", () => ai.close());
  return server;
}
