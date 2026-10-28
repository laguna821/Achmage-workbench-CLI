import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { createEditorsServer, EditorGrants, officeEditorKind } from "./editors.ts";
import { createHttpServer } from "./http.ts";
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
  it("edit Word, PowerPoint and Excel documents", () => {
    expect(officeEditorKind("docx")).toBe("docs");
    expect(officeEditorKind("pptx")).toBe("slides");
    expect(officeEditorKind("xlsx")).toBe("sheets");
    expect(officeEditorKind("markdown")).toBeNull();
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
    expect((await call(note.id)).status).toBe(415);
    // The grant is not the app's token.
    expect((await fetch(`${app}/api/snapshot`, { headers: { authorization: `Bearer ${granted.token}` } })).status).toBe(401);
  });
});
