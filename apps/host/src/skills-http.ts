import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TemplatePreview, WorkbenchSkillState } from "@workbench/contracts";
import { SkillImportError } from "../../../third_party/ieumoffice/user-skills/errors.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import type { SessionManager } from "./sessions.ts";

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, 1_000_000);
  try { const parsed = JSON.parse(bytes.toString("utf8") || "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch {}
  throw new HttpError(400, "invalid_json", "요청 형식을 확인해 주세요.");
}
function string(value: unknown) { return typeof value === "string" ? value : ""; }
type Page = { file?: string; svg?: string; page: number; width: number; height: number };

export function skillRoutes(manager: SessionManager) {
  const pages = new Map<string, { items: Page[]; expires: number }>();
  const rendering = new Map<string, Promise<Page[]>>();
  async function preview(id: string, scope: ReturnType<SessionManager["skillScope"]>): Promise<TemplatePreview> {
    const snap = await manager.userSkills.templateSnapshot(id, scope, false);
    const result: TemplatePreview = { template: { skillId: id, title: snap.skill.title, sha256: snap.sha256, skillSha256: snap.skillSha256 }, name: snap.skill.template!.name, format: snap.format, size: snap.size, text: null, pages: [], problem: null };
    if (["markdown", "html", "text", "design"].includes(snap.format)) {
      result.text = (await readFile(snap.path, "utf8")).slice(0, 500_000);
      if (snap.size > 500_000) result.problem = "미리보기에는 앞부분만 표시합니다. 새 사본에는 전체 원본이 들어갑니다.";
      return result;
    }
    const key = `${snap.sha256}-${snap.format}`;
    for (const [token, item] of pages) if (item.expires < Date.now()) pages.delete(token);
    if (!pages.has(key)) {
      let task = rendering.get(key);
      if (!task) {
        task = (async (): Promise<Page[]> => {
          if (snap.format === "hwp" || snap.format === "hwpx") {
            if (!manager.documents.kordoc?.available) throw new Error("한글 미리보기에 필요한 kordoc을 찾지 못했습니다.");
            return manager.documents.kordoc.render(snap.path);
          }
          if (["docx", "pptx", "xlsx"].includes(snap.format)) {
            if (!manager.documents.ieum?.available) throw new Error("문서 미리보기에 필요한 이음오피스를 찾지 못했습니다.");
            return manager.documents.ieum.render(snap.path, join(dirname(snap.path), "previews", key));
          }
          throw new Error("이 형식의 양식 미리보기는 문서 편집기에서 확인해 주세요.");
        })();
        rendering.set(key, task);
      }
      try {
        const items = await task;
        if (pages.size >= 64) pages.delete(pages.keys().next().value!);
        pages.set(key, { items, expires: Date.now() + 30 * 60_000 });
      } catch (error) { result.problem = error instanceof Error ? error.message : String(error); }
      finally { rendering.delete(key); }
    }
    result.pages = (pages.get(key)?.items ?? []).map((page, index) => ({ page: page.page, width: page.width, height: page.height, url: `/api/user-skills/template-pages/${key}/${index}` }));
    return result;
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!/^\/api\/user-skills(?:\/|$)/.test(url.pathname)) return false;
    const parts = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent), method = req.method ?? "GET";
    const scope = manager.skillScope(url.searchParams.get("sessionId") ?? undefined, url.searchParams.get("workId") ?? undefined, url.searchParams.get("workspaceId") ?? undefined);
    const library = manager.skillLibrary, skills = manager.userSkills;
    try {
      if (!parts.length && method === "GET") return (sendJson(res, 200, await skills.list(scope)), true);
      if (parts[0] === "template-pages" && method === "GET") {
        const record = pages.get(parts[1] ?? ""), index = Number(parts[2]);
        const page = Number.isSafeInteger(index) && index >= 0 && record && record.expires >= Date.now() ? record.items[index] : undefined;
        if (!page) throw new HttpError(404, "template_preview_expired", "양식 미리보기를 다시 열어 주세요.");
        const bytes = page.file ? await readFile(page.file) : Buffer.from(page.svg ?? "");
        res.writeHead(200, { "content-type": page.file ? "image/png" : "image/svg+xml", "cache-control": "private, max-age=300", "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" });
        res.end(bytes); return true;
      }
      if (parts[0] === "imports") {
        if (method === "DELETE" && parts[1]) return (await library.discard(parts[1]), sendJson(res, 200, { ok: true }), true);
        if (method === "POST") {
          const body = await json(req);
          if (!parts[1]) {
            if (!["folder", "zip", "github"].includes(string(body.kind))) throw new HttpError(400, "invalid_source", "가져올 종류를 선택해 주세요.");
            return (sendJson(res, 200, await library.prepare(body.kind as "folder" | "zip" | "github", string(body.source))), true);
          }
          if (parts[2] === "install") {
            const selected = Array.isArray(body.selected) ? body.selected.filter((item): item is string => typeof item === "string") : [];
            const collisions: Record<string, "replace" | "skip"> = {};
            for (const [key, value] of Object.entries(body.collisions && typeof body.collisions === "object" ? body.collisions : {})) if (value === "replace" || value === "skip") collisions[key] = value;
            return (sendJson(res, 200, await library.install(parts[1], selected, collisions)), true);
          }
        }
      }
      if (parts[0] === "register" && method === "POST") {
        const body = await json(req);
        return (sendJson(res, 200, await library.register({ title: string(body.title), name: string(body.name), description: string(body.description), body: string(body.body), file: string(body.file) }, scope)), true);
      }
      if (parts[0] === "updates" && parts[1] && method === "POST") {
        const body = await json(req);
        return (sendJson(res, 200, await library.applyUpdate(parts[1], body.allowLocalChanges === true, scope)), true);
      }
      const id = parts[0]; if (!id) return false;
      if (method === "GET" && parts.length === 1) return (sendJson(res, 200, await skills.detail(id, scope)), true);
      if (method === "GET" && parts[1] === "template") return (sendJson(res, 200, await preview(id, scope)), true);
      if (method === "GET" && parts[1] === "export") {
        const result = await library.export(id, scope);
        res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.info.fileName)}`, "cache-control": "no-store" }); res.end(result.bytes); return true;
      }
      if (method === "PUT" && parts[1] === "state") return (sendJson(res, 200, await skills.setState(id, await json(req) as WorkbenchSkillState, scope)), true);
      if (method === "PUT" && parts.length === 1) {
        const body = await json(req);
        return (sendJson(res, 200, await skills.update(id, string(body.sha256), { title: string(body.title), description: string(body.description), body: string(body.body) }, scope)), true);
      }
      if (method === "POST" && parts[1] === "clone") return (sendJson(res, 200, await library.clone(id, scope)), true);
      if (method === "POST" && parts[1] === "check-update") return (sendJson(res, 200, await library.checkUpdate(id, scope)), true);
      if (method === "DELETE" && parts.length === 1) { const body = await json(req); return (sendJson(res, 200, await library.remove(id, string(body.sha256), scope)), true); }
      return false;
    } catch (error) {
      if (error instanceof SkillImportError) throw new HttpError(error.kind === "needs-choice" ? 409 : 400, error.kind, error.message);
      throw error;
    }
  };
}
