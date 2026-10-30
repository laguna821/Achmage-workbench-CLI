import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Documents } from "./artifacts.ts";
import type { EditorGrants } from "./editors.ts";
import type { EpubSession } from "./epub-ops.mjs";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import { epubBookCsp } from "../../../packages/contracts/src/epub.ts";

type BookView = {
  id: string; artifactId: string; scope: string; baseRevision: number; session: EpubSession;
  writable: boolean; restored: boolean; generation: number; checkpoint?: { id: string; generation: number };
  keptGeneration?: number; queue: Promise<unknown>;
};
const MAX_BOOKS = 32, MAX_OPEN_BYTES = 400_000_000;
const token = () => randomBytes(24).toString("hex");

/** Original host-owned book sessions. HTTP never accepts a disk path or serialized whole DOM. */
export class EpubEditors {
  private books = new Map<string, BookView>();
  private opening: Promise<unknown> = Promise.resolve();
  private reading: Promise<ReturnType<typeof import("./epub-ops.mjs").epubReadingState>> | null = null;
  private documents: Documents;
  private grants: EditorGrants;
  constructor(documents: Documents, grants: EditorGrants) { this.documents = documents; this.grants = grants; }

  private readingState() {
    return this.reading ??= import("./epub-ops.mjs").then((engine) => engine.epubReadingState(join(this.documents.dataDir, "office")));
  }
  private usedBytes(except?: BookView) {
    return [...this.books.values()].reduce((sum, view) => sum + (view === except ? 0 : view.session.bytes.byteLength), 0);
  }
  private hasGrant(view: BookView) { return this.grants.preview(view.scope)?.artifactId === view.artifactId; }
  private dirty(view: BookView) { return view.restored || view.session.isDirty(); }
  private discardable(view: BookView) { return !this.dirty(view) || view.keptGeneration === view.generation; }
  private serial<T>(view: BookView, task: () => Promise<T>) {
    const next = view.queue.then(task, task); view.queue = next.catch(() => {}); return next;
  }
  private async prepared(view: BookView) {
    const prepared = await view.session.prepareSave(), { result } = prepared;
    if (!result.ok) throw new HttpError(422, "epub_save_refused", `전자책 저장을 검증하지 못했습니다: ${result.reason}`);
    const bytes = result.changed ? result.bytes : view.session.bytes;
    const { EPUB_MAX_BYTES } = await import("./epub-ops.mjs");
    if (bytes.byteLength > EPUB_MAX_BYTES || this.usedBytes(view) + bytes.byteLength > MAX_OPEN_BYTES) throw new HttpError(413, "epub_limit", "열린 전자책의 용량 한도를 넘었습니다. 다른 전자책 탭을 저장하고 닫아 주세요.");
    return { bytes, snapshot: prepared.snapshot, changed: result.changed };
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, bearer: string | null): Promise<boolean> {
    const asset = /^\/epub-assets\/([a-f0-9]{48})\/(.*)$/.exec(url.pathname);
    const route = /^\/api\/artifacts\/([^/]+)\/epub\/([a-z-]+)$/.exec(url.pathname);
    if (!asset && !route) return false;
    const engine = await import("./epub-ops.mjs");
    if (asset) {
      const view = this.books.get(asset[1]!);
      if (!view || !this.hasGrant(view)) throw new HttpError(404, "epub_asset_missing", "전자책 자산을 찾지 못했습니다.");
      const response = await engine.epubAsset(view.session, view.id, asset[2]!, req.method ?? "GET");
      const origin = `http://127.0.0.1:${req.socket.localPort}`;
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      res.writeHead(response.status, { ...headers, "content-security-policy": epubBookCsp(`${origin}/epub-assets/${view.id}/`, true), "referrer-policy": "no-referrer" });
      res.end(Buffer.from(await response.arrayBuffer())); return true;
    }
    const [, artifactId, operation] = route!;
    if (!this.grants.allows(bearer, artifactId!)) throw new HttpError(401, "unauthorized", "이 전자책을 열 권한이 없습니다.");
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "허용되지 않은 전자책 요청입니다.");
    const artifact = this.documents.check(artifactId!);
    if (artifact.format !== "epub") throw new HttpError(415, "not_epub", "전자책 문서가 아닙니다.");
    const scope = this.grants.previewInfo(bearer!).baseUrl.split("/")[2]!;
    if (operation === "open") {
      const revision = Number(url.searchParams.get("revision"));
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > artifact.revision) throw new HttpError(400, "revision_not_found", "전자책의 판이 올바르지 않습니다.");
      const restored = url.searchParams.get("restore") === "1";
      const restoreBytes = restored ? await readBody(req, engine.EPUB_MAX_BYTES) : null;
      const run = this.opening.then(async () => {
        if (!this.grants.allows(bearer, artifactId!)) throw new HttpError(401, "unauthorized", "편집기 권한이 만료되었습니다.");
        for (const [id, view] of this.books) if (!this.hasGrant(view) && this.discardable(view)) this.books.delete(id);
        const original = readFileSync(this.documents.revisionPath(artifactId!, revision));
        const bytes = restoreBytes ?? original;
        if (this.books.size >= MAX_BOOKS || this.usedBytes() + bytes.byteLength > MAX_OPEN_BYTES) throw new HttpError(413, "epub_limit", "열린 전자책이 너무 많습니다. 다른 전자책 탭을 저장하고 닫아 주세요.");
        // A recovery copy cannot make a refused source writable.
        if (restored) {
          const source = await engine.openEpubSession(original);
          if (!source.ok || source.session.bookReadOnly()) throw new HttpError(422, "epub_restore_refused", "이 전자책에는 복구본을 적용할 수 없습니다.");
        }
        const opened = await engine.openEpubSession(bytes);
        if (!opened.ok) return sendJson(res, 200, { status: "refused", reason: opened.reason });
        let writable = true;
        try { this.documents.registry.assertWrite(artifactId!, this.grants.access(bearer!)); } catch { writable = false; }
        if (restored && !writable) throw new HttpError(423, "read_only", "편집 권한을 받은 뒤 복구본을 열어 주세요.");
        const id = token(), session = opened.session;
        this.books.set(id, { id, artifactId: artifactId!, scope, baseRevision: revision, session, writable, restored, generation: 0, queue: Promise.resolve() });
        sendJson(res, 200, { status: "ok", sessionId: id, book: session.summary(), docHash: session.docHash, readOnly: session.bookReadOnly(), workbenchReadOnly: !writable, assetBase: `/epub-assets/${id}/`, restored });
      });
      this.opening = run.catch(() => {}); await run; return true;
    }
    const view = this.books.get(url.searchParams.get("session") ?? "");
    if (!view || view.artifactId !== artifactId || view.scope !== scope) throw new HttpError(404, "epub_not_open", "열린 전자책 세션을 찾지 못했습니다.");
    const raw = await readBody(req, 8_000_000);
    let args: Record<string, unknown>;
    try { args = raw.length ? JSON.parse(raw.toString("utf8")) : {}; if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(); }
    catch { throw new HttpError(400, "invalid_request", "전자책 요청이 올바르지 않습니다."); }
    await this.serial(view, async () => {
      if (!this.grants.allows(bearer, artifactId!)) throw new HttpError(401, "unauthorized", "편집기 권한이 만료되었습니다.");
      if (!this.books.has(view.id)) throw new HttpError(404, "epub_not_open", "이미 닫은 전자책입니다.");
      const session = view.session;
      switch (operation) {
        case "chapter": return sendJson(res, 200, await session.readChapter(args.spineIndex));
        case "apply": case "replace": {
          if (!view.writable) throw new HttpError(423, "read_only", "읽기 전용으로 연 전자책입니다.");
          // These are in-memory edits, including pending input captured after a lost lease.
          // Only final disk writes require the current writer; recovery must remain possible.
          const result = operation === "apply" ? await session.applyEdits(args.spineIndex, args.edits) : await session.replaceRanges(args.spineIndex, args.version, args.replacements);
          if (result.ok) { view.generation++; result.dirty = this.dirty(view); result.workbenchGeneration = view.generation; }
          return sendJson(res, 200, result);
        }
        case "lock": {
          if (typeof args.locked !== "boolean") throw new HttpError(400, "invalid_request", "잠금 값이 올바르지 않습니다.");
          session.setLocked(args.locked); return sendJson(res, 200, session.locked);
        }
        case "checkpoint": {
          const { bytes } = await this.prepared(view);
          view.checkpoint = { id: token(), generation: view.generation };
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-epub-checkpoint": view.checkpoint.id, "x-epub-revision": String(view.baseRevision) });
          res.end(bytes); return;
        }
        case "checkpoint-confirm": {
          if (view.checkpoint && view.checkpoint.id === args.checkpoint && view.checkpoint.generation === view.generation) view.keptGeneration = view.generation;
          return sendJson(res, 200, { ok: true });
        }
        case "save": {
          if (session.locked) throw new HttpError(423, "epub_locked", "전자책 작업이 진행 중입니다.");
          if (!view.writable || session.bookReadOnly()) throw new HttpError(423, "read_only", "읽기 전용 전자책에는 저장할 수 없습니다.");
          this.documents.registry.assertWrite(artifactId!, this.grants.access(bearer!));
          const revision = args.expectedRevision;
          if (!Number.isSafeInteger(revision) || (revision !== view.baseRevision && args.rebase !== true)) throw new HttpError(409, "revision_conflict", "편집을 시작한 판과 다릅니다. 새 판을 확인해 주세요.");
          const { bytes, snapshot, changed } = await this.prepared(view);
          if (!this.grants.allows(bearer, artifactId!)) throw new HttpError(401, "unauthorized", "편집기 권한이 만료되었습니다.");
          const saved = this.documents.saveEpubBytes(artifactId!, revision as number, Buffer.from(bytes), this.grants.access(bearer!));
          const written = saved.revision !== view.baseRevision;
          if (changed) await session.rebase(bytes, snapshot);
          view.baseRevision = saved.revision; view.restored = false; view.generation++;
          return sendJson(res, 200, { ok: true, path: artifact.path, written, revision: saved.revision, docHash: session.docHash, workbenchGeneration: view.generation });
        }
        case "hash": return sendJson(res, 200, { ok: true, docHash: session.docHash });
        case "reading": return sendJson(res, 200, await (await this.readingState()).get(artifact.path));
        case "position": {
          const position = engine.readPositionOf(args.position);
          if (!position) throw new HttpError(400, "invalid_request", "읽기 위치가 올바르지 않습니다.");
          await (await this.readingState()).setPosition(artifact.path, position); return sendJson(res, 200, { ok: true });
        }
        case "prefs": return sendJson(res, 200, await (await this.readingState()).setViewPrefs(args.patch));
        case "close": {
          if (!this.discardable(view)) throw new HttpError(409, "epub_unsaved", "미저장 전자책을 보관한 뒤 닫아 주세요.");
          this.books.delete(view.id); return sendJson(res, 200, { ok: true });
        }
        default: throw new HttpError(400, "epub_operation", "지원하지 않는 전자책 요청입니다.");
      }
    });
    return true;
  }
}
