import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertFreshTarget, type BrowserObservation, type BrowserPage, type NativeBrowserPage, type Session } from "@workbench/contracts";
import { Store } from "./store.ts";
import { BrowserRegistry, pageAction, webUrl } from "./browser-registry.ts";
import { SessionManager } from "./sessions.ts";
import { EventBus } from "./bus.ts";

const cleanup: (() => void | Promise<void>)[] = [];
it("opens an actual blank tab without admitting arbitrary about, data or script documents", () => {
  expect(webUrl("about:blank")).toBe("about:blank");
  for (const input of ["about:config", "about:blank#payload", "data:text/html,hello", "javascript:alert(1)", "file:///tmp/example.html"]) expect(() => webUrl(input)).toThrow();
  const { registry, driverId } = fixture();
  const page = registry.create({ requestId: randomUUID(), driverId, profileId: "default", workspaceId: "workspace", url: "about:blank" });
  expect(page.url).toBe("about:blank"); expect(page.title).toBe("새 탭");
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const native = (page: BrowserPage): NativeBrowserPage => ({ pageId: page.pageId, profileId: page.profileId, navigationRevision: 1, capabilities: ["observe", "navigate", "dom_actions"], url: page.url, title: "동일 주소", loading: false, control: { ...page.control }, popups: [], error: null });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-pages-")), store = new Store(join(dir, "state.sqlite"));
  const interrupted = vi.fn(), sessions = new Map<string, Session>();
  const hooks = { workspace: (_id: string) => ({ workId: "work" }), session: (id: string) => sessions.get(id)!, interrupted };
  const registry = new BrowserRegistry(store, hooks), driverId = randomUUID();
  registry.poll({ driverId, pages: [], results: [] });
  cleanup.push(() => { registry.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = () => registry.create({ requestId: randomUUID(), driverId, profileId: "default", workspaceId: "workspace", url: "https://example.com" });
  return { registry, store, sessions, driverId, create, hooks, interrupted };
}
it("pages long rendered text on the same authenticated page without asking for write control", async () => {
  const { registry, driverId, create, sessions } = fixture(), page = create(), state = native(page);
  const child = { id: "reader", workId: "work", workspaceId: "workspace", pageAgent: { pageId: page.pageId, parentSessionId: "parent" } } as Session;
  sessions.set(child.id, child); registry.attach(page.pageId, child);
  registry.poll({ driverId, pages: [state], results: [] });
  const pending = registry.agent(child.id, "long-read", "read", ["24000", "12000"], state.control);
  const job = registry.poll({ driverId, pages: [state], results: [] }).jobs[0]!;
  expect(job.action).toEqual({ kind: "read", offset: 24000, limit: 12000 });
  expect(job.pageId).toBe(page.pageId);
  const observation = { target: state, documentNonce: "signed-in-document", observedAt: Date.now(), text: "PRIVATE ARTICLE TAIL" };
  registry.poll({ driverId, pages: [state], results: [{ id: job.id, pageId: page.pageId, observation }] });
  expect((await pending).observation?.text).toBe("PRIVATE ARTICLE TAIL");
  for (const args of [["-1"], ["NaN"], ["0", "24001"], ["0", "1", "ignored"]]) {
    await expect(registry.agent(child.id, randomUUID(), "read", args, state.control)).rejects.toThrow();
  }
  expect(() => pageAction({ kind: "read", offset: 0, limit: 0 })).toThrow();
});
it("restores the same identity and profile after restart only through an explicit authenticated restore", () => {
  const { registry, store, create, driverId, hooks } = fixture();
  const a = create(), b = create();
  const states = [native(a), native(b)];
  registry.poll({ driverId, pages: states, results: [] });
  expect(a.pageId).not.toBe(b.pageId);
  registry.poll({ driverId, pages: states.slice().reverse(), results: [] }); // moving panes does not navigate
  expect(registry.get(a.pageId).native?.navigationRevision).toBe(1);
  registry.shutdown();
  const resumed = new BrowserRegistry(store, hooks); cleanup.push(() => resumed.shutdown());
  resumed.poll({ driverId, pages: states, results: [] });
  expect(resumed.get(a.pageId).status).toBe("interrupted");
  expect(resumed.get(b.pageId).status).toBe("interrupted");
  const freshDriver = randomUUID();
  resumed.poll({ driverId: freshDriver, pages: [], results: [] });
  // This test explicitly polls the old driver above: a live owner cannot be stolen.
  expect(() => resumed.restore(a.pageId, freshDriver)).toThrow();
  const restored = resumed.restore(a.pageId, driverId);
  expect(restored).toMatchObject({ pageId: a.pageId, profileId: a.profileId, url: a.url, status: "opening", control: { owner: "human" } });
  resumed.poll({ driverId, pages: [native(restored)], results: [] });
  expect(resumed.get(a.pageId).status).toBe("ready");
  expect(resumed.get(b.pageId).status).toBe("interrupted");
});
it("recovers a legacy closed layout tab, but keeps an explicitly closed tab closed across restart", () => {
  const { registry, store, hooks, create } = fixture(), page = create();
  page.status = "closed";
  store.setMeta("shared-browser:v1", JSON.stringify({ ...registry.list(), pages: [page] }));
  registry.shutdown();
  const resumed = new BrowserRegistry(store, hooks); cleanup.push(() => resumed.shutdown());
  const driverId = randomUUID(); resumed.poll({ driverId, pages: [], results: [] });
  expect(resumed.restore(page.pageId, driverId)).toMatchObject({ pageId: page.pageId, url: page.url, status: "opening" });
  resumed.poll({ driverId, pages: [native(resumed.get(page.pageId))], results: [] });
  resumed.poll({ driverId, pages: [], results: [] }); // lost native view
  resumed.close(page.pageId);
  expect(resumed.list().closedPageIds).toContain(page.pageId);
  resumed.shutdown();
  const final = new BrowserRegistry(store, hooks); cleanup.push(() => final.shutdown());
  final.poll({ driverId, pages: [], results: [] });
  expect(() => final.restore(page.pageId, driverId)).toThrow("닫은 웹 탭");
  expect(final.list().pages).toHaveLength(0);
});
it("does not let a late close receipt from the old driver close a restored page", async () => {
  const { registry, store, hooks, driverId, create } = fixture(), page = create();
  registry.poll({ driverId, pages: [native(page)], results: [] });
  const pending = registry.human(page.pageId, { requestId: "close-before-restart", action: { kind: "close" } });
  const job = registry.poll({ driverId, pages: [native(page)], results: [] }).jobs[0]!;
  registry.shutdown(); await pending;
  const resumed = new BrowserRegistry(store, hooks); cleanup.push(() => resumed.shutdown());
  const nextDriver = randomUUID(); resumed.poll({ driverId: nextDriver, pages: [], results: [] });
  const restored = resumed.restore(page.pageId, nextDriver);
  resumed.poll({ driverId: nextDriver, pages: [native(restored)], results: [] });
  resumed.poll({ driverId, pages: [], results: [{ id: job.id, pageId: page.pageId }] });
  expect(resumed.get(page.pageId).status).toBe("ready");
  expect(resumed.poll({ driverId: nextDriver, pages: [native(restored)], results: [] }).jobs).toEqual([]);
});
it("fences an approved old action after human takeover and does not replay an unknown dispatch", async () => {
  const { registry, driverId, create, sessions } = fixture(), page = create();
  const state = native(page);
  registry.poll({ driverId, pages: [state], results: [] });
  const child = { id: "child", workId: "work", workspaceId: "workspace", pageAgent: { pageId: page.pageId, parentSessionId: "parent" } } as Session;
  sessions.set(child.id, child); registry.attach(page.pageId, child);
  const grant = registry.control(page.pageId, child.id, 0);
  const controlJob = registry.poll({ driverId, pages: [state], results: [] }).jobs[0]!;
  state.control = { ...controlJob.control };
  registry.poll({ driverId, pages: [state], results: [{ id: controlJob.id, pageId: page.pageId, page: state }] });
  await grant;
  const observed: BrowserObservation = { target: state, documentNonce: "doc-1", observedAt: Date.now(), text: "PRIVATE PAGE TEXT" };
  const snapshot = registry.agent(child.id, "read-1", "snapshot", [], state.control);
  const readJob = registry.poll({ driverId, pages: [state], results: [] }).jobs[0]!;
  registry.poll({ driverId, pages: [state], results: [{ id: readJob.id, pageId: page.pageId, observation: observed }] }); await snapshot;
  const old = { ...state.control };
  state.control = { generation: old.generation + 1, owner: "human" }; // real trusted pointer input
  registry.poll({ driverId, pages: [state], results: [] });
  await expect(registry.agent(child.id, "late-click", "click", ["e1"], old)).rejects.toMatchObject({ code: "CONTROL_REVOKED" });
  expect(registry.poll({ driverId, pages: [state], results: [] }).jobs).toHaveLength(0);
  const input = { requestId: randomUUID(), action: { kind: "navigate", url: "https://example.org" } };
  const pending = registry.human(page.pageId, input);
  expect(registry.poll({ driverId, pages: [state], results: [] }).jobs).toHaveLength(1);
  registry.shutdown();
  expect((await pending).error).toBeTruthy();
  expect(registry.receipt(input.requestId)?.status).toBe("outcome_unknown");
  const again = await registry.human(page.pageId, input);
  expect(again.error).toBeTruthy();
  expect(registry.poll({ driverId, pages: [state], results: [] }).jobs).toHaveLength(0);
});
it("rejects old document identity while preserving the same page through pane moves", () => {
  const a: BrowserObservation = { target: { pageId: "a", profileId: "default", navigationRevision: 2, capabilities: [] }, documentNonce: "doc-a", observedAt: 1, text: "" };
  expect(() => assertFreshTarget({ ...a }, a)).not.toThrow();
  expect(() => assertFreshTarget({ ...a, target: { ...a.target, navigationRevision: 3 }, documentNonce: "doc-b" }, a)).toThrow("STALE_DOCUMENT");
  expect(() => assertFreshTarget({ ...a, target: { ...a.target, pageId: "b" } }, a)).toThrow("STALE_DOCUMENT");
});
it("opens a real driver page for a main agent while keeping its page chat independent", async () => {
  const { registry, sessions, driverId } = fixture();
  const main = { id: "main", workId: "work", workspaceId: "workspace" } as Session;
  sessions.set(main.id, main);
  const states = new Map<string, NativeBrowserPage>();
  const driver = setInterval(() => {
    for (const page of registry.list().pages) if (!states.has(page.pageId)) states.set(page.pageId, native(page));
    const jobs = registry.poll({ driverId, pages: [...states.values()], results: [] }).jobs;
    for (const job of jobs) {
      const state = states.get(job.pageId)!;
      if (job.action.kind === "control") state.control = job.control;
      registry.poll({ driverId, pages: [...states.values()], results: [{ id: job.id, pageId: job.pageId, page: state }] });
    }
  }, 10);
  try {
    const page = await registry.openAgentPage(main.id, "https://example.com");
    expect(page.agentSessionId).toBe(main.id); expect(page.sessionId).toBeNull();
    expect(page.control.owner).toBe(main.id); expect(registry.agentPage(main.id)?.pageId).toBe(page.pageId);
    const child = { id: "child", workId: "work", workspaceId: "workspace", pageAgent: { pageId: page.pageId, parentSessionId: main.id } } as Session;
    sessions.set(child.id, child); registry.attach(page.pageId, child);
    expect(registry.agentPage(main.id)?.pageId).toBe(registry.agentPage(child.id)?.pageId);
    expect(page.sessionId).toBe(child.id);
    await expect(registry.control(page.pageId, "unrelated", page.control.generation)).rejects.toThrow();
    page.status = "closed";
    expect(registry.agentPage(main.id)?.status).toBe("closed"); // do not silently switch back to Lightpanda
  } finally { clearInterval(driver); }
});
it("creates page children without changing the main conversation and projects their parent task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-page-session-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "here", hostLabel: "여기", managedWorksDir: dir, dataDir: dir });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "프로젝트", cwd: dir }), main = manager.createSession(work.id, { provider: "codex" });
  const driverId = randomUUID(); manager.sharedBrowser.poll({ driverId, pages: [], results: [] });
  const page = manager.sharedBrowser.create({ requestId: randomUUID(), driverId, workspaceId: work.defaultWorkspaceId!, profileId: "default", url: "https://example.com" });
  manager.sharedBrowser.poll({ driverId, pages: [native(page)], results: [] });
  const child = await manager.browserSession(page.pageId, main.id);
  expect(child.id).not.toBe(main.id); expect(child.pageAgent?.parentSessionId).toBe(main.id);
  expect((await manager.browserSession(page.pageId, main.id)).id).toBe(child.id);
  expect(manager.view.works.get(work.id)?.activeSessionId).toBe(main.id);
  manager.sink.upsertItem(main.id, { id: "user:parent-run", kind: "user", text: "main", at: Date.now(), refs: [] });
  manager.sink.upsertItem(child.id, { id: "user:child-run", kind: "user", text: "page", at: Date.now(), refs: [] });
  expect(manager.tasks.list({ parentSessionId: main.id }).tasks).toContainEqual(expect.objectContaining({ sessionId: child.id, executorKind: "browser", parentRunId: `${main.id}/parent-run` }));
  manager.updateSession(child.id, { model: "saved-codex-model", effort: "high" });
  manager.sink.updateSession(child.id, { nativeSessionId: "codex-thread" });
  const other = await manager.browserSession(page.pageId, main.id, "claude");
  expect(other).toMatchObject({ provider: "claude", model: null, effort: null, pageAgent: { pageId: page.pageId, parentSessionId: main.id } });
  expect(other.id).not.toBe(child.id);
  manager.updateSession(other.id, { model: "saved-claude-model" });
  const restored = await manager.browserSession(page.pageId, main.id, "codex");
  expect(restored).toMatchObject({ id: child.id, model: "saved-codex-model", effort: "high", nativeSessionId: "codex-thread" });
  expect(manager.items(restored.id).items.some(item => item.id === "user:child-run")).toBe(true);
  expect(manager.view.sessions.get(main.id)?.model).toBeNull();
  expect(manager.view.works.get(work.id)?.activeSessionId).toBe(main.id);
  manager.sink.updateSession(child.id, { status: "running" });
  await expect(manager.browserSession(page.pageId, main.id, "claude")).rejects.toMatchObject({ code: "browser_agent_busy" });
  expect(page.sessionId).toBe(child.id);
  manager.sink.updateSession(child.id, { status: "idle" });
  // A completed turn still owns native control: switching must settle a real handoff first.
  const take = manager.sharedBrowser.control(page.pageId, child.id, page.control.generation);
  let job = manager.sharedBrowser.poll({ driverId, pages: [native(page)], results: [] }).jobs[0]!;
  manager.sharedBrowser.poll({ driverId, pages: [native(page)], results: [{ id: job.id, pageId: page.pageId, page: native(page) }] });
  await take;
  const switching = manager.browserSession(page.pageId, main.id, "claude");
  job = manager.sharedBrowser.poll({ driverId, pages: [native(page)], results: [] }).jobs[0]!;
  expect(job.action).toMatchObject({ kind: "control", control: { owner: "human" } });
  expect(page.sessionId).toBe(child.id);
  manager.sharedBrowser.poll({ driverId, pages: [native(page)], results: [{ id: job.id, pageId: page.pageId, page: native(page) }] });
  expect(await switching).toMatchObject({ id: other.id, model: "saved-claude-model" });
  expect(page.control.owner).toBe("human");
  const originalItems = manager.items(child.id).items;
  manager.sharedBrowser.close(page.pageId);
  expect(manager.view.sessions.get(child.id)?.archivedAt).toBeTypeOf("number");
  expect(manager.view.sessions.get(other.id)?.archivedAt).toBeTypeOf("number");
  expect(manager.view.sessions.get(main.id)?.archivedAt).toBeNull();
  expect(manager.items(child.id).items).toEqual(originalItems);
});
