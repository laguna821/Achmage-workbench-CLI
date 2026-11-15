import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Handoff, Schedule, SequencedEvent, Session, Snapshot, TranscriptItem } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { StandInEngine, until } from "../channels/test-kit.ts";
import { createHttpServer } from "../http.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { formsOf } from "./forms.ts";
import { installScrubber } from "./install.ts";
import { CredentialService } from "./service.ts";

// Ruling R6 (fix round 3). Text the person typed and has not sent yet (a waiting request, a
// schedule's text, a hand-off note) is their DRAFT: stored, returned to their own surfaces (HTTP
// answers, the snapshot, events: the PC and their approved devices) and edited exactly as typed.
// The moment it becomes a transcript item it is hidden: the item, the index, every broadcast of
// it, the session line. (The messenger, logs and audit: channels/draft-rule.test.ts.)
// Made-up values only.
const TOKEN = "local-token-for-tests-0123456789abcdef";
const VALUE = "zz-secret-route-0021";
const LATER = "zz-secret-later-0031";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.restoreAllMocks(); });

async function gateway() {
  const dir = mkdtempSync(join(tmpdir(), "wb-cred-routes-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const events: SequencedEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const credentials = new CredentialService({ dataDir, vault, manager });
  installScrubber(store, manager, credentials.scrubber);
  await credentials.add({ name: "포털", kind: "other", site: "", values: { 값: VALUE } });
  const server: Server = createHttpServer(manager, bus, { token: TOKEN, webDir: null });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    credentials.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text() };
  };
  const json = async <T>(method: string, path: string, body?: unknown) => {
    const answer = await api(method, path, body);
    expect(answer.status, `${method} ${path}`).toBeLessThan(300);
    return JSON.parse(answer.text) as T;
  };
  /** A work, a conversation that is busy (its turn does not end until the test says so), and another one. */
  const busy = async () => {
    const work = await json<{ id: string }>("POST", "/api/works", { title: "연구" });
    const session = await json<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
    const other = await json<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
    expect((await api("POST", `/api/sessions/${session.id}/messages`, { requestId: "r1", text: "일 해 줘" })).status).toBe(202);
    await until(() => engine.sent.length === 1);
    return { work, session, other };
  };
  return { manager, engine, credentials, events, api, json, busy };
}
const formsIn = (value: string, text: string) => formsOf(value).filter((form) => text.includes(form));
/** The answer without its drafts (a waiting request's text, a schedule's text, a hand-off note). */
function withoutDrafts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDrafts);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const draft = ("sourceSessionId" in object && "targetSessionId" in object) || ("when" in object && "sessionId" in object);
  return Object.fromEntries(Object.entries(object).flatMap(([key, entry]) => {
    if (key === "queued") return [[key, (entry as { text: string }[]).map((request) => ({ ...request, text: "" }))]];
    if (draft && key === "text") return [];
    return [[key, withoutDrafts(entry)]];
  }));
}

