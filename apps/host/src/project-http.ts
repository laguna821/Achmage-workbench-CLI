import type { IncomingMessage, ServerResponse } from "node:http";
import { PROPERTY_TYPES, type ProjectStage, type PropertyType } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import type { Projects } from "./project.ts";
import { sendImage } from "./pkm-http.ts";
import { documentAccess } from "./document-registry.ts";

// `/api/projects/*`: a work as a project note (project.ts). Mounted by http.ts behind the same token
// check as every other API route.

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, 2_000_000);
  if (!body.length) return {};
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "JSON 형식이 아닙니다.");
  }
}

const kindOf = (value: unknown): PropertyType | null => (PROPERTY_TYPES.some((entry) => entry.type === value) ? (value as PropertyType) : null);

const strings = (value: unknown): string[] | null => (value === null ? null : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : typeof value === "string" ? [value] : null);

/** Handle one project request; false when the path is not one of these routes. */
/**
 * The revision the page was showing (null: no file). The project page sends it with every write;
 * writes from other screens (kanban, sidebar tag drop, list bulk stage, "결정으로") do not yet, and go
 * unchecked against it (they are still single spans, guarded, after outside bytes are recorded).
 */
function baseOf(body: Record<string, unknown>): number | null | undefined {
  return typeof body.baseRevision === "number" || body.baseRevision === null ? (body.baseRevision as number | null) : undefined;
}

/** The base for the routes only the project page calls (body, run, source): required. */
function requiredBase(body: Record<string, unknown>): number | null {
  const base = baseOf(body);
  if (base === undefined) throw new HttpError(400, "base_required", "어느 판을 보고 고쳤는지 알 수 없어 쓰지 않았습니다. 노트를 다시 연 뒤 고쳐 주세요.");
  return base;
}

/** One list item added, removed or renamed. */
function changeOf(value: unknown): { add?: string; remove?: string; rename?: [string, string] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const change = value as Record<string, unknown>;
  if (typeof change.add === "string") return { add: change.add };
  if (typeof change.remove === "string") return { remove: change.remove };
  if (Array.isArray(change.rename) && change.rename.length === 2) return { rename: [String(change.rename[0]), String(change.rename[1])] };
  return undefined;
}

export async function handleProject(projects: Projects, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  const parts = url.pathname.replace(/^\/api\/projects\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (method === "POST" && parts.join("/") === "bases/export") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.exportBase(String(body.path ?? ""), String(body.source ?? ""))), true);
  }
  if (method === "GET" && parts.length === 2 && parts[1] === "image") return (sendImage(res, projects.image(parts[0]!, url.searchParams.get("src") ?? "")), true);
  if (parts[0] === "folder-templates" && parts[1] && !parts[2]) {
    if (method === "GET") return (sendJson(res, 200, projects.folderTemplate(parts[1])), true);
    if (method === "PUT") {
      const body = await readJson(req);
      return (sendJson(res, 200, projects.setFolderTemplate(parts[1], body.markdown)), true);
    }
    return false;
  }
  if (parts[0] === "stages") {
    if (method === "GET") return (sendJson(res, 200, projects.stages()), true);
    if (method === "PUT") {
      const body = await readJson(req);
      return (sendJson(res, 200, projects.setStages(Array.isArray(body.stages) ? (body.stages as ProjectStage[]) : [])), true);
    }
    return false;
  }
  // The properties template every project shows, a template from a Markdown file, the kinds of names.
  if (parts[0] === "template") {
    if (parts[1] === "import" && method === "POST") {
      const body = await readJson(req);
      return (sendJson(res, 200, projects.importTemplate(String(body.markdown ?? ""))), true);
    }
    if (method === "GET" && !parts[1]) return (sendJson(res, 200, projects.template()), true);
    if (method === "PUT" && !parts[1]) {
      const body = await readJson(req);
      return (sendJson(res, 200, projects.setTemplate(body.reset === true ? null : body.fields)), true);
    }
    return false;
  }
  if (parts[0] === "types" && method === "PUT") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setPropertyType(String(body.key ?? ""), kindOf(body.type) ?? "text")), true);
  }
  if (parts[0] === "changes" && method === "GET") return (sendJson(res, 200, projects.changes(url.searchParams.get("sessionId") ?? "")), true);
  if (!parts.length && method === "GET") return (sendJson(res, 200, projects.summaries()), true);
  const workId = parts[0];
  if (!workId) return false;
  const action = parts[1] ?? "";
  if (method === "POST" && action === "initialize-note") return (sendJson(res, 200, projects.initializeNote(workId)), true);
  if (method === "GET" && !action) return (sendJson(res, 200, projects.page(workId)), true);
  if (method === "GET" && action === "events") return (sendJson(res, 200, projects.allEvents(workId)), true);
  if (method === "PUT" && action === "property") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setProperty(workId, String(body.key ?? ""), strings(body.values), kindOf(body.type), documentAccess(req), baseOf(body), changeOf(body.change))), true);
  }
  if (method === "PUT" && action === "stage") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setStage(workId, typeof body.stage === "string" && body.stage ? body.stage : null, null, documentAccess(req), baseOf(body))), true);
  }
  if (method === "POST" && action === "entries") {
    const body = await readJson(req);
    return (
      sendJson(
        res,
        200,
        projects.addEntry(workId, {
          section: body.section === "question" ? "question" : "decision",
          text: String(body.text ?? ""),
          sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
          itemId: typeof body.itemId === "string" ? body.itemId : null,
          baseRevision: baseOf(body),
        }, documentAccess(req)),
      ),
      true
    );
  }
  if (method === "PUT" && action === "entries" && parts[2] !== undefined) {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setQuestionDone(workId, Number(parts[2]), body.done === true, documentAccess(req), baseOf(body), typeof body.text === "string" ? body.text : undefined)), true);
  }
  if (method === "PUT" && action === "body") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setBodyText(workId, String(body.body ?? ""), requiredBase(body), documentAccess(req))), true);
  }
  if (method === "PUT" && action === "run") {
    const body = await readJson(req);
    const run = { index: Number(body.index), expected: String(body.expected ?? ""), text: String(body.text ?? "") };
    return (sendJson(res, 200, projects.setRun(workId, run, requiredBase(body), documentAccess(req))), true);
  }
  if (method === "PUT" && action === "source") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setSource(workId, String(body.text ?? ""), requiredBase(body), documentAccess(req))), true);
  }
  if (method === "POST" && action === "revert") {
    const body = await readJson(req);
    if (typeof body.revision === "number") return (sendJson(res, 200, projects.revertTo(workId, body.revision, documentAccess(req), baseOf(body))), true);
    return (sendJson(res, 200, projects.revertEngineEdit(workId, documentAccess(req), baseOf(body))), true);
  }
  if (method === "POST" && action === "undo") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.undo(workId, String(body.token ?? ""), documentAccess(req), baseOf(body))), true);
  }
  return false;
}
