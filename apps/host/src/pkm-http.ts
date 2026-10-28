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
  if (kind === "folder" || kind === "work") return { kind, id: url.searchParams.get("id") ?? "" };
  throw new HttpError(400, "bad_target", "무엇의 카드를 볼지 정해 주세요.");
}

/** Handle one PKM request; false when the path is not one of these routes. */
export async function handlePkm(pkm: Pkm, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = url.pathname.replace(/^\/api\/pkm/, "");
  const query = (name: string) => url.searchParams.get(name) ?? "";
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
  if (method === "GET" && path === "/cards") return (sendJson(res, 200, pkm.cards(cardTarget(url))), true);
  if (method === "GET" && path === "/vault/note") return (sendJson(res, 200, pkm.note(query("path"))), true);
  if (method === "GET" && path === "/vault/image") return (sendImage(res, pkm.vaultImage(query("path"))), true);
  if (method === "GET" && path === "/page-image") return (sendImage(res, pkm.pageImage(query("artifact"), query("src"))), true);
  return false;
}
