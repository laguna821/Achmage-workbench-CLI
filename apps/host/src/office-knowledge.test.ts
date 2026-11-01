import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { OfficeKnowledge } from "./office-knowledge.mjs";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { EditorGrants } from "./editors.ts";
import type { KnowledgeHit, KnowledgeLibrary } from "../../../packages/contracts/src/office-knowledge.ts";
import type { IeumOffice } from "./ieumoffice.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-knowledge-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "Knowledge" }), session = manager.createSession(work.id, { provider: "codex" });
  const library = new OfficeKnowledge(dir, manager);
  const write = (name: string, text: string) => { const path = join(dir, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
  const tool = <T>(name: string, args: unknown[] = []) => library.tool(`knowledge-${name}`, args, new AbortController().signal) as Promise<T>;
  return { dir, manager, work, session, library, write, tool, close: async () => { library.close(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it("uses the original global starred store, Korean FTS and redacted paging without editing sources", async () => {
  const f = fixture();
  try {
    const original = '---\r\n"DIKM_단계:": ""\r\ntags: [Workflow_Engineering]\r\n---\r\n# 교육 연구\r\n\r\n한림 교육 연구 자료입니다. <span class="redact-span" data-redaction="" data-label="가림">HIDDEN_KNOWLEDGE_SECRET</span>\r\n';
    const path = f.write("external/연구.md", original), long = f.write("external/Long.md", "x".repeat(24500));
    await f.library.manage("add", { paths: [path, path, long], group: "연구" });
    const list = f.library.library(); expect(list.items).toHaveLength(2); expect(list.groups).toEqual(["연구"]);
    const hits = await f.tool<KnowledgeHit[]>("search", ["교육 연구", 8]); expect(hits.map(hit => hit.path)).toContain(path);
    expect(JSON.stringify(hits)).not.toContain("HIDDEN_KNOWLEDGE_SECRET");
    const page = await f.tool<{ text: string }>("read", [path, 0]); expect(page.text).toContain("교육 연구"); expect(page.text).not.toContain("HIDDEN_KNOWLEDGE_SECRET");
    const tail = await f.tool<{ text: string; offset: number; totalChars: number }>("read", [long, 24000]); expect(tail).toEqual({ text: "x".repeat(500), offset: 24000, totalChars: 24500 });
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally { await f.close(); }
});

it("retains groups and missing entries, but excludes deleted/unstarred/replaced files from AI", async () => {
  const f = fixture();
  try {
    const a = f.write("A.md", "ORIGINAL_DATA"), b = f.write("B.md", "ORIGINAL_DATA"), privatePath = f.write("private.md", "PRIVATE_SECRET");
    await f.library.manage("add", { paths: [a, b] }); await f.library.manage("group", { paths: [b], group: "Group" });
    expect((await f.library.manage("search", { query: "ORIGINAL_DATA", group: "Group" }) as KnowledgeHit[]).map(hit => hit.path)).toEqual([b]);
    unlinkSync(a); symlinkSync(privatePath, a); unlinkSync(b);
    expect(f.library.library().items.every(item => item.missing)).toBe(true);
    expect(await f.tool("list")).toEqual([]); expect(await f.tool("search", ["PRIVATE_SECRET", 8])).toEqual([]);
    await expect(f.tool("read", [a, 0])).rejects.toMatchObject({ code: "office_knowledge_scope" });
    await f.library.manage("remove", { paths: [b] }); expect(f.library.library().groups).toEqual([]);
    const persisted = new OfficeKnowledge(f.dir, f.manager);
    try { expect(persisted.library().items).toHaveLength(1); } finally { persisted.close(); }
    expect(readFileSync(privatePath, "utf8")).toBe("PRIVATE_SECRET");
  } finally { await f.close(); }
});

it("never quotes a dirty editor's old index and refreshes a newly saved withholding mark", async () => {
  const f = fixture();
  try {
    const path = f.write("Source.md", "BEFORE_SECRET"), artifact = f.manager.openFile(f.work.id, path);
    await f.library.manage("add", { paths: [path] }); expect(await f.tool<KnowledgeHit[]>("search", ["BEFORE_SECRET", 8])).toHaveLength(1);
    const view = f.manager.documents.registry.open(artifact.id, { viewId: "dirty", windowId: "window", claim: true });
    f.manager.documents.registry.open(artifact.id, { viewId: "dirty", windowId: "window", dirty: true });
    expect(await f.tool("search", ["BEFORE_SECRET", 8])).toEqual([]);
    await expect(f.tool("read", [path, 0])).rejects.toThrow();
    writeFileSync(path, '<span class="redact-span" data-redaction="" data-label="가림">BEFORE_SECRET</span>\nVISIBLE AFTER\n');
    f.manager.documents.registry.open(artifact.id, { viewId: "dirty", windowId: "window", dirty: false });
    expect(await f.tool("search", ["BEFORE_SECRET", 8])).toEqual([]);
    expect(await f.tool<KnowledgeHit[]>("search", ["VISIBLE AFTER", 8])).toHaveLength(1);
    expect(view.writeToken).toBeTruthy();
  } finally { await f.close(); }
});

it("opens a selected citation in its actual workspace and rejects stale source grants or cancellation", async () => {
  const f = fixture();
  try {
    const source = join(f.work.cwd, "source.md"), target = f.write("outside/target.md", "citation");
    writeFileSync(source, "source");
    const artifact = f.manager.openFile(f.work.id, source, f.work.defaultWorkspaceId, f.session.id), grants = new EditorGrants();
    const view = f.manager.documents.registry.open(artifact.id, { viewId: "view", windowId: "window", claim: true, sessionId: f.session.id });
    const token = grants.issue(artifact.id, { viewId: "view", writeToken: view.writeToken }, f.session.id);
    await f.library.manage("add", { paths: [target] });
    const opened = f.library.open(artifact.id, token, grants, target);
    expect(f.manager.documents.get(opened.artifactId)).toMatchObject({ path: target, workId: f.work.id });
    expect(f.manager.documents.get(opened.artifactId).workspaceId).not.toBe(f.work.defaultWorkspaceId);
    expect(() => f.library.open(artifact.id, token, grants, source)).toThrow();
    f.manager.documents.registry.open(artifact.id, { viewId: "view", windowId: "window", sessionId: null });
    expect(() => f.library.open(artifact.id, token, grants, target)).toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(f.library.tool("knowledge-read", [target, 0], controller.signal)).rejects.toThrow();
  } finally { await f.close(); }
});

it("reads the legacy flat star list without rewriting it until a deliberate metadata change", async () => {
  const f = fixture();
  try {
    const path = f.write("Legacy.md", "legacy"), original = JSON.stringify([path]); writeFileSync(f.library.path, original);
    expect(f.library.library().items[0]?.path).toBe(path); expect(readFileSync(f.library.path, "utf8")).toBe(original);
    const library = await f.library.manage("group", { paths: [path], group: "Legacy" }) as KnowledgeLibrary;
    expect(library.groups).toEqual(["Legacy"]); expect(JSON.parse(readFileSync(f.library.path, "utf8"))).toEqual({ version: 1, items: [{ path, group: "Legacy" }] });
  } finally { await f.close(); }
});

it("keeps each original home group scope current, private to its owner, and closed after the run", async () => {
  const f = fixture();
  try {
    const a = f.write("Research.md", "그룹 공통 키워드 RESEARCH_ONLY"), b = f.write("Personal.md", "그룹 공통 키워드 PERSONAL_ONLY");
    await f.library.manage("add", { paths: [a], group: "연구" }); await f.library.manage("add", { paths: [b], group: "개인" });
    const home = f.library.home, one = home.open(), two = home.open(), signal = new AbortController().signal;
    const call = (owner: string, channel: string, raw?: unknown) => home.invoke(owner, channel, raw === undefined ? [] : [raw], undefined, signal);
    const scope = await call(one, "kb:open-scope", "연구");
    expect(await call(one, "kb:list", { scope })).toEqual([expect.objectContaining({ path: a })]);
    expect((await call(one, "kb:search", { q: "키워드", scope }) as KnowledgeHit[]).map(hit => hit.path)).toEqual([a]);
    await expect(call(one, "kb:read", { path: b, scope })).rejects.toThrow();
    await expect(call(two, "kb:list", { scope })).rejects.toThrow();
    await call(two, "kb:close-scope", scope); // Another home cannot close this run.
    expect(await call(one, "kb:read", { path: a, scope })).toMatchObject({ text: expect.stringContaining("RESEARCH_ONLY") });
    await f.library.manage("group", { paths: [a], group: "개인" });
    expect(await call(one, "kb:list", { scope })).toEqual([]);
    await expect(call(one, "kb:read", { path: a, scope })).rejects.toThrow();
    await expect(call(one, "kb:open-scope", "연구")).rejects.toThrow();
    await call(one, "kb:close-scope", scope);
    await expect(call(one, "kb:list", { scope })).rejects.toThrow();
    home.close(one); await expect(call(one, "kb:list")).rejects.toThrow();
    expect(await call(two, "kb:list")).toHaveLength(2);
  } finally { await f.close(); }
});

it("saves home answers to the selected workspace without overwriting sources or inventing a chat", async () => {
  const f = fixture();
  try {
    const project = f.manager.createWork({ title: "다른 프로젝트" }), home = f.library.home, owner = home.open(), signal = new AbortController().signal;
    const original = join(project.cwd, "답변.md"); writeFileSync(original, "PRESERVE ORIGINAL");
    const sessions = f.manager.snapshot().sessions.length, content = '# 답변\r\n\r\n| 한글 | 값 |\r\n|---|---|\r\n| 자료 | 그대로 |\r\n';
    const destination = { workId: project.id, workspaceId: project.defaultWorkspaceId };
    const save = (format: string) => home.invoke(owner, "kb:create-document", [{ title: "답변", format, content }], destination, signal);
    const result = await save("md") as { path: string; artifactId: string };
    expect(result.path).toBe(join(project.cwd, "답변 2.md"));
    expect(readFileSync(result.path, "utf8")).toBe(content); expect(readFileSync(original, "utf8")).toBe("PRESERVE ORIGINAL");
    expect(f.manager.documents.get(result.artifactId)).toMatchObject({ workId: project.id, workspaceId: project.defaultWorkspaceId, revision: 1 });
    expect(f.manager.snapshot().sessions.length).toBe(sessions);
    expect(await home.invoke(owner, "home:open-path", [result.path], undefined, signal)).toMatchObject({ id: result.artifactId });
    const other = home.open();
    await expect(home.invoke(other, "home:open-path", [result.path], destination, signal)).rejects.toThrow();
    await expect(home.invoke(owner, "kb:create-document", [{ title: "Bad", format: "md", content }], { workId: project.id, workspaceId: f.work.defaultWorkspaceId }, signal)).rejects.toThrow();
    expect(readdirSync(project.cwd).filter(name => name.startsWith("Bad"))).toEqual([]);
    await expect(save("pdf")).rejects.toThrow();
  } finally { await f.close(); }
});

it("stages the original DOCX CLI request and cancels an in-flight creation before publishing any file", async () => {
  const f = fixture();
  try {
    const home = f.library.home, owner = home.open(), destination = { workId: f.work.id };
    let started = false, cancelled = false, stagedInput = "";
    f.manager.documents.ieum = { available: true, run: async (args: string[], _roots: string[], _timeout: number, signal: AbortSignal) => {
      started = true; stagedInput = readFileSync(args[args.indexOf("--from") + 1]!, "utf8");
      expect(args.slice(0, 3)).toEqual(["create", "--type", "docx"]);
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled CLI")); }, { once: true }));
      return { status: "ok" };
    } } as unknown as IeumOffice;
    const pending = home.invoke(owner, "kb:create-document", [{ title: "취소", format: "docx", content: "# 원본 입력" }], destination, new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("cancelled CLI");
    await expect.poll(() => started).toBe(true);
    home.cancel(owner); await rejected;
    expect(cancelled).toBe(true); expect(stagedInput).toBe("# 원본 입력");
    expect(existsSync(join(f.work.cwd, "취소.docx"))).toBe(false);
    expect(readdirSync(join(f.dir, "office", "knowledge", "generated"))).toEqual([]);
    const after = await home.invoke(owner, "kb:create-document", [{ title: "다음", format: "md", content: "다음 요청은 사용 가능" }], destination, new AbortController().signal) as { path: string };
    expect(readFileSync(after.path, "utf8")).toBe("다음 요청은 사용 가능");
  } finally { await f.close(); }
});