describe("R6 (a): a draft is the person's own, as typed, on their own surfaces", () => {
  it("a waiting request, a schedule's text and a hand-off note are returned and edited exactly as typed (answers, snapshot, events)", async () => {
    const g = await gateway();
    const { session, other } = await g.busy();
    const typed = `다음엔 ${VALUE} 로 로그인`;
    const queuedAnswer = await g.api("POST", `/api/sessions/${session.id}/messages`, { requestId: "r2", text: typed, mode: "queue" });
    expect(queuedAnswer.status).toBe(202);
    const snapshot = await g.json<Snapshot>("GET", "/api/snapshot");
    const queued = snapshot.sessions.find((entry) => entry.id === session.id)!.queued;
    expect(queued.map((entry) => entry.text)).toEqual([typed]);
    expect(g.events.some((event) => event.type === "session.upserted" && event.session.queued.some((entry) => entry.text === typed))).toBe(true);
    // An edit round-trips losslessly: what the person sees is what is kept, and what is kept is what they typed.
    const edited = `${queued[0]!.text} 그리고 확인`;
    const patched = await g.json<Session>("PATCH", `/api/sessions/${session.id}/queue/${queued[0]!.id}`, { text: edited });
    expect(patched.queued[0]!.text).toBe(edited);
    expect(g.manager.view.sessions.get(session.id)!.queued[0]!.text).toBe(edited);
    expect((await g.json<Snapshot>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === session.id)!.queued[0]!.text).toBe(edited);
    // A schedule's text.
    const scheduleText = `내일 ${VALUE} 로 확인`;
    const schedule = await g.json<Schedule>("POST", "/api/schedules", { sessionId: session.id, text: scheduleText, when: { kind: "once", at: Date.now() + 3_600_000 } });
    expect(schedule.text).toBe(scheduleText);
    expect((await g.json<{ schedules: Schedule[] }>("GET", "/api/schedules")).schedules[0]!.text).toBe(scheduleText);
    expect((await g.json<Schedule>("PATCH", `/api/schedules/${schedule.id}`, { enabled: false })).text).toBe(scheduleText);
    expect((await g.json<Snapshot>("GET", "/api/snapshot")).schedules![0]!.text).toBe(scheduleText);
    expect(g.events.some((event) => event.type === "schedules.changed" && event.schedules.some((entry) => entry.text === scheduleText))).toBe(true);
    // A hand-off note to another conversation.
    const note = `이 값으로 들어가 봐: ${VALUE}`;
    const handoff = await g.json<Handoff>("POST", "/api/handoffs", { requestId: "h1", sourceSessionId: session.id, targetSessionId: other.id, text: note });
    expect(handoff.text).toBe(note);
    expect((await g.json<Snapshot>("GET", "/api/snapshot")).handoffs.find((entry) => entry.id === handoff.id)!.text).toBe(note);
    expect(g.events.some((event) => event.type === "handoff.upserted" && event.handoff.text === note)).toBe(true);
    // Sent to the other conversation, the note is a transcript item there: hidden.
    await until(() => g.manager.items(other.id).items.some((item) => item.kind === "user"));
    const otherItems = await g.api("GET", `/api/sessions/${other.id}/items`);
    expect(formsIn(VALUE, otherItems.text)).toEqual([]);
    expect(otherItems.text).toContain("[비밀: 포털]");
    // The engine got what the person typed (their choice): the queued request when it is sent.
    g.engine.finish(session.id);
    await until(() => g.engine.sent.some((entry) => entry.text === edited));
  });
});

