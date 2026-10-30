import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { DocumentRegistration } from "@workbench/contracts";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { createEditorsServer, EditorGrants, officeEditorKind } from "./editors.ts";
import { createHttpServer } from "./http.ts";
import { createOfficeSettingsServer } from "./office-settings-server.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// The office editors' own origin: pages and the one document a grant opens, nothing else.

/** Bytes that look like an Office package to the gateway (a zip local file header and some data). */
const pkg = (text: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(text)]);

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("separates privileged settings from both the document and application origins", async () => {
  const { manager, web } = setup();
  writeFileSync(join(web, "office/settings.html"), "<!doctype html><title>settings</title>");
  mkdirSync(join(web, "office/assets")); writeFileSync(join(web, "office/assets/settings-abc.js"), "export {};\n");
  const parent = "http://127.0.0.1:12345";
  const settings = await listen(createOfficeSettingsServer(web, () => parent));
  const editors = await listen(createEditorsServer(manager.documents, new EditorGrants(), web));
  const page = await fetch(`${settings}/office/settings.html`);
  expect(page.status).toBe(200); expect(page.headers.get("content-security-policy")).toBe(`frame-ancestors ${parent}`);
  expect((await fetch(`${settings}/office/assets/settings-abc.js`)).status).toBe(200);
  for (const path of ["/office/docs.html", "/index.html", "/api/office-ai/settings", "/api/artifacts/any/bytes"]) expect((await fetch(`${settings}${path}`)).status).toBe(404);
  expect((await fetch(`${editors}/office/settings.html`)).status).toBe(404);
  expect((await fetch(`${editors}/office/%73ettings.html`)).status).toBe(404);
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-editors-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "office"), { recursive: true });
  writeFileSync(join(web, "office", "docs.html"), "<!doctype html><title>docs</title>");
  writeFileSync(join(web, "index.html"), "<!doctype html><title>app</title>");
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "문서", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  writeFileSync(join(work.cwd, "계획.docx"), pkg("r1"));
  writeFileSync(join(work.cwd, "다른.docx"), pkg("other"));
  writeFileSync(join(work.cwd, "메모.md"), "# 메모\n");
  const plan = manager.openFile(work.id, "계획.docx");
  const other = manager.openFile(work.id, "다른.docx");
  const note = manager.openFile(work.id, "메모.md");
  return { manager, web, plan, other, note };
}

