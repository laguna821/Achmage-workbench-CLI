import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./sessions.ts";
import { createHttpServer } from "./http.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { OfficeKnowledge } from "./office-knowledge.mjs";
import { OfficeAi } from "./office-ai.ts";
import { OfficeSkills } from "./office-skills.ts";
import type { OfficeAiEngine } from "./office-ai-engine.mjs";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-knowledge-home-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "Home" }), path = join(work.cwd, "자료.md"); writeFileSync(path, "# 자료\n공통 지식 자료");
  const artifact = manager.openFile(work.id, path), grants = new EditorGrants(), token = grants.issue(artifact.id, { viewId: "document", writeToken: null });
  const knowledge = new OfficeKnowledge(dir, manager), started: string[] = [];
  const engine: OfficeAiEngine = {
    settings: () => ({}), statuses: async () => ({}), chat: async () => ({ ok: true, content: "fixture" }),
    async stream(request, sessionId, signal, send) {
      started.push(sessionId); send({ requestId: request.requestId, type: "delta", text: "진행 중인 답변" });
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      send({ requestId: request.requestId, type: "done" });
    },
  };
  const ai = new OfficeAi(dir, engine, undefined, undefined, undefined, knowledge);
  const main = createHttpServer(manager, bus, { token: "main-token", webDir: null, officeAi: ai, officeKnowledge: knowledge, officeSkills: new OfficeSkills(manager, store) });
  const editor = createEditorsServer(manager.documents, grants, null, ai);
  await Promise.all([main, editor].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
  const origin = "http://127.0.0.1:" + (main.address() as AddressInfo).port, editorOrigin = "http://127.0.0.1:" + (editor.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown, auth = "main-token") => fetch(origin + "/api/office-knowledge" + path, { method, headers: { authorization: "Bearer " + auth }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { manager, knowledge, ai, started, work, path, artifact, token, call, editorOrigin, close: async () => {
    knowledge.close(); ai.close(); main.closeAllConnections(); editor.closeAllConnections();
    await Promise.all([main, editor].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}
const request = { requestId: "same-request", sessionId: "same-renderer-session", settings: {}, system: "fixture", messages: [{ role: "user", text: "자료를 설명해 줘" }] };

it("keeps authenticated home streams independent from each other and the active document", async () => {
  const f = await fixture();
  try {
    expect((await f.call("POST", "/home", {}, "")).status).toBe(401);
    expect((await f.call("POST", "/home", {}, f.token)).status).toBe(401);
    const one = await (await f.call("POST", "/home", {})).json() as { owner: string };
    const two = await (await f.call("POST", "/home", {})).json() as { owner: string };
    const first = await f.call("POST", "/home/" + one.owner + "/stream", request);
    const second = await f.call("POST", "/home/" + two.owner + "/stream", request);
    const document = await fetch(f.editorOrigin + "/api/artifacts/" + f.artifact.id + "/ai/stream", { method: "POST", headers: { authorization: "Bearer " + f.token }, body: JSON.stringify(request) });
    expect([first.status, second.status, document.status]).toEqual([200, 200, 200]);
    expect(f.ai.activeCount).toBe(3); expect(new Set(f.started).size).toBe(3);
    expect(f.manager.snapshot().sessions).toEqual([]);
    expect((await f.call("POST", "/home/" + one.owner + "/stream", request)).status).toBe(409);
    await f.call("POST", "/home/" + one.owner + "/cancel", { requestId: "same-request" });
    expect(await first.text()).toContain("진행 중인 답변"); expect(f.ai.activeCount).toBe(2);
    await f.call("DELETE", "/home/" + two.owner);
    expect(await second.text()).toContain('"type":"done"'); expect(f.ai.activeCount).toBe(1);
    expect((await f.call("GET", "/home/" + two.owner + "/settings")).status).toBe(410);
    await fetch(f.editorOrigin + "/api/artifacts/" + f.artifact.id + "/ai/cancel", { method: "POST", headers: { authorization: "Bearer " + f.token }, body: JSON.stringify({ requestId: "same-request" }) });
    expect(await document.text()).toContain('"type":"done"'); expect(f.ai.activeCount).toBe(0);
    expect((await fetch(f.editorOrigin + "/api/office-knowledge/home", { method: "POST", headers: { authorization: "Bearer " + f.token }, body: "{}" })).ok).toBe(false);
  } finally { await f.close(); }
});

it("serves the original home knowledge calls and registers saved answers through the actual gateway", async () => {
  const f = await fixture();
  try {
    await f.knowledge.manage("add", { paths: [f.path], group: "연구" });
    const { owner } = await (await f.call("POST", "/home", {})).json() as { owner: string };
    const invoke = (channel: string, args: unknown[] = [], destination: unknown = { workId: f.work.id }) => f.call("POST", "/home/" + owner + "/invoke", { channel, args, destination });
    expect(await (await invoke("home:starred-groups")).json()).toEqual(["연구"]);
    const skills = await invoke("home:skills", [{ operation: "list" }]); expect(skills.status).toBe(200); expect(await skills.json()).toBeInstanceOf(Array);
    expect(await (await invoke("home:starred", [{ group: "연구", limit: 0 }])).json()).toMatchObject({ total: 1 });
    const scope: unknown = await (await invoke("kb:open-scope", ["연구"])).json();
    expect(await (await invoke("kb:read", [{ path: f.path, scope }])).json()).toMatchObject({ text: "# 자료\n공통 지식 자료" });
    const answer = "# 답변\n\n자료에서 확인한 내용입니다.";
    const saved = await (await invoke("kb:create-document", [{ title: "답변", format: "md", content: answer }])).json() as { path: string; artifactId: string };
    expect(readFileSync(saved.path, "utf8")).toBe(answer);
    expect(await (await invoke("home:open-path", [saved.path])).json()).toMatchObject({ id: saved.artifactId });
    expect(f.manager.snapshot().sessions).toEqual([]);
    expect(readFileSync(f.path, "utf8")).toBe("# 자료\n공통 지식 자료");
    const denied = await invoke("kb:create-document", [{ title: "없음", format: "md", content: answer }], null);
    expect(denied.status).toBe(400);
  } finally { await f.close(); }
});
