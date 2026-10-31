import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { EditorGrants } from "./editors.ts";
import { OfficeWiki } from "./office-wiki.ts";
import type { WikiGraph, WikiLink, WikiBacklink } from "../../../packages/contracts/src/office-wiki.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-wiki-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "Wiki" }), session = manager.createSession(work.id, { provider: "codex" });
  const write = (path: string, text: string) => { const file = join(work.cwd, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  const source = write("sub/A.md", '---\r\n"DIKM_단계:": ""\r\ntags: [Workflow_Engineering]\r\nunknown: null\r\n---\r\n# Source\r\n[[B#Target]]\r\n');
  const artifact = manager.openFile(work.id, source, work.defaultWorkspaceId, session.id), grants = new EditorGrants();
  const bind = (id: string, conversation = session.id, viewId = `view-${id}`) => {
    const view = manager.documents.registry.open(id, { viewId, windowId: "window", sessionId: conversation, claim: true });
    return grants.issue(id, { viewId, writeToken: view.writeToken }, conversation);
  };
  const token = bind(artifact.id), wiki = new OfficeWiki(manager);
  const call = <T = unknown>(action: string, input: Record<string, unknown> = {}) => wiki.action(artifact.id, token, grants, action, input) as Promise<T>;
  return { dir, manager, work, session, artifact, source, grants, token, wiki, write, bind, call, close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it("reuses nearest-note, root path and heading/block resolution without changing source metadata", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.source), local = f.write("sub/B.md", "# Target\nBlock ^point\n"), root = f.write("B.md", "root");
    const result = await f.call<Record<string, WikiLink>>("resolve", { targets: ["B#Target", "B#^point", "#Source", "Missing", "../B", "B.md"], fromPath: root });
    expect(result["B#Target"]).toEqual({ path: local, fragment: "Target", found: true });
    expect(result["B#^point"]).toMatchObject({ path: local, fragment: "^point" });
    expect(result["#Source"]).toEqual({ path: f.source, fragment: "Source", found: true });
    expect(result.Missing?.found).toBe(false); expect(result["../B"]?.found).toBe(false);
    expect(readFileSync(f.source)).toEqual(before);
  } finally { await f.close(); }
});

it("uses original backlinks and graph, ignoring code and updating created/deleted targets", async () => {
  const f = fixture();
  try {
    const from = f.write("Refer.md", "[[sub/A#Source]]\n`[[Hidden]]`\n```md\n[[Ghost]]\n```\n"), orphan = f.write("Orphan.md", "alone");
    expect(await f.call<WikiBacklink[]>("backlinks")).toEqual([{ source: from, target: "sub/A#Source" }]);
    const graph = await f.call<WikiGraph>("graph");
    expect(graph.nodes.map(node => node.path)).toContain(orphan); expect(graph.edges).toContainEqual({ from, to: f.source });
    expect(graph.nodes).toHaveLength(3); expect(graph.truncated).toBe(false);
    const target = f.write("sub/B.md", "new");
    expect((await f.call<WikiGraph>("graph")).edges).toContainEqual({ from: f.source, to: target });
    unlinkSync(target);
    expect((await f.call<WikiGraph>("graph")).edges).not.toContainEqual({ from: f.source, to: target });
  } finally { await f.close(); }
});

it("refuses traversal, outside links and internal metadata while retaining the legitimate project note", async () => {
  const f = fixture();
  try {
    const outside = join(f.dir, "outside.md"); writeFileSync(outside, "PRIVATE");
    symlinkSync(outside, join(f.work.cwd, "escape.md")); symlinkSync(f.dir, join(f.work.cwd, "escape-dir"));
    const hidden = f.write(".git/hidden.md", "PRIVATE"); symlinkSync(hidden, join(f.work.cwd, "hidden-link.md"));
    f.write(".workbench/state.md", "PRIVATE"); const project = f.write(".workbench/project.md", "PROJECT");
    const links = await f.call<Record<string, WikiLink>>("resolve", { targets: ["escape", "escape-dir/outside", "hidden-link", ".git/hidden", ".workbench/state", ".workbench/project"] });
    expect(Object.entries(links).filter(([, value]) => value.found).map(([key]) => key)).toEqual([".workbench/project"]);
    const graph = await f.call<WikiGraph>("graph"); expect(graph.nodes.map(node => node.path)).toEqual(expect.arrayContaining([f.source, project]));
    expect(graph.nodes).toHaveLength(2);
    for (const path of [outside, hidden, join(f.work.cwd, "escape.md")]) await expect(f.call("open", { path, fragment: "" })).rejects.toMatchObject({ code: "office_wiki_scope" });
    expect(readFileSync(outside, "utf8")).toBe("PRIVATE");
  } finally { await f.close(); }
});

it("registers a link in the same workspace/session and consumes its fragment only there", async () => {
  const f = fixture();
  try {
    const path = f.write("B.md", "# Destination\n");
    const result = await f.call<{ artifactId: string }>("open", { path, fragment: "Destination" });
    const target = f.manager.documents.get(result.artifactId);
    expect(target).toMatchObject({ workId: f.work.id, workspaceId: f.artifact.workspaceId, path });
    const other = f.manager.createSession(f.work.id, { provider: "codex" });
    expect(await f.wiki.action(target.id, f.bind(target.id, other.id, "other"), f.grants, "take-fragment", {})).toBe("");
    const token = f.bind(target.id);
    expect(await f.wiki.action(target.id, token, f.grants, "take-fragment", {})).toBe("Destination");
    expect(await f.wiki.action(target.id, token, f.grants, "take-fragment", {})).toBe("");
  } finally { await f.close(); }
});

it("rejects foreign, stale and malformed requests even if the path is in the project", async () => {
  const f = fixture();
  try {
    await expect(f.wiki.action(f.artifact.id, "forged", f.grants, "graph", {})).rejects.toMatchObject({ code: "office_wiki_scope" });
    const other = f.manager.openFile(f.work.id, f.write("Other.md", "OTHER"));
    await expect(f.wiki.action(other.id, f.token, f.grants, "graph", {})).rejects.toMatchObject({ code: "office_wiki_scope" });
    await expect(f.call("resolve", { targets: [42] })).rejects.toMatchObject({ code: "office_wiki" });
    await expect(f.call("resolve", { targets: Array(501).fill("A") })).rejects.toMatchObject({ code: "office_wiki" });
    const next = f.manager.createSession(f.work.id, { provider: "codex" }); f.bind(f.artifact.id, next.id);
    await expect(f.call("graph")).rejects.toMatchObject({ code: "office_wiki_scope" });
  } finally { await f.close(); }
});
