import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, RequestOrigin, Session, Work } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "../providers/types.ts";

// Who sent a request (a paired messenger chat) stays with it wherever it goes: on the request
// record, on the request while it waits in the queue (also across a restart, and after a stop
// dropped it from a running turn), and on the user item once it is in the conversation.

class Engine implements ProviderAdapter {
  readonly provider = "claude" as const;
  sent: string[] = [];
  steered: string[] = [];
  canSteer = true;
  private readonly sink: () => AdapterSink;
  private current: { sessionId: string; key: string } | null = null;
  constructor(sink: () => AdapterSink) { this.sink = sink; }
  async init() {}
  status(): ProviderStatus { return emptyStatus("claude"); }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }
  async send(session: Session, _work: Work, text: string, turnKey: string) {
    this.sent.push(text);
    this.current = { sessionId: session.id, key: turnKey };
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중" });
  }
  async steer(_session: Session, _work: Work, text: string) {
    if (!this.canSteer || !this.current) return false;
    this.steered.push(text);
    return true;
  }
  finish(status: "completed" | "interrupted" | "failed" = "completed") {
    const turn = this.current!;
    this.current = null;
    this.sink().upsertItem(turn.sessionId, { kind: "turnEnd", id: `end:${turn.key}`, status, durationMs: 1, at: Date.now() });
    this.sink().updateSession(turn.sessionId, { status: "idle", activity: null });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) { return false; }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function open(dir: string) {
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new Engine(() => manager.sink);
  manager.registerAdapter(engine);
  return { store, manager, engine };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-channel-origin-"));
  dirs.push(dir);
  const opened = open(dir);
  const work = opened.manager.createWork({ title: "강의" });
  mkdirSync(work.cwd, { recursive: true });
  const session = opened.manager.createSession(work.id, { provider: "claude" });
  return { dir, ...opened, session };
}
const tick = () => new Promise((done) => setTimeout(done, 5));
const sessionOf = (manager: SessionManager, id: string) => manager.snapshot().sessions.find((entry) => entry.id === id)!;
const userItem = (manager: SessionManager, sessionId: string, requestId: string) => manager.items(sessionId).items.find((item) => item.id === `user:${requestId}`);

const PHONE: RequestOrigin = { channel: "telegram", bindingId: "binding-1", context: 1 };

