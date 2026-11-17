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
import { OfficeExecutorOutputs } from "./output.ts";
import { OfficeOutputs } from "../office-output.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const done of cleanup.splice(0)) await done(); });
type FixtureOptions = Partial<ConstructorParameters<typeof OfficeRendererExecutors>[3]>;
function fixture(extra: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-original-executor-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "문서 실행기" }), path = join(work.cwd, "note.md"); writeFileSync(path, "before\n");
  const artifact = manager.openFile(work.id, path), main = manager.createSession(work.id, { provider: "claude" });
  const session = manager.createSession(work.id, { provider: "claude" });
  const view = manager.documents.registry.open(artifact.id, { viewId: "ui", windowId: "window", sessionId: session.id, claim: true });
  const grants = new EditorGrants(), access = { viewId: "ui", writeToken: view.writeToken }, token = grants.issue(artifact.id, access, session.id);
  const binding = { artifactId: artifact.id, sessionId: session.id, owner: `${artifact.id}:${grants.previewInfo(token).baseUrl}`, access };
  const launches: { url: string; env: NodeJS.ProcessEnv; child: EventEmitter & { stdin: PassThrough; stderr: PassThrough; unref(): void } }[] = [];
  const executors = new OfficeRendererExecutors(manager.documents, manager.office, grants, { launch: (url, env) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), unref() {} }); launches.push({ url, env, child }); return child;
  }, ...extra });
  executors.bind("http://127.0.0.1:12345");
  const payload = { instruction: "고쳐줘", state: { format: "markdown", snapshot: { body: "before", frontmatter: "" }, document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }] }, selection: { type: "text", anchor: 1, head: 7 }, scope: null } };
  const start = async (turnId = "run") => {
    await manager.office.start(binding, { turnId, instruction: "고쳐줘", revision: manager.documents.get(artifact.id).revision });
    executors.start(binding, turnId, token, payload);
    return launches.length ? new URL(launches.at(-1)!.url).hash.slice(1) : "";
  };
  cleanup.push(async () => { executors.close(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, artifact, session, main, binding, grants, token, path, executors, launches, payload, start };
}

it("hands off once, keeps original selection, answers the original question after UI loss and saves in the same turn", async () => {
  const f = fixture(), capability = await f.start(), boot = f.executors.boot(capability);
  expect(boot.state.format === "markdown" && boot.state.selection).toEqual(f.payload.state.selection);
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

it("keeps structured original questions pending until valid answers arrive from the observed conversation", async () => {
  const f = fixture(), capability = await f.start(), boot = f.executors.boot(capability);
  f.manager.documents.registry.close("ui", "window");
  const bound = { ...f.binding, access: f.grants.access(boot.init.token) };
  f.manager.office.question(bound, { turnId: "run", id: "brief", prompt: "문서를 어떻게 만들까요?", fields: [
    { id: "audience", prompt: "대상", options: [{ id: "student", label: "학생" }, { id: "expert", label: "전문가" }] },
    { id: "sections", prompt: "내용", multiple: true, options: [{ id: "intro", label: "소개" }, { id: "data", label: "자료" }] },
    { id: "note", prompt: "추가 요청" },
  ] });
  const itemId = "office-question:run:brief";
  await expect(f.manager.answerApproval(f.session.id, itemId, "accept")).rejects.toThrow(/질문과 답변/);
  await expect(f.manager.answerApproval(f.session.id, itemId, "accept", { audience: "invented", sections: ["data"], note: "표 포함" })).rejects.toThrow();
  expect(f.manager.office.question(bound, { turnId: "run", id: "brief" }).decision).toBeNull();
  const response = { audience: "student", sections: ["intro", "data"], note: "표와 그림 포함" };
  await f.manager.answerApproval(f.session.id, itemId, "accept", response);
  expect(f.manager.office.question(bound, { turnId: "run", id: "brief" })).toMatchObject({ decision: "accept", response });
  expect(f.manager.office.observe(f.binding, "run").items.find(item => item.id === itemId)).toMatchObject({ officeInteraction: { response } });
  await expect(f.manager.answerApproval(f.session.id, itemId, "decline")).rejects.toThrow(/이미 끝난/);
  f.manager.office.finish(bound, { turnId: "run", status: "completed" });
});

it("saves original output under the independent owner only after the observed path and replacement questions", async () => {
  const f = fixture(), capability = await f.start(), boot = f.executors.boot(capability);
  const bound = { ...f.binding, access: f.grants.access(boot.init.token) };
  const outputs = new OfficeExecutorOutputs(f.manager.documents, f.manager.office, new OfficeOutputs(f.manager.documents, (...args) => f.manager.registerOfficeCopy(...args)));
  const destination = join(f.path, "..", "result.md"); writeFileSync(destination, "# previous");
  f.manager.documents.registry.close("ui", "window");
  const request = { requestId: "save", revision: 1, format: "md", defaultName: "result.md" };
  expect(outputs.prepare(bound, "run", request)).toEqual({ pending: true });
  await f.manager.answerApproval(f.session.id, "office-question:run:output_save", "accept", { path: "result.md" });
  expect(outputs.prepare(bound, "run", request)).toEqual({ pending: true });
  expect(readFileSync(destination, "utf8")).toBe("# previous");
  await f.manager.answerApproval(f.session.id, "office-question:run:output_save_replace", "accept");
  const plan = outputs.prepare(bound, "run", request);
  if (!plan || !("id" in plan)) throw new Error("no approved output");
  const saved = await outputs.commit(bound, "run", plan.id, Buffer.from("# original serializer result"));
  expect(saved.path).toBe(destination); expect(saved.artifactId).toBeTruthy();
  expect(readFileSync(destination, "utf8")).toBe("# original serializer result");
  expect(readFileSync(f.path, "utf8")).toBe("before\n");
  f.manager.office.finish(bound, { turnId: "run", status: "completed" });
});

const notices = (f: ReturnType<typeof fixture>) => f.manager.items(f.session.id).items.filter(item => item.kind === "notice").map(item => item.kind === "notice" ? item.text : "");

it("starts the executor with the display the session knows when the gateway has none", async () => {
  const f = fixture({ platform: "linux", environment: base => ({ ...base, WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" }) });
  await f.start();
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]!.env).toMatchObject({ WAYLAND_DISPLAY: "wayland-1" });
  expect(f.launches[0]!.env.WORKBENCH_OFFICE_EXECUTOR_URL).toBe(f.launches[0]!.url);
  expect(f.launches[0]!.env.WORKBENCH_TOKEN).toBeUndefined();
});

it("waits a bounded time for a screen, then fails with one true sentence and starts nothing", async () => {
  const lines: string[] = [];
  const f = fixture({ platform: "linux", environment: base => { const out = { ...base }; delete out.WAYLAND_DISPLAY; delete out.DISPLAY; return out; },
    displayWaitMs: 120, displayPollMs: 20, log: line => lines.push(line) });
  await f.start();
  expect(f.manager.office.observe(f.binding, "run").receipt.status).toBe("running");
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(f.launches).toHaveLength(0);
  expect(f.manager.office.observe(f.binding, "run").receipt.status).toBe("failed");
  expect(notices(f)).toEqual(["화면에 연결할 수 없어 문서 작업을 시작하지 못했습니다. Workbench 창을 한 번 연 뒤 다시 요청해 주세요."]);
  expect(notices(f).join()).not.toMatch(/자동 재실행/);
  expect(lines.join("\n")).toMatch(/no display/);
});

it("starts as soon as a screen appears during the wait (the person logged in)", async () => {
  let display: string | undefined;
  const f = fixture({ platform: "linux", environment: base => { const out = { ...base }; delete out.WAYLAND_DISPLAY; delete out.DISPLAY; return display ? { ...out, WAYLAND_DISPLAY: display } : out; },
    displayWaitMs: 2000, displayPollMs: 20, log: () => undefined });
  await f.start();
  expect(f.launches).toHaveLength(0);
  display = "wayland-1";
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]!.env.WAYLAND_DISPLAY).toBe("wayland-1");
  expect(f.manager.office.observe(f.binding, "run").receipt.status).toBe("running");
});

it("does not wait on Windows or macOS: there the display is not an environment variable", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const f = fixture({ platform, environment: base => { const out = { ...base }; delete out.WAYLAND_DISPLAY; delete out.DISPLAY; return out; } });
    await f.start();
    expect(f.launches).toHaveLength(1);
  }
});

it("an executor that exits before it took the turn says so, and its scrubbed error output goes to the log", async () => {
  const lines: string[] = [];
  const f = fixture({ log: line => lines.push(line), scrub: text => text.replaceAll("stored-value-123", "[비밀]") });
  await f.start();
  const child = f.launches[0]!.child;
  child.stderr.write("Gtk-WARNING: cannot open display: \nleaked stored-value-123 Bearer abcdefghijklmnopqrstuvwxyz0123\n");
  child.emit("exit", 1, null);
  child.stderr.end();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.manager.office.observe(f.binding, "run").receipt.status).toBe("failed");
  expect(notices(f)[0]).toMatch(/시작하자마자 종료되어 작업을 시작하지 못했습니다/);
  const log = lines.join("\n");
  expect(log).toMatch(/exited before it started the work \(code 1\)/);
  expect(log).toMatch(/cannot open display/);
  expect(log).not.toMatch(/stored-value-123|abcdefghijklmnopqrstuvwxyz0123/);
});