describe("office editor pages", () => {
  it("enforces scoped writer access through both the main HTTP API and Office grants", async () => {
    const { manager, web, plan, note } = setup();
    const grants = new EditorGrants();
    const editor = await listen(createEditorsServer(manager.documents, grants, web));
    const app = await listen(createHttpServer(manager, new EventBus(), { token: "test", webDir: web, editors: { grants, origin: () => editor } }));
    const call = (method: string, path: string, body?: unknown, access?: DocumentRegistration) => fetch(`${app}${path}`, { method, headers: { authorization: "Bearer test", "content-type": "application/json", ...(access ? { "x-workbench-view": access.view.viewId, "x-workbench-write": access.writeToken ?? "" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const open = async (artifactId: string, viewId: string) => (await (await call("POST", `/api/artifacts/${artifactId}/views`, { viewId, windowId: viewId, claim: true })).json()) as DocumentRegistration;
    const writer = await open(note.id, "writer"), reader = await open(note.id, "reader");
    const save = (access?: DocumentRegistration) => call("PUT", `/api/artifacts/${note.id}/text`, { expectedRevision: 1, text: "Saved by the owner" }, access);
    expect((await save()).status).toBe(423);
    expect((await save(reader)).status).toBe(423);
    expect((await save({ ...writer, writeToken: "forged" })).status).toBe(423);
    expect(readFileSync(note.path, "utf8")).toBe("# 메모\n");
    expect((await save(writer)).status).toBe(200);
    writeFileSync(note.path, "External file change\n");
    expect((await call("POST", `/api/artifacts/${note.id}/adopt-disk`)).status).toBe(200);
    expect(readFileSync(note.path, "utf8")).toBe("External file change\n");
    expect((await call("PUT", `/api/artifacts/${note.id}/text`, { expectedRevision: 2, text: "stale writer" }, writer)).status).toBe(409);
    const textGrant = async (access: DocumentRegistration) => (await (await call("POST", `/api/artifacts/${note.id}/editor`, undefined, access)).json()) as { token: string };
    const textWriter = await textGrant(writer), textReader = await textGrant(reader);
    const putText = (token: string, revision: number) => fetch(`${editor}/api/artifacts/${note.id}/text?expectedRevision=${revision}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: "Scoped rich text\r\n" });
    expect((await putText(textReader.token, 3)).status).toBe(423);
    expect((await putText(textWriter.token, 3)).status).toBe(200);
    await call("DELETE", "/api/document-views/writer", { windowId: "writer" });
    expect((await putText(textWriter.token, 4)).status).toBe(423);
    expect(readFileSync(note.path, "utf8")).toBe("Scoped rich text\r\n");
    const officeWriter = await open(plan.id, "office-writer"), officeReader = await open(plan.id, "office-reader");
    const grant = async (access: DocumentRegistration) => (await (await call("POST", `/api/artifacts/${plan.id}/editor`, undefined, access)).json()) as { token: string };
    const writerGrant = await grant(officeWriter), readerGrant = await grant(officeReader);
    const put = (token: string, revision: number) => fetch(`${editor}/api/artifacts/${plan.id}/bytes?expectedRevision=${revision}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: new Uint8Array(pkg("scoped bytes")) });
    expect((await put(readerGrant.token, 1)).status).toBe(423);
    expect((await put(writerGrant.token, 1)).status).toBe(200);
    await call("DELETE", "/api/document-views/office-writer", { windowId: "office-writer" });
    expect((await put(writerGrant.token, 2)).status).toBe(423);
    expect((await put(readerGrant.token, 2)).status).toBe(423);
    const next = await open(plan.id, "office-reader");
    expect(next.view.mode).toBe("write");
    expect((await put((await grant(next)).token, 2)).status).toBe(200);
  });

  it("edit Word, PowerPoint and Excel documents", () => {
    expect(officeEditorKind("docx")).toBe("docs");
    expect(officeEditorKind("pptx")).toBe("slides");
    expect(officeEditorKind("xlsx")).toBe("sheets");
    expect(officeEditorKind("markdown")).toBe("markdown");
    expect(officeEditorKind("html")).toBe("html");
  });

  it("grant one document per token, and forget the oldest", () => {
    const grants = new EditorGrants(2);
    const first = grants.issue("a");
    const second = grants.issue("b");
    expect(grants.allows(first, "a")).toBe(true);
    expect(grants.allows(first, "b")).toBe(false);
    expect(grants.allows(null, "a")).toBe(false);
    expect(grants.allows("made-up", "a")).toBe(false);
    grants.issue("c");
    expect(grants.allows(first, "a")).toBe(false);
    expect(grants.allows(second, "b")).toBe(true);
  });

  it("serve the pages and the granted document, nothing else", async () => {
    const { manager, web, plan, other } = setup();
    const grants = new EditorGrants();
    const origin = await listen(createEditorsServer(manager.documents, grants, web));
    const token = grants.issue(plan.id);
    const get = (path: string, auth: string | null = token) => fetch(`${origin}${path}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });

    const page = await get("/office/docs.html", null);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect((await get("/office/assets/missing.js", null)).status).toBe(404);
    expect((await get("/index.html", null)).status).toBe(404);
    expect((await get("/api/snapshot")).status).toBe(404);

    expect((await get(`/api/artifacts/${plan.id}/raw`, null)).status).toBe(401);
    expect((await get(`/api/artifacts/${other.id}/raw`)).status).toBe(401);
    const raw = await get(`/api/artifacts/${plan.id}/raw`);
    expect(raw.status).toBe(200);
    expect(Buffer.from(await raw.arrayBuffer()).toString()).toContain("r1");
  });

  it("give open pages the system's face for a font family, by id only", async () => {
    const { manager, web, plan } = setup();
    const grants = new EditorGrants();
    const origin = await listen(createEditorsServer(manager.documents, grants, web));
    const token = grants.issue(plan.id);
    const get = (path: string, auth: string | null = token) => fetch(`${origin}${path}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    expect((await get("/api/fonts/match?family=Arial", null)).status).toBe(401);
    expect((await get("/api/fonts/face/0123456789abcdef0123")).status).toBe(404);
    expect((await get("/api/fonts/face/../../etc/passwd")).status).toBe(404);
    const match = (await (await get("/api/fonts/match?family=sans-serif")).json()) as { id: string; family: string } | null;
    // Without fontconfig (another system) there is no match; with it, the face's bytes are a font.
    if (match) {
      const face = Buffer.from(await (await get(`/api/fonts/face/${match.id}`)).arrayBuffer());
      expect([0x00010000, 0x4f54544f, 0x74727565]).toContain(face.readUInt32BE(0));
    }
  });

  it("save bytes as the next revision, and refuse stale or foreign bytes", async () => {
    const { manager, web, plan } = setup();
    const grants = new EditorGrants();
    const origin = await listen(createEditorsServer(manager.documents, grants, web));
    const token = grants.issue(plan.id);
    const put = (expected: number, body: Buffer) =>
      fetch(`${origin}/api/artifacts/${plan.id}/bytes?expectedRevision=${expected}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: new Uint8Array(body) });

    const saved = await put(1, pkg("r2"));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { revision: number }).revision).toBe(2);
    expect(readFileSync(manager.documents.check(plan.id).path, "utf8")).toContain("r2");
    const stale = await put(1, pkg("late"));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("revision_conflict");
    expect((await put(2, Buffer.from("not a package"))).status).toBe(422);
    expect(manager.documents.check(plan.id).revision).toBe(2);
  });

  it("are not served on the app's origin, which hands out grants for Word documents", async () => {
    const { manager, web, plan, note } = setup();
    const grants = new EditorGrants();
    const app = await listen(
      createHttpServer(manager, new EventBus(), { token: "app-token", webDir: web, editors: { grants, origin: () => "http://127.0.0.1:4999" } }),
    );
    expect((await fetch(`${app}/office/docs.html`)).status).toBe(404);
    const call = (id: string) => fetch(`${app}/api/artifacts/${id}/editor`, { method: "POST", headers: { authorization: "Bearer app-token" } });
    const granted = (await (await call(plan.id)).json()) as { url: string; origin: string; token: string };
    expect(granted.url).toBe("http://127.0.0.1:4999/office/docs.html");
    expect(grants.allows(granted.token, plan.id)).toBe(true);
    expect(((await (await call(note.id)).json()) as { url: string }).url).toBe("http://127.0.0.1:4999/office/markdown.html");
    // The grant is not the app's token.
    expect((await fetch(`${app}/api/snapshot`, { headers: { authorization: `Bearer ${granted.token}` } })).status).toBe(401);
  });

  it("preserves Markdown source bytes and rejects stale, foreign and invalid text saves", async () => {
    const { manager, web, note, plan } = setup();
    const grants = new EditorGrants(), origin = await listen(createEditorsServer(manager.documents, grants, web));
    const token = grants.issue(note.id);
    const put = (id: string, revision: number, body: string | Uint8Array, auth = token) => fetch(`${origin}/api/artifacts/${id}/text?expectedRevision=${revision}`, { method: "PUT", headers: { authorization: `Bearer ${auth}` }, body: typeof body === "string" ? body : new Uint8Array(body).buffer });
    const source = '\ufeff# 메모\r\n\r\n[x][ref]\r\n\r\n[^1]: note\r\n[ref]: https://example.com\r\n<div data-test="keep">raw</div>';
    expect((await put(note.id, 1, source)).status).toBe(200);
    expect(readFileSync(note.path)).toEqual(Buffer.from(source));
    expect((await put(note.id, 2, source)).status).toBe(200);
    expect(manager.documents.get(note.id).revision).toBe(2);
    expect((await put(note.id, 1, "stale")).status).toBe(409);
    expect((await put(plan.id, 1, "foreign")).status).toBe(401);
    expect((await put(plan.id, 1, "not an Office package", grants.issue(plan.id))).status).toBe(415);
    expect((await put(note.id, 2, new Uint8Array([0xff]))).status).toBe(422);
    writeFileSync(note.path, "external\r\n");
    expect((await put(note.id, 2, "overwrite")).status).toBe(409);
    expect(readFileSync(note.path, "utf8")).toBe("external\r\n");
  });

  it("isolates HTML previews from editor credentials and preserves them across grant refresh", async () => {
    const { manager, web, note } = setup();
    const file = join(dirname(note.path), "page.html");
    writeFileSync(file, "<!doctype html><p>Original</p>");
    const page = manager.openFile(note.workId, file);
    const grants = new EditorGrants(3), origin = await listen(createEditorsServer(manager.documents, grants, web));
    const token = grants.issue(page.id, { viewId: "html-view", writeToken: null });
    const request = (method: string, target: string, auth: string, body?: string) => fetch(`${origin}${target}`, { method, headers: { authorization: `Bearer ${auth}` }, body });
    const route = `/api/artifacts/${page.id}/html-preview`;
    const info = await (await request("GET", route, token)).json() as { url: string; baseUrl: string };
    expect(info.url).not.toContain(token);
    expect((await fetch(`${origin}${info.url}`)).status).toBe(404);
    const preview = '<html><script>parent.postMessage("page", "*")</script><p>Live unsaved</p></html>';
    expect((await request("PUT", route, token, preview)).status).toBe(200);
    const response = await fetch(`${origin}${info.url}?v=1`);
    expect(await response.text()).toBe(preview.replace("<html>", `<html><base href="${info.baseUrl}">`));
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect((await request("PUT", route, info.url.split("/")[2]!, "forged")).status).toBe(401);
    expect((await request("PUT", `/api/artifacts/${note.id}/html-preview`, token, "foreign")).status).toBe(401);
    const renewed = grants.issue(page.id, { viewId: "html-view", writeToken: "renewed" });
    expect(await (await request("GET", route, renewed)).json()).toEqual(info);
    await request("PUT", route, renewed, "new preview");
    expect(await (await fetch(`${origin}${info.url}`)).text()).toBe(`<base href="${info.baseUrl}">new preview`);
    expect(readFileSync(file, "utf8")).toBe("<!doctype html><p>Original</p>");
    grants.issue("other-1"); grants.issue("other-2"); grants.issue("other-3");
    expect((await fetch(`${origin}${info.url}`)).status).toBe(404);
  });

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  it("serves only document-scoped assets, including saved-web-page extensionless assets", async () => {
    const { manager, web, note } = setup(), root = dirname(note.path);
    writeFileSync(join(root, "page.html"), '<!doctype html><base href="files/"><img src="pic.png">');
    const page = manager.openFile(note.workId, "page.html");
    mkdirSync(join(root, "files")); mkdirSync(join(root, ".private"));
    for (const name of ["그림 100%.png", "files/pic.png", "files/without-extension", ".private/hidden.png"]) writeFileSync(join(root, name), png);
    writeFileSync(join(root, "files/style.css"), "body { color: red }");
    writeFileSync(join(root, "files/script.js"), "document.body.dataset.loaded='yes'");
    writeFileSync(join(root, "files/style-without-extension"), "body { color: blue }");
    writeFileSync(join(root, "secret.json"), '{"secret":"no"}'); writeFileSync(join(root, ".env"), "SECRET=no");
    writeFileSync(join(dirname(root), "outside.png"), png); symlinkSync(join(dirname(root), "outside.png"), join(root, "escape.png"));
    const grants = new EditorGrants(2), origin = await listen(createEditorsServer(manager.documents, grants, web));
    const token = grants.issue(page.id), auth = { authorization: `Bearer ${token}` };
    const info = await (await fetch(`${origin}/api/artifacts/${page.id}/assets`, { headers: auth })).json() as { baseUrl: string; url: string };
    const get = (path: string, accept = "image/*") => fetch(`${origin}${info.baseUrl}${path}`, { headers: { accept } });
    expect(info.baseUrl).not.toContain(token);
    expect(Buffer.from(await (await get(encodeURIComponent("그림 100%.png"))).arrayBuffer())).toEqual(png);
    expect((await get("files/style.css", "text/css")).headers.get("content-type")).toContain("text/css");
    expect((await get("files/script.js", "*/*")).headers.get("access-control-allow-origin")).toBeNull();
    expect((await get("files/without-extension")).headers.get("content-type")).toBe("image/png");
    expect((await get("files/style-without-extension", "text/css")).headers.get("content-type")).toContain("text/css");
    for (const path of ["secret.json", ".env", ".private/hidden.png", "escape.png", "%2E%2E%2Foutside.png", "__image?src=%2Fetc%2Fpasswd"]) expect((await get(path)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${origin}/api/artifacts/${note.id}/image?src=files/pic.png`, { headers: auth })).status).toBe(401);
    await fetch(`${origin}/api/artifacts/${page.id}/html-preview`, { method: "PUT", headers: auth, body: readFileSync(page.path, "utf8") });
    expect(await (await fetch(`${origin}${info.url}`)).text()).toBe(readFileSync(page.path, "utf8")); // authored base untouched
    grants.issue("foreign-1"); grants.issue("foreign-2");
    expect((await get("files/pic.png")).status).toBe(404);
  });

  it("writes exclusive owned images with writer/CAS checks and keeps prior and unowned assets", async () => {
    const { manager, web, note } = setup(), root = dirname(note.path);
    mkdirSync(join(root, "assets")); writeFileSync(join(root, "assets/image.png"), png);
    const original = readFileSync(note.path);
    const grants = new EditorGrants(), origin = await listen(createEditorsServer(manager.documents, grants, web));
    const open = (viewId: string) => { const view = manager.documents.registry.open(note.id, { viewId, windowId: viewId, claim: true }); return grants.issue(note.id, { viewId, writeToken: view.writeToken }); };
    const writer = open("image-writer"), reader = open("image-reader");
    const put = (token: string, revision = 1, bytes = png) => fetch(`${origin}/api/artifacts/${note.id}/image?expectedRevision=${revision}&name=image.png`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: new Uint8Array(bytes).buffer });
    expect((await put("invalid")).status).toBe(401); expect((await put(reader)).status).toBe(423);
    expect((await put(writer, 2)).status).toBe(409); expect((await put(writer, 1, Buffer.from("not a png"))).status).toBe(415);
    const saved = await (await put(writer)).json() as { path: string };
    expect(saved.path).toBe("assets/image-1.png"); expect(readFileSync(join(root, saved.path))).toEqual(png);
    expect(readFileSync(note.path)).toEqual(original); expect(readFileSync(join(root, "assets/image.png"))).toEqual(png);
    const manifest = JSON.parse(readFileSync(join(root, "assets/.genoffice-assets.json"), "utf8"));
    expect(manifest.files.map((entry: { name: string }) => entry.name)).toEqual(["image-1.png"]);
    expect(manifest.pending["메모.md"]).toEqual(["image-1.png"]);
    const image = await (await fetch(`${origin}/api/artifacts/${note.id}/image?src=${encodeURIComponent(saved.path)}`, { headers: { authorization: `Bearer ${writer}` } })).json();
    expect(image).toEqual({ base64: png.toString("base64"), mime: "image/png" });
    const save = await fetch(`${origin}/api/artifacts/${note.id}/text?expectedRevision=1`, { method: "PUT", headers: { authorization: `Bearer ${writer}` }, body: "# No current picture\n" });
    expect(save.status).toBe(200); expect(readFileSync(join(root, saved.path))).toEqual(png); // history/Undo may still need it
    writeFileSync(note.path, "outside edit"); expect((await put(writer, 2)).status).toBe(409);
    manager.documents.registry.close("image-writer", "image-writer"); expect((await put(writer, 2)).status).toBe(423);
    expect(readdirSync(join(root, "assets")).sort()).toEqual([".genoffice-assets.json", "image-1.png", "image.png"]);
  });

  it("does not follow a linked asset folder or overwrite a broken ownership manifest", async () => {
    for (const mode of ["symlink", "manifest"] as const) {
      const { manager, web, note } = setup(), root = dirname(note.path), target = join(dirname(root), "elsewhere");
      mkdirSync(target);
      if (mode === "symlink") symlinkSync(target, join(root, "assets"), "dir");
      else { mkdirSync(join(root, "assets")); writeFileSync(join(root, "assets/.genoffice-assets.json"), "broken manifest"); }
      const grants = new EditorGrants(), origin = await listen(createEditorsServer(manager.documents, grants, web)), token = grants.issue(note.id);
      const result = await fetch(`${origin}/api/artifacts/${note.id}/image?expectedRevision=1`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: new Uint8Array(png).buffer });
      expect(result.status).toBe(500); expect(readdirSync(target)).toEqual([]);
      if (mode === "manifest") { expect(readFileSync(join(root, "assets/.genoffice-assets.json"), "utf8")).toBe("broken manifest"); expect(readdirSync(join(root, "assets"))).toEqual([".genoffice-assets.json"]); }
    }
  });
});