describe("R6 by author (fix round 4): only what the person typed is a draft", () => {
  it("queued text from the four other sources (a webhook workflow, a remote Hub prompt, a review batch, another queued send) goes out hidden in answers, snapshot and events", async () => {
    const g = await gateway();
    const { session } = await g.busy();
    const live = g.manager.view.sessions.get(session.id)!;
    const typedBy = {
      // event-hub.ts: a workflow's command (the instructions and a third party's payload) through tasks.submit, mode queue.
      hub: () => g.manager.tasks.submit({ commandId: "hub-delivery-1", hostId: live.hostId, workspaceId: live.workspaceId!, sessionId: session.id, text: `웹훅 자료 {"token":"${VALUE}"}`, mode: "queue" }),
      // hub/executions.ts: a remote Hub prompt, the same way.
      remote: () => g.manager.tasks.submit({ commandId: "hub-exec-1", hostId: live.hostId, workspaceId: live.workspaceId!, sessionId: session.id, text: `원격 지시 ${VALUE}`, mode: "queue" }),
      // scm-review.ts through the manager's review hook: send(id, requestId, text, [], null, null, "queue", { activate: false }).
      review: () => g.manager.send(session.id, "scm-review-1", `리뷰 의견: ${VALUE} 를 지우세요`, [], null, null, "queue", { activate: false }),
      // Any other queued send made by the app, not typed by the person: send(sessionId, requestId, text, [], null, null, "queue").
      other: () => g.manager.send(session.id, "app-queued-1", `앱이 넣은 글 ${VALUE}`, [], null, null, "queue"),
    };
    for (const send of Object.values(typedBy)) await send();
    expect(g.manager.view.sessions.get(session.id)!.queued).toHaveLength(4);
    const snapshot = await g.api("GET", "/api/snapshot");
    const patched = await g.api("PATCH", `/api/sessions/${session.id}`, { seen: true });
    const events = JSON.stringify(g.events.filter((event) => event.type === "session.upserted"));
    for (const [where, text] of [["snapshot", snapshot.text], ["answer", patched.text], ["events", events]] as const) {
      expect(formsIn(VALUE, text), where).toEqual([]);
      expect(text, where).toContain("[비밀: 포털]");
    }
    // The engine still gets them as they were written.
    g.engine.finish(session.id);
    await until(() => g.engine.sent.some((entry) => entry.text.includes(`원격 지시 ${VALUE}`) || entry.text.includes(`웹훅 자료`)));
  });

  it("the person's own entry (composer, the paired chat) is as typed and edits losslessly; an entry from before this build or another source becomes theirs by an edit, without losing its text", async () => {
    const g = await gateway();
    const { session } = await g.busy();
    const mine = `내 요청 ${VALUE}`;
    expect((await g.api("POST", `/api/sessions/${session.id}/messages`, { requestId: "pc-1", text: mine, mode: "queue" })).status).toBe(202);
    await g.manager.send(session.id, "chat-1", `휴대폰 요청 ${VALUE}`, [], null, null, "queue", { origin: { channel: "telegram", bindingId: "b1", context: 2 } as never });
    await g.manager.send(session.id, "other-1", `남이 쓴 ${VALUE} 줄`, [], null, null, "queue", { activate: false });
    const queued = (await g.json<Snapshot>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === session.id)!.queued;
    expect(queued.map((entry) => entry.text)).toEqual([mine, `휴대폰 요청 ${VALUE}`, "남이 쓴 [비밀: 포털] 줄"]);
    // Edited at the PC from what the PC shows: the person's own text round-trips; the other entry keeps its value and becomes theirs.
    const edited = await g.json<Session>("PATCH", `/api/sessions/${session.id}/queue/pc-1`, { text: `${mine} 그리고` });
    expect(edited.queued[0]!.text).toBe(`${mine} 그리고`);
    const taken = await g.json<Session>("PATCH", `/api/sessions/${session.id}/queue/other-1`, { text: "남이 쓴 [비밀: 포털] 줄 고침" });
    // The value the person never typed is kept for the engine, and stays hidden on every surface (N9): the
    // edit put it back, so the entry is still not the person's draft.
    expect(g.manager.view.sessions.get(session.id)!.queued[2]!.text).toBe(`남이 쓴 ${VALUE} 줄 고침`);
    expect(g.manager.view.sessions.get(session.id)!.queued[2]!.draft).not.toBe(true);
    expect(taken.queued[2]!.text).toBe("남이 쓴 [비밀: 포털] 줄 고침");
    expect((await g.json<Snapshot>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === session.id)!.queued[2]!.text).toBe("남이 쓴 [비밀: 포털] 줄 고침");
    const lastEvent = g.events.filter((event) => event.type === "session.upserted").at(-1)!;
    expect(lastEvent.type === "session.upserted" && lastEvent.session.queued[2]!.text).toBe("남이 쓴 [비밀: 포털] 줄 고침");
    // Written anew by the person, with nothing put back: theirs, as typed.
    const rewritten = await g.json<Session>("PATCH", `/api/sessions/${session.id}/queue/other-1`, { text: "내가 새로 쓴 줄" });
    expect(rewritten.queued[2]).toMatchObject({ text: "내가 새로 쓴 줄", draft: true });
    // An entry written by an earlier build (no mark): shown hidden, and an edit from that copy keeps the value.
    const before = g.manager.view.sessions.get(session.id)!;
    // (As loaded from the store: the live map, as an earlier build left it.)
    (g.manager as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, { ...before, queued: [...before.queued, { id: "old-1", text: `예전 ${VALUE} 요청`, refs: [], create: null, at: 1 }] });
    expect((await g.json<Snapshot>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === session.id)!.queued[3]!.text).toBe("예전 [비밀: 포털] 요청");
    const old = await g.json<Session>("PATCH", `/api/sessions/${session.id}/queue/old-1`, { text: "예전 [비밀: 포털] 요청 다시" });
    expect(g.manager.view.sessions.get(session.id)!.queued[3]!.text).toBe(`예전 ${VALUE} 요청 다시`);
    expect(old.queued[3]!.text).toBe("예전 [비밀: 포털] 요청 다시");
  });

  it("a schedule made at the PC and a hand-off note posted by the PC are drafts; a schedule made by anything else is hidden", async () => {
    const g = await gateway();
    const { session, other } = await g.busy();
    const pc = await g.json<Schedule>("POST", "/api/schedules", { sessionId: session.id, text: `내일 ${VALUE}`, when: { kind: "once", at: Date.now() + 3_600_000 } });
    expect(pc.text).toBe(`내일 ${VALUE}`);
    g.manager.schedules.create({ sessionId: session.id, text: `도구가 만든 ${VALUE}`, when: { kind: "once", at: Date.now() + 3_600_000 } });
    const listed = await g.json<{ schedules: Schedule[] }>("GET", "/api/schedules");
    expect(listed.schedules.map((entry) => entry.text)).toEqual([`내일 ${VALUE}`, "도구가 만든 [비밀: 포털]"]);
    expect((await g.json<Snapshot>("GET", "/api/snapshot")).schedules!.map((entry) => entry.text)).toEqual([`내일 ${VALUE}`, "도구가 만든 [비밀: 포털]"]);
    const changed = g.events.filter((event) => event.type === "schedules.changed").at(-1)!;
    expect(changed.type === "schedules.changed" && changed.schedules.map((entry) => entry.text)).toEqual([`내일 ${VALUE}`, "도구가 만든 [비밀: 포털]"]);
    const note = await g.json<Handoff>("POST", "/api/handoffs", { requestId: "h1", sourceSessionId: session.id, targetSessionId: other.id, text: `노트 ${VALUE}` });
    expect(note.text).toBe(`노트 ${VALUE}`);
  });
});

