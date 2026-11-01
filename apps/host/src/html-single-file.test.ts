import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { OfficeOutputs } from "./office-output.ts";
import { officeGenerated } from "./office-generated.ts";
import { singleHtml } from "./html-single-file.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-html-single-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "HTML output" });
  const path = join(work.cwd, "원문.single.html"), original = "<!doctype html>\r\n<p>Original</p>\r\n";
  writeFileSync(path, original); mkdirSync(join(work.cwd, "assets")); mkdirSync(join(work.cwd, ".private"));
  writeFileSync(join(work.cwd, "assets/한 글.png"), png); writeFileSync(join(work.cwd, ".private/image.png"), png);
  writeFileSync(join(work.cwd, "assets/shape.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>');
  const artifact = manager.openFile(work.id, path), registration = manager.documents.registry.open(artifact.id, { viewId: "html-view", windowId: "window", claim: true });
  const access = { viewId: registration.view.viewId, writeToken: registration.writeToken }, grants = new EditorGrants();
  const token = grants.issue(artifact.id, access), server = createEditorsServer(manager.documents, grants, null);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (method: string, suffix = "", body?: unknown, auth = token) => fetch(`${origin}/api/artifacts/${artifact.id}/html-export${suffix}`, { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { dir, manager, work, artifact, access, grants, token, request, path, original, outputs: new OfficeOutputs(manager.documents, manager.registerOfficeCopy.bind(manager)) };
}

it("uses the original HTML/CSS image engine with allowed image snapshots and original skipped references", async () => {
  const f = await setup();
  const source = `<!doctype html>\r\n<!-- keep -->\r\n<style>.hero{background:url('assets/%ED%95%9C%20%EA%B8%80.png')}</style><img src="assets/한 글.png"><img src='assets/shape.svg'><img src="missing.png"><img src=".private/image.png"><img src="../outside.png"><img src="https://example.com/image.png"><script>const original = 'untouched';</script>`;
  const result = await singleHtml(f.manager.documents, f.artifact, source);
  expect(result.inlined).toBe(3); expect(result.html.match(/data:image\/png;base64,/g)).toHaveLength(2);
  expect(result.html).toContain("data:image/svg+xml;base64,");
  expect(result.skipped).toEqual(["missing.png", ".private/image.png", "../outside.png"]);
  expect(result.html).toContain("<!-- keep -->\r\n"); expect(result.html).toContain("const original = 'untouched'");
  expect(result.html).toContain('src="https://example.com/image.png"'); expect(result.defaultName).toBe("원문.single.html");
  expect(readFileSync(f.path, "utf8")).toBe(f.original); expect(readdirSync(join(f.dir, "office-single-file"))).toEqual([]);
});

it("publishes the exact original single-file output across folders, keeps skipped links, and replays its receipt", async () => {
  const f = await setup(), html = '<!doctype html><h1>Unsaved</h1><img src="assets/한 글.png"><img src="missing.png"><link rel="stylesheet" href="style.css">';
  const response = await f.request("POST", "", { revision: 1, html }); expect(response.status).toBe(200);
  const generated = await response.json() as { id: string; revision: number; skipped: string[] };
  expect(generated.skipped).toEqual(["missing.png"]);
  const bytes = officeGenerated(f.manager.documents).read(generated.id, f.artifact.id, f.access).bytes;
  const other = join(f.work.cwd, "output"); mkdirSync(other);
  const plan = f.outputs.prepare(f.artifact.id, 1, join(other, "page.html"), f.access);
  expect(() => f.outputs.prepare(f.artifact.id, 1, f.path, f.access)).toThrow();
  const result = await f.outputs.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, generated.id);
  expect(readFileSync(result.path)).toEqual(bytes); expect(readdirSync(other)).toEqual(["page.html"]);
  expect(readFileSync(f.path, "utf8")).toBe(f.original); expect(f.manager.documents.get(f.artifact.id).revision).toBe(1);
  const restarted = new OfficeOutputs(f.manager.documents, f.manager.registerOfficeCopy.bind(f.manager));
  expect(await restarted.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, generated.id)).toEqual(result);
  await expect(restarted.commit(f.artifact.id, plan.id, Buffer.from("different"), false, f.access, 1, generated.id)).rejects.toMatchObject({ code: "output_generated_changed" });
});

it("requires the source document and live view, supports discard, and rejects a mismatched output revision", async () => {
  const f = await setup(), body = { revision: 1, html: "<h1>Unsaved</h1>" };
  expect((await f.request("POST", "", body, f.grants.issue("other"))).status).toBe(401);
  expect((await f.request("POST", "", { ...body, revision: 2 })).status).toBe(400);
  const generated = await (await f.request("POST", "", body)).json() as { id: string };
  expect((await f.request("DELETE", `?id=${generated.id}`)).status).toBe(200);
  expect(() => officeGenerated(f.manager.documents).read(generated.id, f.artifact.id, f.access)).toThrow();
  const another = await (await f.request("POST", "", body)).json() as { id: string };
  await f.manager.documents.saveText(f.artifact.id, 1, "<p>Saved later</p>", f.access);
  const plan = f.outputs.prepare(f.artifact.id, 2, "wrong-revision.html", f.access);
  await expect(f.outputs.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, another.id)).rejects.toMatchObject({ code: "output_generated_changed" });
  f.manager.documents.registry.close("html-view", "window");
  expect((await f.request("POST", "", body)).status).toBe(409);
  expect(readFileSync(f.path, "utf8")).toBe("<p>Saved later</p>");
});
