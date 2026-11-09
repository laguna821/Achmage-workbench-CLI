import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Documents } from "./artifacts.ts";
import type { EditorGrants } from "./editors.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import { officeGenerated } from "./office-generated.ts";
import { pdfImageOutputs } from "./pdf-image-output.mjs";

const METHODS: Record<string, string> = Object.fromEntries([
  "tree", "text", "convert", "convertOffice", "extractImages", "writeBack", "cancel", "storeDocHash", "storeAiReadPages", "storeTranslations", "storeTranslation", "storeUnfinishedJobs", "storeWrite", "storeMigrate", "storeDeleteDocument", "storePassages", "storeHighlightRuns", "storeHighlightBlocks", "storeLatestHighlight", "storeInsights", "storeDeleteCounts", "storePageFingerprints", "storeTranslationRecency",
].map(name => [name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`), name]));
type View = { owner: number; key: string; viewId: string; artifactId: string; paths: Set<string>; generated: Set<string> };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const wire = (_key: string, value: unknown) => value instanceof Uint8Array ? { workbenchBytes: Buffer.from(value).toString("base64") } : value;

/** Document grants adapt the original handlers, whose path/hash validation remains intact. */
export class PdfStructureEditors {
  private nextOwner = 0;
  private readonly views = new Map<string, View>();
  private engine: Promise<ReturnType<typeof import("./pdf-structure.mjs").pdfStructure>> | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly documents: Documents;
  private readonly grants: EditorGrants;
  constructor(documents: Documents, grants: EditorGrants) {
    this.documents = documents; this.grants = grants;
    this.timer = setInterval(() => {
      for (const view of this.views.values()) if (!documents.registry.authority(view.viewId)) this.forget(view);
    }, 1000); this.timer.unref();
  }
  private load() {
    return this.engine ??= import("./pdf-structure.mjs").then(({ pdfStructure }) => pdfStructure(join(this.documents.dataDir, "office"),
      (owner, path) => [...this.views.values()].some(view => view.owner === owner && view.paths.has(path))));
  }
  private forget(view: View) {
    this.views.delete(view.key);
    void this.engine?.then(engine => engine.handlers.forgetOwner!(view.owner));
    for (const id of view.generated) officeGenerated(this.documents).discard(id);
  }
  close() { clearInterval(this.timer); for (const view of this.views.values()) this.forget(view); void this.engine?.then(engine => engine.close()); }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, bearer: string | null) {
    const route = /^\/api\/artifacts\/([^/]+)\/pdf-structure\/([a-z-]+)$/.exec(url.pathname);
    if (!route) return false;
    const [, artifactId, operation] = route;
    if (!this.grants.allows(bearer, artifactId!)) throw new HttpError(401, "unauthorized", "이 PDF를 열 권한이 없습니다.");
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "허용되지 않은 PDF 요청입니다.");
    const artifact = this.documents.get(artifactId!), access = this.grants.access(bearer!);
    if (artifact.format !== "pdf") throw new HttpError(415, "not_pdf", "PDF 문서가 아닙니다.");
    if (!access || this.documents.registry.authority(access.viewId)?.artifactId !== artifactId) throw new HttpError(409, "pdf_view_closed", "PDF 문서 탭이 닫혔습니다.");
    const instance = url.searchParams.get("instance") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(instance)) throw new HttpError(400, "pdf_instance", "PDF 화면의 식별자가 없습니다.");
    const key = `${this.grants.previewInfo(bearer!).baseUrl}/${instance}`;
    if (operation === "close") { const old = this.views.get(key); if (old) this.forget(old); sendJson(res, 200, { ok: true }); return true; }
    const method = METHODS[operation!];
    if (!method) throw new HttpError(400, "pdf_structure_operation", "연결되지 않은 PDF 작업입니다.");
    const revision = Number(url.searchParams.get("revision"));
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > artifact.revision) throw new HttpError(400, "revision_not_found", "PDF 문서 판이 올바르지 않습니다.");
    let args: unknown;
    try { args = JSON.parse((await readBody(req, 16_000_000)).toString("utf8")); } catch { throw new HttpError(400, "pdf_request", "PDF 요청을 읽지 못했습니다."); }
    if (!Array.isArray(args) || args.length > 3) throw new HttpError(400, "pdf_request", "PDF 요청이 올바르지 않습니다.");
    let view = this.views.get(key);
    if (!view) {
      if (this.views.size >= 64) throw new HttpError(429, "pdf_view_limit", "다른 PDF 탭을 닫은 뒤 다시 시도해 주세요.");
      this.views.set(key, view = { owner: ++this.nextOwner, key, viewId: access.viewId, artifactId: artifactId!, paths: new Set(), generated: new Set() });
    }
    const source = this.documents.revisionPath(artifactId!, revision);
    const pathArgument = method === "storeDocHash", requestArgument = ["tree", "text", "convert", "convertOffice", "extractImages", "writeBack", "storeMigrate", "storePageFingerprints"].includes(method);
    if (pathArgument || requestArgument) {
      if ((pathArgument ? args[0] : isRecord(args[0]) ? args[0].path : null) !== artifact.path) throw new HttpError(403, "pdf_path", "열린 PDF만 처리할 수 있습니다.");
      view.paths.add(source);
      args[0] = pathArgument ? source : { ...args[0] as Record<string, unknown>, path: source };
    }
    const engine = await this.load();
    if (!this.views.has(key)) throw new HttpError(409, "pdf_view_closed", "PDF 문서 탭이 닫혔습니다.");
    const send = (value: unknown) => { if (!res.destroyed) res.write(`${JSON.stringify(value, wire)}\n`); };
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const context = { owner: view.owner, progress: (progress: unknown) => send({ progress }) };
    let staged: ReturnType<ReturnType<typeof officeGenerated>["create"]> | null = null;
    try {
      if (method === "convert" || method === "convertOffice" || method === "writeBack") {
        const request = args[0] as Record<string, unknown>;
        const format = method === "writeBack" ? "pdf" : request.format;
        if (format !== "md" && format !== "epub" && format !== "pdf" && format !== "docx" && format !== "pptx" && format !== "xlsx") throw new Error("변환 형식이 올바르지 않습니다.");
        staged = officeGenerated(this.documents).create(artifactId!, revision, view.viewId, format);
        view.generated.add(staged.id);
        const target = method === "convertOffice" ? staged.path : await engine.pickTarget(view.owner, source, staged.path, format);
        if (!target) throw new Error("결과 저장 위치를 준비하지 못했습니다.");
        args[0] = { ...request, outPath: target };
      }
      const value = method === "extractImages" ? await pdfImageOutputs(this.documents).run(artifactId!, String((args[0] as Record<string, unknown>).outDir), access, revision, async path => {
        const target = await engine.pickTarget(view.owner, source, path, "folder");
        if (!target) throw new Error("그림 저장 위치를 준비하지 못했습니다.");
        return engine.handlers.extractImages!(context, { ...args[0] as Record<string, unknown>, outDir: target });
      }) : await engine.handlers[method]!(requestArgument ? context : view.owner, ...args);
      if (staged) {
        if (!value.ok) { officeGenerated(this.documents).discard(staged.id); view.generated.delete(staged.id); }
        else { delete value.outPath; value.generatedId = staged.id; }
      }
      send({ result: value });
    } catch (error) { if (staged) { officeGenerated(this.documents).discard(staged.id); view.generated.delete(staged.id); } send({ result: { ok: false, error: "failed", message: error instanceof Error ? error.message : String(error) } }); }
    res.end(); return true;
  }
}
