import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { HttpError } from "./errors.ts";
import { MIME, readBody, sendJson } from "./http.ts";
import type { CardTarget, Pkm } from "./pkm.ts";

// `/api/pkm/*`: the vault mirror and what ties notes to works and sessions. Mounted by http.ts
// behind the same token check as every other API route.

async function readJson(req: IncomingMessage, limit = 2_000_000): Promise<Record<string, unknown>> {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "JSON 형식이 아닙니다.");
  }
}

/** A picture, kept by the browser for a while (vault files change rarely; the URL changes with the vault version). */
function sendImage(res: ServerResponse, file: string) {
  res.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  createReadStream(file).pipe(res);
}

function cardTarget(url: URL): CardTarget {
  const kind = url.searchParams.get("kind");
  if (kind === "vault") return { kind, path: url.searchParams.get("path") ?? "", descendants: url.searchParams.get("descendants") !== "0" };
  if (kind === "folder" || kind === "work" || kind === "view") return { kind, id: url.searchParams.get("id") ?? "" };
  throw new HttpError(400, "bad_target", "무엇의 카드를 볼지 정해 주세요.");
}

/** Handle one PKM request; false when the path is not one of these routes. */
export async function handlePkm(pkm: Pkm, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = url.pathname.replace(/^\/api\/pkm/, "");
  const query = (name: string) => url.searchParams.get(name) ?? "";
  if (method === "GET" && path === "/state") return (sendJson(res, 200, pkm.state()), true);
  if (method === "GET" && path === "/tags") return (sendJson(res, 200, pkm.vaultTags()), true);
  if (method === "GET" && path === "/vault/tree") return (sendJson(res, 200, pkm.vault.tree()), true);
  if (method === "PUT" && path === "/vault") {
    const body = await readJson(req);
    return (sendJson(res, 200, pkm.attachVault(typeof body.path === "string" ? body.path : null)), true);
  }
  if (method === "DELETE" && path === "/vault") return (sendJson(res, 200, pkm.attachVault(null)), true);
  if (method === "POST" && path === "/vault/rescan") {
    pkm.vault.rescan(true);
    return (sendJson(res, 200, pkm.vault.status()), true);
  }
  if (method === "GET" && path === "/cards") return (sendJson(res, 200, pkm.cards(cardTarget(url))), true);
  if (method === "GET" && path === "/vault/note") return (sendJson(res, 200, pkm.note(query("path"))), true);
  if (method === "GET" && path === "/vault/image") return (sendImage(res, pkm.vaultImage(query("path"))), true);
  if (method === "GET" && path === "/page-image") return (sendImage(res, pkm.pageImage(query("artifact"), query("src"))), true);
  if (method === "GET" && path === "/templates") return (sendJson(res, 200, pkm.templates(query("workId"))), true);
  if (method === "PUT" && path === "/views") {
    const body = await readJson(req);
    return (sendJson(res, 200, pkm.saveView(body)), true);
  }
  if (method === "DELETE" && path.startsWith("/views/")) {
    pkm.deleteView(decodeURIComponent(path.slice("/views/".length)));
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (method === "POST" && path === "/views/preview") {
    const body = await readJson(req);
    return (sendJson(res, 200, pkm.viewCards({ name: "미리보기", query: String(body.query ?? ""), groupBy: typeof body.groupBy === "string" ? body.groupBy : null })), true);
  }
  if (method === "PUT" && path === "/rules") {
    const body = await readJson(req);
    return (sendJson(res, 200, pkm.saveRules(body.rules)), true);
  }
  if (method === "GET" && path === "/rules/preview") return (sendJson(res, 200, pkm.previewRules()), true);
  if (method === "PUT" && path === "/pins") {
    const body = await readJson(req);
    return (sendJson(res, 200, pkm.setPin(String(body.workId ?? ""), String(body.path ?? ""), body.pinned !== false)), true);
  }
  if (method === "GET" && path === "/insight") return (sendJson(res, 200, pkm.insight(query("sessionId"))), true);
  if (method === "POST" && (path === "/insight/check" || path === "/insight/publish")) {
    const body = await readJson(req);
    const sessionId = String(body.sessionId ?? "");
    const text = String(body.text ?? "");
    if (path === "/insight/check") return (sendJson(res, 200, pkm.checkInsight(sessionId, text)), true);
    return (sendJson(res, 202, await pkm.publishInsight(sessionId, text, String(body.requestId ?? "") || `insight-${Date.now()}`)), true);
  }
  if (method === "GET" && path === "/context-card") {
    const work = pkm.manager.view.works.get(query("workId"));
    if (!work) throw new HttpError(404, "work_not_found", "작업을 찾지 못했습니다.");
    return (sendJson(res, 200, { card: pkm.cardFor(work), protected: pkm.protectedRoots() }), true);
  }
  if (method === "POST" && path === "/rules/apply") {
    const body = await readJson(req);
    return (sendJson(res, 200, pkm.applyRules(Array.isArray(body.workIds) ? body.workIds.filter((id): id is string => typeof id === "string") : [])), true);
  }
  if (method === "POST" && path.startsWith("/pages/")) {
    const body = await readJson(req);
    const text = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
    if (path === "/pages/from-template") {
      const choices = Object.fromEntries(
        Object.entries(body.choices && typeof body.choices === "object" ? (body.choices as Record<string, unknown>) : {}).map(([key, values]) => [key, Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : []]),
      );
      return (sendJson(res, 201, pkm.pageFromTemplate(text("workId"), text("templateId"), text("title"), choices, text("parentId") || null)), true);
    }
    if (path === "/pages/subpage") return (sendJson(res, 201, pkm.subpage(text("parentId"), text("name"))), true);
    if (path === "/pages/from-session") return (sendJson(res, 201, pkm.sessionPage(text("sessionId"), text("workId"))), true);
    if (path === "/pages/from-message") return (sendJson(res, 201, pkm.messagePage(text("sessionId"), text("itemId"), text("selection") || null)), true);
  }
  return false;
}
