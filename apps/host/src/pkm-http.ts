import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import type { Pkm } from "./pkm.ts";

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

/** Handle one PKM request; false when the path is not one of these routes. */
export async function handlePkm(pkm: Pkm, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = url.pathname.replace(/^\/api\/pkm/, "");
  if (method === "GET" && path === "/state") return (sendJson(res, 200, pkm.state()), true);
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
  return false;
}