describe("who sent a request", () => {
  it("is kept on the request record and on its user item when it starts a turn", async () => {
    const f = setup();
    expect(await f.manager.send(f.session.id, "ch:telegram:1:100", "명단 정리해 줘", [], null, null, "auto", { origin: PHONE })).toEqual({ duplicate: false, delivery: "turn" });
    expect(userItem(f.manager, f.session.id, "ch:telegram:1:100")).toMatchObject({ kind: "user", text: "명단 정리해 줘", origin: PHONE });
    expect(f.store.requestOrigin("ch:telegram:1:100")).toEqual(PHONE);
  });

  it("is absent from a request typed at the PC (nothing is added to what was stored before)", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "PC에서 보낸 요청");
    expect(userItem(f.manager, f.session.id, "r1")).not.toHaveProperty("origin");
    expect(f.store.requestOrigin("r1")).toBeNull();
    expect(f.store.findRequest("r1")).toMatchObject({ sessionId: f.session.id });
  });

  it("stays with a request that waits for the running turn, and is on its user item when the turn's end sends it", async () => {
    const f = setup();
    f.engine.canSteer = false;
    await f.manager.send(f.session.id, "r1", "PC에서 먼저 시킨 일");
    expect(await f.manager.send(f.session.id, "ch:telegram:1:101", "끝나면 이것도", [], null, null, "auto", { origin: PHONE })).toEqual({ duplicate: false, delivery: "queued" });
    expect(sessionOf(f.manager, f.session.id).queued).toMatchObject([{ id: "ch:telegram:1:101", text: "끝나면 이것도", origin: PHONE }]);
    // Not in the conversation yet, and not recorded as sent.
    expect(userItem(f.manager, f.session.id, "ch:telegram:1:101")).toBeUndefined();
    f.engine.finish();
    await tick();
    expect(f.engine.sent).toEqual(["PC에서 먼저 시킨 일", "끝나면 이것도"]);
    expect(sessionOf(f.manager, f.session.id).queued).toEqual([]);
    expect(userItem(f.manager, f.session.id, "ch:telegram:1:101")).toMatchObject({ kind: "user", origin: PHONE });
    expect(f.store.requestOrigin("ch:telegram:1:101")).toEqual(PHONE);
  });

  it("survives a restart in the queue, and goes with the request when it is sent by hand", async () => {
    const f = setup();
    f.engine.canSteer = false;
    await f.manager.send(f.session.id, "r1", "먼저");
    await f.manager.send(f.session.id, "ch:telegram:1:102", "기다리는 요청", [], null, null, "auto", { origin: PHONE });
    await f.manager.shutdown();
    f.store.close();
    const again = open(f.dir);
    // After a restart waiting requests go only by hand; the origin is still there.
    expect(sessionOf(again.manager, f.session.id).queued).toMatchObject([{ id: "ch:telegram:1:102", held: true, origin: PHONE }]);
    expect(await again.manager.sendQueued(f.session.id, "ch:telegram:1:102")).toEqual({ duplicate: false, delivery: "turn" });
    expect(userItem(again.manager, f.session.id, "ch:telegram:1:102")).toMatchObject({ kind: "user", text: "기다리는 요청", origin: PHONE });
    expect(again.store.requestOrigin("ch:telegram:1:102")).toEqual(PHONE);
    expect(sessionOf(again.manager, f.session.id).queued).toEqual([]);
  });

  it("is on a request put into the running turn", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "보고서 써 줘");
    expect(await f.manager.send(f.session.id, "ch:telegram:1:103", "표는 빼고", [], null, null, "auto", { origin: PHONE })).toEqual({ duplicate: false, delivery: "steered" });
    expect(userItem(f.manager, f.session.id, "ch:telegram:1:103")).toMatchObject({ kind: "user", steered: true, origin: PHONE });
    expect(f.store.requestOrigin("ch:telegram:1:103")).toEqual(PHONE);
  });

  it("goes back to the queue with a request a stop dropped from the running turn", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "보고서 써 줘");
    await f.manager.send(f.session.id, "ch:telegram:1:104", "표는 빼고", [], null, null, "auto", { origin: PHONE });
    f.manager.sink.steerDropped(f.session.id, ["ch:telegram:1:104"]);
    const [again] = sessionOf(f.manager, f.session.id).queued;
    expect(again).toMatchObject({ text: "표는 빼고", held: true, origin: PHONE });
    f.engine.finish("interrupted");
    await tick();
    // Sent by hand later, it is still the phone's request.
    await f.manager.sendQueued(f.session.id, again!.id);
    expect(userItem(f.manager, f.session.id, again!.id)).toMatchObject({ kind: "user", origin: PHONE });
  });

  it("does not make the same request with another sender a different request (it is a duplicate, run once)", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "ch:telegram:1:105", "한 번만", [], null, null, "auto", { origin: PHONE });
    expect(await f.manager.send(f.session.id, "ch:telegram:1:105", "한 번만", [], null, null, "auto", { origin: PHONE })).toMatchObject({ duplicate: true });
    expect(f.engine.sent).toEqual(["한 번만"]);
  });
});

describe("the request record of an older gateway", () => {
  it("gains the sender column without losing a row, and an older gateway's statements still work on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-channel-origin-old-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    // The table as every released gateway made it.
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE requests (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text_hash TEXT NOT NULL, created_at INTEGER NOT NULL)");
    old.prepare("INSERT INTO requests (request_id, session_id, text_hash, created_at) VALUES (?, ?, ?, ?)").run("old-1", "s1", "h1", 1);
    old.close();
    const store = new Store(path);
    expect(store.findRequest("old-1")).toEqual({ sessionId: "s1", textHash: "h1" });
    expect(store.requestOrigin("old-1")).toBeNull();
    store.saveRequest("new-1", "s1", "h2", PHONE);
    store.close();
    // The older gateway again: its own insert and select, by column name, on the file as it is now.
    const back = new DatabaseSync(path);
    expect(Number(back.prepare("PRAGMA user_version").get()?.user_version)).toBe(1);
    back.prepare("INSERT INTO requests (request_id, session_id, text_hash, created_at) VALUES (?, ?, ?, ?)").run("old-2", "s1", "h3", 2);
    expect(back.prepare("SELECT session_id, text_hash FROM requests WHERE request_id = ?").get("new-1")).toMatchObject({ session_id: "s1", text_hash: "h2" });
    back.close();
    // Opening again adds nothing twice.
    const reopened = new Store(path);
    expect(reopened.requestOrigin("old-2")).toBeNull();
    expect(reopened.requestOrigin("new-1")).toEqual(PHONE);
    reopened.close();
  });
});
