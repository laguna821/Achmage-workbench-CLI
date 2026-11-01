import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { OfficeOutputs } from "./office-output.ts";
import { officeGenerated } from "./office-generated.ts";
const require = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument } = require("pdf-lib");

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-pdf-jobs-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "PDF jobs", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]).drawText("Original structure first page", { x: 30, y: 550, size: 16 });
  pdf.addPage([400, 600]).drawText("Second page must survive", { x: 30, y: 550, size: 16 });
  const original = Buffer.from(await pdf.save()), path = join(work.cwd, "작업 원본.pdf"); writeFileSync(path, original);
  const artifact = manager.openFile(work.id, path), documents = manager.documents;
  const writer = documents.registry.open(artifact.id, { viewId: "writer", windowId: "window", claim: true });
  const access = { viewId: "writer", writeToken: writer.writeToken }, grants = new EditorGrants(), token = grants.issue(artifact.id, access);
  const server = createEditorsServer(documents, grants, null); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, instance = randomUUID();
  const request = (operation: string, args: unknown[], revision = 1, bearer = token, page = instance) => fetch(`${origin}/api/artifacts/${artifact.id}/pdf-structure/${operation}?revision=${revision}&instance=${page}`, { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify(args) });
  const call = async (operation: string, args: unknown[], revision = 1, page = instance) => {
    const response = await request(operation, args, revision, token, page), body = await response.text();
    if (response.status !== 200) throw new Error(body);
    return body.trim().split("\n").map(line => JSON.parse(line)).findLast(line => "result" in line)?.result;
  };
  const outputs = new OfficeOutputs(documents, manager.registerOfficeCopy.bind(manager));
  return { dir, manager, documents, artifact, path, original, access, request, call, outputs,
    async close() { await new Promise<void>(r => server.close(() => r())); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("original PDF structure jobs over document grants", () => {
  beforeAll(() => { execFileSync(process.execPath, [resolve("scripts/build-host.mjs")]); }, 30_000);
  it("runs real child-process analysis/conversion, scopes hashes and preserves the source", async () => {
    const f = await fixture();
    try {
      expect((await f.request("tree", [{ path: f.path, jobId: "bad" }], 1, "forged")).status).toBe(401);
      expect((await f.request("tree", [{ path: join(f.dir, "private.pdf"), jobId: "bad" }])).status).toBe(403);
      const tree = await f.call("tree", [{ path: f.path, jobId: "tree" }]);
      expect(tree).toMatchObject({ ok: true, docHash: createHash("sha256").update(f.original).digest("hex"), cached: false });
      expect(tree.fingerprints).toHaveLength(2);
      expect((await f.call("tree", [{ path: f.path, jobId: "cached" }])).cached).toBe(true);
      expect(JSON.stringify((await f.call("text", [{ path: f.path, jobId: "text" }])).pages)).toContain("Second page must survive");
      expect(await f.call("store-ai-read-pages", ["unknown-hash"])).toMatchObject({ ok: false, error: "not-granted" });
      expect(await f.call("store-ai-read-pages", [tree.docHash], 1, randomUUID())).toMatchObject({ ok: false, error: "not-granted" });
      const converted = await f.call("convert", [{ path: f.path, outPath: join(f.dir, "not-selected.md"), format: "md", jobId: "md" }]);
      expect(converted).toMatchObject({ ok: true, generatedId: expect.any(String) });
      expect(JSON.stringify(converted)).not.toContain("office-generated"); expect(existsSync(join(f.dir, "not-selected.md"))).toBe(false);
      const plan = f.outputs.prepare(f.artifact.id, 1, join(f.dir, "selected.md"), f.access, true);
      const saved = await f.outputs.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, converted.generatedId);
      expect(readFileSync(saved.path, "utf8")).toContain("Original structure first page");
      expect(saved.artifact?.format).toBe("markdown");
      expect(() => officeGenerated(f.documents).read(converted.generatedId, f.artifact.id, f.access)).toThrow();
      expect((await f.outputs.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, converted.generatedId)).artifact?.id).toBe(saved.artifact?.id);
      const restarted = new OfficeOutputs(f.documents, f.manager.registerOfficeCopy.bind(f.manager));
      expect((await restarted.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, converted.generatedId)).artifact?.id).toBe(saved.artifact?.id);
      await expect(restarted.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, randomUUID())).rejects.toMatchObject({ code: "output_generated_changed" });
      await expect(restarted.commit(f.artifact.id, plan.id, Buffer.from("Changed"), false, f.access, 1, converted.generatedId)).rejects.toMatchObject({ code: "output_generated_changed" });
      expect(readFileSync(f.path)).toEqual(f.original); expect(f.documents.get(f.artifact.id).revision).toBe(1);
    } finally { await f.close(); }
  }, 30_000);
  it("keeps original store results and carries unchanged pages to a new immutable revision", async () => {
    const f = await fixture();
    try {
      const tree = await f.call("tree", [{ path: f.path, jobId: "tree" }]);
      expect(tree.ok).toBe(true);
      const hash = tree.docHash, fingerprint = tree.fingerprints[0].fingerprint;
      expect(await f.call("store-write", [{ kind: "aiReadPage", docHash: hash, pageFingerprint: fingerprint, payload: { version: 1, text: "Stored reading" } }])).toEqual({ ok: true });
      expect(await f.call("store-write", [{ kind: "job", docHash: hash, job: { kind: "ai-read", state: "stopped", last_error: "cancelled", outputs: [], progress: { done: 1, total: 2 } } }])).toEqual({ ok: true });
      const pdf = await PDFDocument.load(f.original); pdf.setTitle("Saved while job was running");
      f.documents.savePdfBytes(f.artifact.id, 1, Buffer.from(await pdf.save()), f.access);
      const migrated = await f.call("store-migrate", [{ path: f.path, oldDocHash: hash }], 2);
      expect(migrated).toMatchObject({ ok: true, aiReadPages: 1, jobs: 1 }); expect(migrated.docHash).not.toBe(hash);
      expect(await f.call("store-ai-read-pages", [migrated.docHash], 2)).toMatchObject({ ok: true, pages: [{ payload: { text: "Stored reading" } }] });
      expect(await f.call("store-unfinished-jobs", [migrated.docHash], 2)).toMatchObject({ ok: true, jobs: [{ kind: "ai-read", state: "stopped" }] });
      expect(readFileSync(f.documents.revisionPath(f.artifact.id, 1))).toEqual(f.original);
      f.documents.registry.close("writer", "window");
      expect((await f.request("store-ai-read-pages", [hash])).status).toBe(409);
    } finally { await f.close(); }
  }, 30_000);
  it("publishes staged Markdown assets only with the chosen view and unchanged destination", async () => {
    const f = await fixture();
    try {
      const staging = officeGenerated(f.documents).create(f.artifact.id, 1, "writer", "md");
      mkdirSync(join(staging.directory, "assets"));
      const picture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64");
      writeFileSync(join(staging.directory, "assets", "page.png"), picture);
      writeFileSync(staging.path, "# Converted\n![figure](assets/page.png)\n");
      const target = join(f.dir, "result.md"), plan = f.outputs.prepare(f.artifact.id, 1, target, f.access, true);
      const reader = f.documents.registry.open(f.artifact.id, { viewId: "reader", windowId: "other", claim: false });
      const otherPlan = f.outputs.prepare(f.artifact.id, 1, join(f.dir, "other.md"), { viewId: "reader", writeToken: reader.writeToken }, true);
      await expect(f.outputs.commit(f.artifact.id, otherPlan.id, Buffer.alloc(0), false, { viewId: "reader", writeToken: reader.writeToken }, 1, staging.id)).rejects.toMatchObject({ code: "output_generated_scope" });
      writeFileSync(target, "External file appeared");
      await expect(f.outputs.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, staging.id)).rejects.toMatchObject({ code: "output_changed" });
      expect(readFileSync(target, "utf8")).toBe("External file appeared");
      const retry = f.outputs.prepare(f.artifact.id, 1, join(f.dir, "result-2.md"), f.access, true);
      const result = await f.outputs.commit(f.artifact.id, retry.id, Buffer.alloc(0), false, f.access, 1, staging.id);
      const text = readFileSync(result.path, "utf8"), imagePath = /!\[figure\]\(([^)]+)\)/.exec(text)![1]!;
      expect(readFileSync(resolve(dirname(result.path), imagePath))).toEqual(picture);
      expect(readFileSync(f.path)).toEqual(f.original);
    } finally { await f.close(); }
  });
  it("recovers publication after registration was interrupted without requiring private staging", async () => {
    const f = await fixture();
    try {
      const staged = officeGenerated(f.documents).create(f.artifact.id, 1, "writer", "md");
      writeFileSync(staged.path, "# Durable generated output\n");
      const outputs = new OfficeOutputs(f.documents, () => { throw new Error("Registration interrupted"); });
      const plan = outputs.prepare(f.artifact.id, 1, join(f.dir, "recovered.md"), f.access, true);
      await expect(outputs.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, staged.id)).rejects.toThrow("Registration interrupted");
      officeGenerated(f.documents).discard(staged.id);
      const restarted = new OfficeOutputs(f.documents, f.manager.registerOfficeCopy.bind(f.manager));
      const saved = await restarted.commit(f.artifact.id, plan.id, Buffer.alloc(0), false, f.access, 1, staged.id);
      expect(saved.artifact?.format).toBe("markdown");
      expect(readFileSync(saved.path, "utf8")).toBe("# Durable generated output\n");
      expect(readFileSync(f.path)).toEqual(f.original);
    } finally { await f.close(); }
  });
});
