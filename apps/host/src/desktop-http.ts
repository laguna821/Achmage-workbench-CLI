import type { IncomingMessage, ServerResponse } from "node:http";
import type { DesktopAction } from "@workbench/contracts";
import type { DesktopService } from "./desktop-adapter.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";

/** Owner authentication happens in http.ts. Device gateway does not expose desktop control. */
export async function handleDesktopHttp(req: IncomingMessage, res: ServerResponse, url: URL, service?: DesktopService) {
  if (!url.pathname.startsWith("/api/desktop")) return false;
  if (!service) throw new HttpError(503, "desktop_unavailable", "외부 앱 도구가 준비되지 않았습니다.");
  const p = url.pathname.split("/").filter(Boolean).slice(2), method = req.method;
  const body = async () => { try { const value = JSON.parse((await readBody(req, 100_000)).toString("utf8") || "{}"); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value as Record<string, unknown>; } catch { throw new HttpError(400, "desktop_json", "요청 형식이 올바르지 않습니다."); } };
  let value: unknown;
  if (method === "GET" && !p.length) value = service.state();
  else if (method === "POST" && p.join("/") === "install") { await service.installer.install(); value = service.state(); }
  else if (method === "POST" && p.join("/") === "status") value = await service.status();
  else if (method === "POST" && p.join("/") === "permissions") value = await service.requestPermissions();
  else if (method === "GET" && p.join("/") === "windows") value = await service.windows();
  else if (method === "POST" && p.join("/") === "take-over") value = service.takeOver();
  else if (p[0] === "sessions" && p[1]) {
    const id = decodeURIComponent(p[1]);
    if (method === "PUT" && p.length === 2) { const input = await body(); value = await service.bind(id, String(input.windowId ?? ""), input.headed === true); }
    else if (method === "DELETE" && p.length === 2) { service.release(id); value = { ok: true }; }
    else if (method === "POST" && p[2] === "snapshot" && p.length === 3) value = await service.observe(id);
    else if (method === "POST" && p[2] === "screenshot" && p.length === 3) value = await service.screenshot(id);
    else if (method === "POST" && p[2] === "act" && p.length === 3) value = await service.act(id, await body() as unknown as DesktopAction);
    else if (method === "POST" && p[2] === "reconcile" && p.length === 3) value = await service.reconcile(id, String((await body()).commandId ?? ""));
    else throw new HttpError(404, "desktop_route", "외부 앱 요청 경로가 없습니다.");
  } else throw new HttpError(404, "desktop_route", "외부 앱 요청 경로가 없습니다.");
  sendJson(res, 200, value); return true;
}
