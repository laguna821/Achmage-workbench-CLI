import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectStage } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import type { Projects } from "./project.ts";

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

const strings = (value: unknown): string[] | null => (value === null ? null : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : typeof value === "string" ? [value] : null);

/** Handle one project request; false when the path is not one of these routes. */
export async function handleProject(projects: Projects, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  const parts = url.pathname.replace(/^\/api\/projects\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "stages") {
    if (method === "GET") return (sendJson(res, 200, projects.stages()), true);
    if (method === "PUT") {
      const body = await readJson(req);
      return (sendJson(res, 200, projects.setStages(Array.isArray(body.stages) ? (body.stages as ProjectStage[]) : [])), true);
    }
    return false;
  }
  if (parts[0] === "changes" && method === "GET") return (sendJson(res, 200, projects.changes(url.searchParams.get("sessionId") ?? "")), true);
  if (!parts.length && method === "GET") return (sendJson(res, 200, projects.summaries()), true);
  const workId = parts[0];
  if (!workId) return false;
  const action = parts[1] ?? "";
  if (method === "GET" && !action) return (sendJson(res, 200, projects.page(workId)), true);
  if (method === "GET" && action === "events") return (sendJson(res, 200, projects.allEvents(workId)), true);
  if (method === "PUT" && action === "property") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setProperty(workId, String(body.key ?? ""), strings(body.values))), true);
  }
  if (method === "PUT" && action === "stage") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setStage(workId, typeof body.stage === "string" && body.stage ? body.stage : null)), true);
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
        }),
      ),
      true
    );
  }
  if (method === "PUT" && action === "entries" && parts[2] !== undefined) {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setQuestionDone(workId, Number(parts[2]), body.done === true)), true);
  }
  if (method === "PUT" && action === "body") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.setBodyText(workId, String(body.body ?? ""), typeof body.baseRevision === "number" ? body.baseRevision : null)), true);
  }
  if (method === "POST" && action === "revert") return (sendJson(res, 200, projects.revertEngineEdit(workId)), true);
  if (method === "POST" && action === "undo") {
    const body = await readJson(req);
    return (sendJson(res, 200, projects.undo(workId, String(body.token ?? ""))), true);
  }
  return false;
}
