import { createServer } from "node:http";
import { sendJson, serveStatic } from "./http.ts";

/** Privileged settings must not share an origin with document-reading editor frames.
 * This third loopback origin serves only the reviewed settings page and build assets.
 * All operations go through the exact Workbench parent frame; there are no APIs here. */
export function createOfficeSettingsServer(webDir: string | null, parentOrigin: () => string | null) {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const parent = parentOrigin();
    const allowed = path === "/office/settings.html" || /^\/office\/assets\/[\w.-]+\.(?:js|css|svg|png|jpe?g|webp|woff2?|ttf|otf)$/.test(path);
    if (req.method !== "GET" || !allowed || !webDir || !parent) return sendJson(res, 404, { code: "not_here", message: "설정 화면 전용 주소입니다." });
    try {
      serveStatic(res, webDir, path, { "content-security-policy": `frame-ancestors ${parent}`, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    } catch { sendJson(res, 404, { code: "not_found", message: "설정 화면 파일이 없습니다." }); }
  });
}
