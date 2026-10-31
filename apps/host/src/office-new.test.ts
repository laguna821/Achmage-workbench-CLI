import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { BLANK_OFFICE_DOCUMENTS } from "@workbench/contracts";
import { hwpToText } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { inspectMindmap, mindmapText } from "./mindmap-ops.mjs";
import { inspectPdf } from "./pdf-ops.mjs";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-new-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "여기", managedWorksDir: join(dir, "works") });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "빈 문서" });
  const session = manager.createSession(work.id, { provider: "codex" });
  return { dir, manager, store, work, session };
}

for (const kind of BLANK_OFFICE_DOCUMENTS) it(`creates a real blank ${kind.format} using the original builder and records its session`, async () => {
  const { manager, store, work, session } = setup();
  const artifact = await manager.createOfficeDocument(work.id, { format: kind.format, sessionId: session.id });
  expect(artifact).toMatchObject({ workId: work.id, workspaceId: session.workspaceId, format: kind.format, revision: 1 });
  expect(dirname(artifact.path)).toBe(work.cwd);
  expect(store.revisions(artifact.id)[0]).toMatchObject({ author: "user", sessionId: session.id });
  const bytes = readFileSync(artifact.path);
  if (kind.format === "markdown" || kind.format === "html") expect(bytes.length).toBe(0);
  else if (kind.format === "hwpx") expect((await hwpToText(bytes)).trim()).toBe("");
  else if (kind.format === "pdf") expect(await inspectPdf(bytes)).toMatchObject({ pages: 1, encrypted: false });
  else if (kind.format === "xmind") { expect(await inspectMindmap(bytes)).toBe("ok"); expect(await mindmapText(bytes)).toContain("중심 주제"); }
  else {
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    if (kind.format === "docx") expect(await zip.file("word/document.xml")!.async("string")).toContain("w:sectPr");
    if (kind.format === "pptx") expect((await zip.file("ppt/presentation.xml")!.async("string")).match(/<p:sldId\s/g)).toHaveLength(1);
    if (kind.format === "xlsx") expect(await zip.file("xl/workbook.xml")!.async("string")).toContain('name="Sheet1"');
  }
  expect(manager.openFile(work.id, artifact.path, session.workspaceId, session.id).id).toBe(artifact.id);
  expect(store.revisions(artifact.id)).toHaveLength(1);
});

it("creates in the selected workspace and never overwrites a name, including concurrent requests", async () => {
  const { manager, work, session, dir } = setup();
  const cwd = join(dir, "second"); mkdirSync(cwd);
  const workspace = manager.createWorkspace(work.id, { cwd, label: "두 번째" });
  const other = manager.createSession(work.id, { provider: "claude", workspaceId: workspace.id });
  const original = join(cwd, "빈 문서.docx"); writeFileSync(original, "keep existing bytes");
  const docs = await Promise.all(Array.from({ length: 3 }, () => manager.createOfficeDocument(work.id, { format: "docx", name: "빈 문서.docx", workspaceId: workspace.id, sessionId: other.id })));
  expect(new Set(docs.map((doc) => doc.path)).size).toBe(3);
  expect(docs.map((doc) => basename(doc.path)).sort()).toEqual(["빈 문서 2.docx", "빈 문서 3.docx", "빈 문서 4.docx"]);
  expect(readFileSync(original, "utf8")).toBe("keep existing bytes");
  for (const doc of docs) expect(doc.workspaceId).toBe(workspace.id);
  const before = readdirSync(cwd);
  await expect(manager.createOfficeDocument(work.id, { format: "docx", workspaceId: workspace.id, sessionId: session.id })).rejects.toMatchObject({ code: "document_session_scope" });
  expect(readdirSync(cwd)).toEqual(before);
});

it("rejects a foreign session or unsupported type before writing, and contains file names", async () => {
  const { manager, work, session } = setup();
  const other = manager.createWork({ title: "다른 프로젝트" }), before = readdirSync(other.cwd);
  await expect(manager.createOfficeDocument(other.id, { format: "docx", sessionId: session.id })).rejects.toMatchObject({ code: "document_session_scope" });
  await expect(manager.createOfficeDocument(other.id, { format: "epub" as never })).rejects.toMatchObject({ code: "invalid_document_format" });
  expect(readdirSync(other.cwd)).toEqual(before);
  const doc = await manager.createOfficeDocument(work.id, { format: "markdown", name: "../../파일.md" });
  expect(dirname(doc.path)).toBe(work.cwd);
  const opened = join(other.cwd, "other.md"); writeFileSync(opened, "other");
  expect(() => manager.openFile(other.id, opened, other.defaultWorkspaceId, session.id)).toThrow("작업공간이 다릅니다");
});
