import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "../store.ts";
import { EventBus } from "../bus.ts";
import { SessionManager } from "../sessions.ts";
import { EditorGrants } from "../editors.ts";
import { OfficeRendererExecutors } from "./renderer.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const done of cleanup.splice(0)) await done(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-original-executor-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "문서 실행기" }), path = join(work.cwd, "note.md"); writeFileSync(path, "before\n");
  const artifact = manager.openFile(work.id, path), main = manager.createSession(work.id, { provider: "claude" });
  const session = manager.createSession(work.id, { provider: "claude" });
  const view = manager.documents.registry.open(artifact.id, { viewId: "ui", windowId: "window", sessionId: session.id, claim: true });
  const grants = new EditorGrants(), access = { viewId: "ui", writeToken: view.writeToken }, token = grants.issue(artifact.id, access, session.id);
  const binding = { artifactId: artifact.id, sessionId: session.id, owner: `${artifact.id}:${grants.previewInfo(token).baseUrl}`, access };
  const launches: { url: string; child: EventEmitter & { stdin: PassThrough; unref(): void } }[] = [];
  const executors = new OfficeRendererExecutors(manager.documents, manager.office, grants, { launch: url => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), unref() {} }); launches.push({ url, child }); return child;
  } });
  executors.bind("http://127.0.0.1:12345");
  const payload = { instruction: "고쳐줘", state: { format: "markdown", snapshot: { body: "before", frontmatter: "" }, document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }] }, selection: { type: "text", anchor: 1, head: 7 }, scope: null } };
  const start = async (turnId = "run") => {
    await manager.office.start(binding, { turnId, instruction: "고쳐줘", revision: manager.documents.get(artifact.id).revision });
    executors.start(binding, turnId, token, payload);
    return new URL(launches.at(-1)!.url).hash.slice(1);
  };
  cleanup.push(async () => { executors.close(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, artifact, session, main, binding, grants, token, path, executors, launches, payload, start };
}

it("hands off once, keeps original selection, answers the original question after UI loss and saves in the same turn", async () => {
  const f = fixture(), capability = await f.start(), boot = f.executors.boot(capability);
  expect(boot.state.selection).toEqual(f.payload.state.selection);
  expect(boot.init.execution?.turnId).toBe("run");
  expect(() => f.executors.boot(capability)).toThrow(/이미 사용/);
  expect(() => f.executors.start(f.binding, "run", f.token, f.payload)).toThrow(/이미 인계/);
  await expect(f.manager.documents.saveText(f.artifact.id, 1, "visible stale", f.binding.access)).rejects.toThrow();
  f.manager.documents.registry.close("ui", "window"); f.manager.office.reconcileViews();
  const bound = { ...f.binding, access: f.grants.access(boot.init.token) };
  f.manager.office.question(bound, { turnId: "run", id: "partial", prompt: "작성한 부분을 유지할까요?" });
  expect(f.manager.view.sessions.get(f.session.id)?.status).toBe("awaitingApproval");
  expect(f.manager.view.sessions.get(f.main.id)?.status).toBe("idle");
  await f.manager.answerApproval(f.session.id, "office-question:run:partial", "accept");
  expect(f.manager.office.question(bound, { turnId: "run", id: "partial" }).decision).toBe("accept");
  await f.manager.documents.saveText(f.artifact.id, 1, "from original serializer\n", bound.access);
  f.manager.office.events(bound, { turnId: "run", seq: 1, events: [{ kind: "assistant", id: "answer", text: "완료", streaming: false }] });
  f.manager.office.finish(bound, { turnId: "run", status: "completed" });
  expect(readFileSync(f.path, "utf8")).toBe("from original serializer\n");
  expect(f.manager.office.observe(f.binding, "run").receipt.status).toBe("completed");
  expect(f.manager.items(f.session.id).items.filter(item => item.kind === "user")).toHaveLength(1);
  expect(f.manager.items(f.session.id).items.filter(item => item.kind === "turnEnd")).toHaveLength(1);
  expect(f.grants.allows(boot.init.token, f.artifact.id)).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 110));
  expect(f.launches[0]!.child.stdin.writableEnded).toBe(true);
});

it("interrupts a lost owner without replay or surviving approvals", async () => {
  const f = fixture(), capability = await f.start(); f.executors.boot(capability);
  f.manager.office.question(f.binding, { turnId: "run", id: "ask", prompt: "유지할까요?" });
  f.launches[0]!.child.emit("exit", 1);
  expect(f.manager.office.observe(f.binding, "run").receipt.status).toBe("interrupted");
  expect(f.manager.items(f.session.id).items.find(item => item.kind === "approval")).toMatchObject({ decision: "expired" });
  expect(f.launches).toHaveLength(1);
  expect(() => f.executors.boot(capability)).toThrow();
});