describe("R6 (b): once sent, it is hidden in the item, the index, every broadcast and the session line", () => {
  it("the user item, its broadcasts, the index and the session line carry the placeholder and no form; every route walked", async () => {
    const g = await gateway();
    const { work, session, other } = await g.busy();
    // A value written before it was stored: another conversation's line mentioned it, then the person kept it.
    expect((await g.api("POST", `/api/sessions/${other.id}/messages`, { requestId: "o1", text: "값 하나 만들어 줘" })).status).toBe(202);
    await until(() => g.engine.sent.length === 2);
    g.engine.say(other.id, `앞서 받은 값 ${LATER}`);
    g.engine.finish(other.id);
    await until(() => g.manager.view.sessions.get(other.id)!.preview?.includes("앞서 받은 값") === true);
    await g.credentials.add({ name: "나중", kind: "other", site: "", values: { 값: LATER } });
    expect((await g.api("POST", `/api/sessions/${session.id}/messages`, { requestId: "r2", text: `다음엔 ${VALUE} 로 로그인`, mode: "queue" })).status).toBe(202);
    const from = g.events.length;
    g.engine.finish(session.id);
    await until(() => g.manager.items(session.id).items.some((item) => item.kind === "user" && item.id === "user:r2"));
    g.engine.say(session.id, `로그인했습니다 ${VALUE}`);
    g.engine.finish(session.id);
    await until(() => g.manager.view.sessions.get(session.id)!.status === "idle");
    const items = await g.json<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`);
    const sent = items.items.find((item) => item.id === "user:r2")!;
    expect(sent.kind === "user" && sent.text).toBe("다음엔 [비밀: 포털] 로 로그인");
    // (An item written before its value was stored keeps it: hidden from then on, not in older items; see the report.)
    expect(formsIn(VALUE, JSON.stringify(items)), "items").toEqual([]);
    for (const value of [VALUE, LATER]) {
      // (A session event may still carry the queue as it was a moment before: that is the draft, as typed.)
      expect(formsIn(value, JSON.stringify(withoutDrafts(g.events.slice(from)))), "broadcasts").toEqual([]);
      const found = await g.api("GET", `/api/search?q=${encodeURIComponent("로그인")}`);
      expect(formsIn(value, found.text), "index").toEqual([]);
    }
    // The walk: no route returns a stored value inside an item or a session line (drafts aside).
    vi.spyOn(g.manager, "documentSession").mockReturnValue(g.manager.view.sessions.get(other.id)! as never);
    vi.spyOn(g.manager, "browserSession").mockResolvedValue(g.manager.view.sessions.get(session.id)! as never);
    vi.spyOn(g.manager, "importSession").mockResolvedValue(g.manager.view.sessions.get(session.id)! as never);
    const answers: [string, { status: number; text: string }][] = [
      ["GET /api/snapshot", await g.api("GET", "/api/snapshot")],
      ["PATCH /api/sessions/:id", await g.api("PATCH", `/api/sessions/${session.id}`, { seen: true })],
      ["POST /api/artifacts/:id/document-session", await g.api("POST", "/api/artifacts/a1/document-session", {})],
      ["POST /api/browser/pages/:id/session", await g.api("POST", "/api/browser/pages/p1/session", { parentSessionId: null })],
      ["POST /api/import", await g.api("POST", "/api/import", { provider: "claude", nativeSessionId: "n1" })],
      ["POST /api/sessions/:id/fork", await g.api("POST", `/api/sessions/${session.id}/fork`, { itemId: "user:r2" })],
      ["GET /api/tasks", await g.api("GET", "/api/tasks")],
      ["GET /api/sessions/:id/items", await g.api("GET", `/api/sessions/${session.id}/items`)],
      ["PATCH /api/sessions/:id (the other)", await g.api("PATCH", `/api/sessions/${other.id}`, { seen: true })],
      ["POST /api/works/:id/sessions", await g.api("POST", `/api/works/${work.id}/sessions`, { provider: "claude" })],
    ];
    for (const [route, answer] of answers) {
      expect(answer.status, route).toBeLessThan(300);
      const text = JSON.stringify(withoutDrafts(JSON.parse(answer.text)));
      expect(formsIn(VALUE, text), route).toEqual([]);
      // The older assistant item itself (above) is the one place LATER stays; everything else is a session line or a new item.
      if (route !== "GET /api/sessions/:id/items") expect(formsIn(LATER, text), route).toEqual([]);
    }
    // The session line written before LATER was stored is hidden on the way out (not vacuous).
    // Every broadcast meanwhile (the other conversation's line went out again when it was marked seen).
    expect(formsIn(LATER, JSON.stringify(withoutDrafts(g.events.slice(from)))), "broadcasts of the walk").toEqual([]);
    expect(g.events.slice(from).some((event) => event.type === "session.upserted" && event.session.id === other.id)).toBe(true);
    for (const route of ["GET /api/snapshot", "POST /api/artifacts/:id/document-session", "PATCH /api/sessions/:id (the other)"]) expect(answers.find(([name]) => name === route)![1].text, route).toContain("[비밀: 나중]");
  });
});
