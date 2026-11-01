import { createHash } from "node:crypto";

/** Google is the only stand-in. The OAuth loopback, original Drive engines,
 * vault, files, editors and Workbench services remain real in their checks. */
export function googleDriveFixture(initial = []) {
  const files = new Map(initial.map(file => [file.id, { version: 1, canEdit: true, parents: ["root"], ...file, bytes: Buffer.from(file.bytes ?? "") }]));
  const uploads = [], requests = [], sessions = new Map();
  let revoked = false, tokenFailure = false;
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  const meta = file => ({ id: file.id, name: file.name, mimeType: file.mimeType, parents: file.parents,
    modifiedTime: `2026-11-01T00:00:${String(file.version).padStart(2, "0")}Z`, size: String(file.bytes.length),
    md5Checksum: createHash("md5").update(file.bytes).digest("hex"), capabilities: { canEdit: file.canEdit } });
  const fetch = async (address, init = {}) => {
    const url = new URL(String(address)), method = init.method ?? "GET";
    requests.push({ url: `${url.origin}${url.pathname}`, method });
    if (url.origin === "https://oauth2.googleapis.com") {
      if (url.pathname === "/revoke") { revoked = true; return json({}); }
      if (tokenFailure) return json({ error: "invalid_grant" }, 400);
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "authorization_code" && !form.get("code_verifier")) return json({ error: "missing_pkce" }, 400);
      return json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/drive" });
    }
    if (url.origin !== "https://www.googleapis.com") throw new Error("Unexpected Drive fixture network address");
    if (url.pathname.endsWith("/about")) return json({ user: { displayName: "Drive 검증", emailAddress: "drive-fixture@example.invalid" } });
    if (url.pathname.startsWith("/upload/drive/v3/")) {
      if (method === "PUT") {
        const target = sessions.get(url.pathname); if (!target) return json({}, 404);
        const file = files.get(target.id) ?? { id: target.id, name: target.name, mimeType: "application/octet-stream", canEdit: true, parents: target.parents ?? ["root"], version: 1 };
        file.bytes = Buffer.from(init.body); file.version++; files.set(file.id, file); uploads.push({ id: file.id, created: target.created, bytes: Buffer.from(file.bytes), name: file.name });
        return json(meta(file));
      }
      const existing = method === "PATCH", body = JSON.parse(String(init.body)), id = existing ? url.pathname.split("/").at(-1) : `copy-${uploads.length + sessions.size + 1}`;
      const path = `/upload/drive/v3/session-${sessions.size}`;
      sessions.set(path, { id, ...body, created: !existing });
      return json({}, 200, { Location: `https://www.googleapis.com${path}` });
    }
    const match = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
    if (match) {
      const file = files.get(match[1]); if (!file) return json({}, 404);
      if (match[2] || url.searchParams.get("alt") === "media") return new Response(file.bytes, { headers: { "content-length": String(file.bytes.length) } });
      return json(meta(file));
    }
    if (url.pathname === "/drive/v3/files") return json({ files: [...files.values()].map(meta) });
    throw new Error(`Unexpected Drive fixture route ${url.pathname}`);
  };
  return { files, fetch, uploads, requests, get revoked() { return revoked; }, setTokenFailure(value) { tokenFailure = value; } };
}