it("keeps only the last 2 KB of an executor's error output", async () => {
  const lines: string[] = [];
  const f = fixture({ log: line => lines.push(line) });
  await f.start();
  const child = f.launches[0]!.child;
  child.stderr.write("HEAD" + "x".repeat(5000) + "TAIL");
  child.stderr.end();
  await new Promise(resolve => setTimeout(resolve, 10));
  child.emit("exit", 1, null);
  const log = lines.join("\n");
  expect(log).toMatch(/TAIL/); expect(log).not.toMatch(/HEAD/);
  expect(log.length).toBeLessThan(2300);
});

it("an executor that took its turn and then exits with a failure code still leaves its reason in the log", async () => {
  const lines: string[] = [];
  const f = fixture({ log: line => lines.push(line) });
  const capability = await f.start(); f.executors.boot(capability);
  f.manager.office.finish(f.binding, { turnId: "run", status: "failed", error: "원본 편집기를 실행기에 연결하는 시간이 초과되었습니다." });
  const child = f.launches[0]!.child;
  child.stderr.end("WebKit: page stalled\n");
  await new Promise(resolve => setTimeout(resolve, 10));
  child.emit("exit", 1, null);
  expect(lines.join("\n")).toMatch(/ended with a failure \(code 1\)[\s\S]*page stalled/);
  lines.length = 0;
  const g = fixture({ log: line => lines.push(line) });
  const other = await g.start(); g.executors.boot(other);
  g.manager.office.finish(g.binding, { turnId: "run", status: "completed" });
  g.launches[0]!.child.stderr.end(); g.launches[0]!.child.emit("exit", 3, null);
  expect(lines).toEqual([]);
});
