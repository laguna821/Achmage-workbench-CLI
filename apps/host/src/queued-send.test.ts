import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ProviderStatus, QueuedMessage, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// A waiting request leaves its queue at one moment: when its user item is written to the
// conversation. Before that, a failure leaves it waiting exactly as it was; after it, the request is
// in the conversation and a failure is said there. It is never in neither place, and never in both.

class Engine implements ProviderAdapter {
  readonly provider = "claude" as const;
  sent: string[] = [];
  steered: string[] = [];
  canSteer = true;
  /** Held open while the engine takes a steered request. */
  steerGate: Promise<void> | null = null;
  fail: string | null = null;
  private readonly sink: () => AdapterSink;
  private current: { sessionId: string; key: string } | null = null;
  constructor(sink: () => AdapterSink) { this.sink = sink; }
  async init() {}
  status(): ProviderStatus { return emptyStatus("claude"); }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }
  async send(session: Session, _work: Work, text: string, turnKey: string) {
    if (this.fail) throw new Error(this.fail);
    this.sent.push(text);
    this.current = { sessionId: session.id, key: turnKey };
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중" });
  }
  async steer(_session: Session, _work: Work, text: string) {
    if (!this.canSteer || !this.current) return false;
    this.steered.push(text);
    await this.steerGate;
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
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** The gateway over the data in `dir` (opened again on the same files after a restart). */
function open(dir: string) {
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new Engine(() => manager.sink);
  manager.registerAdapter(engine);
  return { store, manager, engine };
}

const views = (manager: SessionManager, sessionId: string) => {
  const now = () => manager.snapshot().sessions.find((entry) => entry.id === sessionId)!;
  const items = () => manager.items(sessionId).items;
  const userItems = () => items().flatMap((item) => (item.kind === "user" ? [item] : []));
  return { now, items, userItems };
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-queued-send-"));
  dirs.push(dir);
  const { store, manager, engine } = open(dir);
  const work = manager.createWork({ title: "강의" });
  mkdirSync(work.cwd, { recursive: true });
  const session = manager.createSession(work.id, { provider: "claude" });
  const picture = manager.attachments.save(PNG, "화면.png", "image/png");
  /** Two requests kept above the input: the first with a picture, both held (sent only by hand). */
  const waiting: QueuedMessage[] = [
    { id: "q1", text: "첫 요청", refs: [], create: null, at: 1, held: true, attachments: [picture] },
    { id: "q2", text: "둘째 요청", refs: [], create: null, at: 2, held: true },
  ];
  const keep = (queued: QueuedMessage[] = waiting) => manager.sink.updateSession(session.id, { queued });
  return { dir, manager, store, engine, work, session, picture, waiting, keep, ...views(manager, session.id) };
}

/** The app closes and opens again: nothing in memory survives, only what was written. */
async function restart(f: ReturnType<typeof setup>): Promise<ReturnType<typeof setup>> {
  await f.manager.shutdown();
  f.store.close();
  const { store, manager, engine } = open(f.dir);
  return { ...f, store, manager, engine, keep: (queued = f.waiting) => manager.sink.updateSession(f.session.id, { queued }), ...views(manager, f.session.id) };
}

/** A step of the send held open until `release`. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  return { gate, release };
}

const tick = () => new Promise((done) => setTimeout(done, 5));

/** Nothing of a request that did not reach the conversation: it waits as it did, and no trace says it was sent. */
function expectUntouched(f: ReturnType<typeof setup>, queued: QueuedMessage[] = f.waiting) {
  expect(f.now().queued).toEqual(queued);
  expect(f.items()).toEqual([]);
  expect(f.store.findRequest(queued[0]!.id)).toBeNull();
  expect(f.now().status).toBe("idle");
  expect(f.engine.sent).toEqual([]);
  expect(f.manager.documents.runningProposals(f.session.id)).toEqual([]);
}

describe("지금 보내기: a failure before the request reaches the conversation", () => {
  it("leaves it waiting as it was when the project-changes step fails, and the next 지금 보내기 really sends it", async () => {
    const f = setup();
    f.keep();
    f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("바뀐 것을 읽지 못했습니다");
    expectUntouched(f);
    // Not a "duplicate" that is reported as sent without sending: it goes to the engine now.
    f.manager.changeHook = null;
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.engine.sent).toEqual(["첫 요청"]);
    expect(f.userItems()).toMatchObject([{ id: "user:q1", text: "첫 요청", attachments: [f.picture] }]);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });

  it("leaves it waiting as it was when reading the user's skills fails", async () => {
    const f = setup();
    const hangul: QueuedMessage[] = [{ ...f.waiting[0]!, text: "한글 문서로 정리해 줘" }, f.waiting[1]!];
    f.keep(hangul);
    vi.spyOn(f.manager.userSkills, "list").mockRejectedValueOnce(new Error("스킬 목록을 읽지 못했습니다"));
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("스킬 목록을 읽지 못했습니다");
    expectUntouched(f, hangul);
  });

  it("leaves it waiting as it was when building the engine's text fails", async () => {
    const f = setup();
    f.keep();
    vi.spyOn(f.manager as unknown as { engineText: () => string }, "engineText").mockImplementationOnce(() => { throw new Error("요청문을 만들지 못했습니다"); });
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("요청문을 만들지 못했습니다");
    expectUntouched(f);
  });

  it("leaves it waiting as it was when marking its new document as sent fails, and it can still be sent under the same name", async () => {
    const f = setup();
    const creating: QueuedMessage[] = [{ ...f.waiting[0]!, create: { format: "markdown", name: "정리" } }, f.waiting[1]!];
    f.keep(creating);
    const update = f.manager.creations.update.bind(f.manager.creations);
    const spy = vi.spyOn(f.manager.creations, "update").mockImplementation((id, patch) => {
      if (patch.state === "sent") throw new Error("생성 기록을 쓰지 못했습니다");
      return update(id, patch);
    });
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("생성 기록을 쓰지 못했습니다");
    expectUntouched(f, creating);
    const reserved = f.manager.creations.get("q1")!.path;
    spy.mockRestore();
    // The turn that follows is not taken for one that was to make this document.
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "sent", path: reserved });
    expect(f.userItems()).toMatchObject([{ id: "user:q1", create: { path: reserved } }]);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });

  it("leaves it waiting as it was when a step fails after its new document's name was reserved (the document can still be made)", async () => {
    const f = setup();
    const creating: QueuedMessage[] = [{ ...f.waiting[0]!, create: { format: "markdown", name: "정리" } }, f.waiting[1]!];
    f.keep(creating);
    f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("바뀐 것을 읽지 못했습니다");
    expectUntouched(f, creating);
    f.manager.changeHook = null;
    expect((await f.manager.sendQueued(f.session.id, "q1")).delivery).toBe("turn");
    expect(f.manager.creations.get("q1")?.state).toBe("sent");
    expect(f.engine.sent).toHaveLength(1);
  });

  it("discards the working copy it prepared for a document, so no proposal appears for a request that was not sent", async () => {
    const f = setup();
    const file = join(f.work.cwd, "강의안.md");
    writeFileSync(file, "# 강의안\n");
    const artifact = f.manager.openFile(f.work.id, file);
    const editing: QueuedMessage[] = [{ ...f.waiting[0]!, refs: [{ artifactId: artifact.id, revision: 1, mode: "edit" }] }, f.waiting[1]!];
    f.keep(editing);
    f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("바뀐 것을 읽지 못했습니다");
    expectUntouched(f, editing);
    f.manager.changeHook = null;
    expect((await f.manager.sendQueued(f.session.id, "q1")).delivery).toBe("turn");
    expect(f.manager.documents.runningProposals(f.session.id)).toHaveLength(1);
  });

  it("refuses without touching it when one of its files is gone", async () => {
    const f = setup();
    const broken: QueuedMessage[] = [{ ...f.waiting[0]!, attachments: [{ ...f.picture, id: `${"0".repeat(64)}.png` }] }, f.waiting[1]!];
    f.keep(broken);
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("첨부 파일이 없습니다");
    expectUntouched(f, broken);
  });
});

describe("지금 보내기: once the request is in the conversation", () => {
  it("is out of the queue with its text and files in the conversation when the engine refuses it, and the failure is said there", async () => {
    const f = setup();
    f.keep();
    f.engine.fail = "engine missing";
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.now().queued).toEqual([f.waiting[1]]);
    expect(f.userItems()).toMatchObject([{ id: "user:q1", text: "첫 요청", attachments: [f.picture] }]);
    expect(f.items().find((item) => item.id === "error:q1")).toMatchObject({ kind: "notice", level: "error", text: "보내지 못했습니다: engine missing" });
    expect(f.now()).toMatchObject({ status: "error", lastError: "engine missing" });
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toMatchObject({ status: 404 });
  });

  it("is out of the queue and its failure is said in the conversation when a step after the user item fails", async () => {
    const f = setup();
    f.keep();
    vi.spyOn(f.store, "saveRequest").mockImplementationOnce(() => { throw new Error("기록하지 못했습니다"); });
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.now().queued).toEqual([f.waiting[1]]);
    expect(f.userItems()).toMatchObject([{ id: "user:q1", text: "첫 요청" }]);
    expect(f.items().find((item) => item.id === "error:q1")).toMatchObject({ kind: "notice", level: "error" });
    expect(f.engine.sent).toEqual([]);
  });

  it("sends once when 지금 보내기 is pressed twice", async () => {
    const f = setup();
    f.keep();
    const results = await Promise.allSettled([f.manager.sendQueued(f.session.id, "q1"), f.manager.sendQueued(f.session.id, "q1")]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { duplicate: false, delivery: "turn" } });
    // The second press is told the request is already on its way (or already gone), never sent again.
    expect(results[1]!.status === "rejected" ? (results[1] as PromiseRejectedResult).reason.status : (results[1] as PromiseFulfilledResult<{ duplicate: boolean }>).value.duplicate).toSatisfy((value: unknown) => value === 404 || value === true);
    expect(f.engine.sent).toEqual(["첫 요청"]);
    expect(f.userItems()).toHaveLength(1);
    expect(f.now().queued).toEqual([f.waiting[1]]);
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toMatchObject({ status: 404 });
  });

  it("sends a request that a stop between the two writes left both waiting and in the conversation, and it is then in one place", async () => {
    // The user item is written first, the queue second, the engine called last: found in both, the
    // request never reached the engine. Sending it must not be answered as already sent.
    const f = setup();
    f.keep();
    f.manager.sink.upsertItem(f.session.id, { kind: "user", id: "user:q1", text: "첫 요청", at: 1 });
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.engine.sent).toEqual(["첫 요청"]);
    expect(f.userItems()).toHaveLength(1);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });
});

describe("지금 보내기 while the engine works", () => {
  it("steers the request into the running turn: out of the queue once its user item is written", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "하던 일");
    f.keep();
    expect((await f.manager.sendQueued(f.session.id, "q2")).delivery).toBe("steered");
    expect(f.engine.steered).toEqual(["둘째 요청"]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1", "user:q2"]);
    expect(f.now().queued).toEqual([f.waiting[0]]);
  });

  it("keeps the request where it waits when the engine cannot take it now; it goes when the turn ends", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "하던 일");
    f.engine.canSteer = false;
    f.keep();
    expect((await f.manager.sendQueued(f.session.id, "q2")).delivery).toBe("queued");
    // Same place, text and files; no longer kept back, since the user asked to send it.
    expect(f.now().queued).toEqual([f.waiting[0], { ...f.waiting[1], held: false }]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1"]);
    f.engine.finish();
    await tick();
    expect(f.engine.sent).toEqual(["하던 일", "둘째 요청"]);
    expect(f.now().queued).toEqual([f.waiting[0]]);
  });
});

describe("a request sent by itself when the turn ends", () => {
  const following = (f: ReturnType<typeof setup>) => f.waiting.map((entry) => ({ ...entry, held: false }));

  it("leaves the queue once it is in the conversation", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "하던 일");
    f.keep(following(f));
    f.engine.finish();
    await tick();
    expect(f.engine.sent).toEqual(["하던 일", "첫 요청"]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1", "user:q1"]);
    expect(f.now().queued).toEqual([following(f)[1]]);
  });

  // After a failure requests go by hand only (the app's rule after a stop, an error or a restart).
  it("stays in its place with its text and files when it cannot be sent, kept for the person, and is not tried again by itself", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "하던 일");
    f.keep(following(f));
    f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    f.engine.finish();
    await tick();
    expect(f.engine.sent).toEqual(["하던 일"]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1"]);
    // Same order, text and files; both now wait for the person, the one behind it too.
    expect(f.now().queued).toEqual(f.waiting);
    expect(f.now().status).toBe("idle");
    expect(f.store.findRequest("q1")).toBeNull();
    const notice = f.items().find((item) => item.id === "queue-failed:q1");
    expect(notice).toMatchObject({ kind: "notice", level: "error" });
    expect(notice?.kind === "notice" ? notice.text : "").toMatch(/보내지 못했습니다: 바뀐 것을 읽지 못했습니다.*목록.*직접 보내/);
    // The next turn's end does not send it, nor the one behind it.
    f.manager.changeHook = null;
    await f.manager.send(f.session.id, "r2", "다른 일");
    f.engine.finish();
    await tick();
    expect(f.engine.sent).toEqual(["하던 일", "다른 일"]);
    expect(f.now().queued).toEqual(f.waiting);
    // By hand it really goes.
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.engine.sent).toEqual(["하던 일", "다른 일", "첫 요청"]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1", "user:r2", "user:q1"]);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });

  it("is in the conversation with the failure when the engine refuses it", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "하던 일");
    f.keep(following(f));
    f.engine.fail = "engine missing";
    f.engine.finish();
    await tick();
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1", "user:q1"]);
    expect(f.items().find((item) => item.id === "error:q1")).toMatchObject({ kind: "notice", level: "error" });
    expect(f.now().queued.map((entry) => entry.id)).toEqual(["q2"]);
  });
});

it("a request deleted while it was being sent is not sent", async () => {
  const f = setup();
  f.keep([{ ...f.waiting[0]!, text: "한글 문서로 정리해 줘" }, f.waiting[1]!]);
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const list = f.manager.userSkills.list.bind(f.manager.userSkills);
  vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
  const sending = f.manager.sendQueued(f.session.id, "q1");
  await tick();
  f.manager.cancelQueued(f.session.id, "q1");
  release();
  await expect(sending).rejects.toMatchObject({ status: 409 });
  expect(f.engine.sent).toEqual([]);
  expect(f.items()).toEqual([]);
  expect(f.now().queued).toEqual([f.waiting[1]]);
  expect(existsSync(f.work.cwd)).toBe(true);
});

it("a request edited while it was being sent is not sent: it still waits, as edited", async () => {
  const f = setup();
  f.keep([{ ...f.waiting[0]!, text: "한글 문서로 정리해 줘" }, f.waiting[1]!]);
  const { gate, release } = held();
  const list = f.manager.userSkills.list.bind(f.manager.userSkills);
  vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
  const sending = f.manager.sendQueued(f.session.id, "q1");
  await tick();
  f.manager.updateQueued(f.session.id, "q1", "한글 문서로 짧게 정리해 줘");
  release();
  await expect(sending).rejects.toMatchObject({ status: 409, code: "queued_changed" });
  expect(f.engine.sent).toEqual([]);
  expect(f.items()).toEqual([]);
  // An edit at the PC makes the request the person's own draft (R6, credential units 7-8).
  expect(f.now().queued).toEqual([{ ...f.waiting[0], text: "한글 문서로 짧게 정리해 줘", draft: true }, f.waiting[1]]);
});

// While the engine works a request is put into the running turn. Preparing a document it refers to
// can take seconds; what the person did to the request meanwhile is checked before the engine gets it.
describe("지금 보내기 into a running turn, when the request changes while it is prepared", () => {
  async function busyWithDocument() {
    const f = setup();
    const file = join(f.work.cwd, "강의안.md");
    writeFileSync(file, "# 강의안\n");
    const artifact = f.manager.openFile(f.work.id, file);
    await f.manager.send(f.session.id, "r1", "하던 일");
    const reading: QueuedMessage[] = [{ ...f.waiting[0]!, refs: [{ artifactId: artifact.id, revision: 1, mode: "review" }] }, f.waiting[1]!];
    f.keep(reading);
    const { gate, release } = held();
    const prepare = f.manager.documents.prepare.bind(f.manager.documents);
    vi.spyOn(f.manager.documents, "prepare").mockImplementationOnce(async (...args) => { await gate; return prepare(...args); });
    return { f, reading, release };
  }

  it("deleted while its document is prepared: nothing reaches the engine and nothing is written", async () => {
    const { f, release } = await busyWithDocument();
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    f.manager.cancelQueued(f.session.id, "q1");
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "queued_changed" });
    expect(f.engine.steered).toEqual([]);
    expect(f.engine.sent).toEqual(["하던 일"]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1"]);
    expect(f.store.findRequest("q1")).toBeNull();
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });

  it("edited while its document is prepared: nothing is sent and the edited request still waits", async () => {
    const { f, reading, release } = await busyWithDocument();
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    f.manager.updateQueued(f.session.id, "q1", "고친 요청");
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "queued_changed" });
    expect(f.engine.steered).toEqual([]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1"]);
    expect(f.now().queued).toEqual([{ ...reading[0], text: "고친 요청", draft: true }, f.waiting[1]]);
  });

  it("edited while the engine is taking it: what the engine got is in the conversation, and the edit stays in the list as a request of its own", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "하던 일");
    f.keep();
    const { gate, release } = held();
    f.engine.steerGate = gate;
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    f.manager.updateQueued(f.session.id, "q1", "고친 요청");
    release();
    expect((await sending).delivery).toBe("steered");
    expect(f.engine.steered).toEqual(["첫 요청"]);
    expect(f.userItems().map((item) => item.text)).toEqual(["하던 일", "첫 요청"]);
    // Kept for the person under a new id, so sending it later does not overwrite what was sent.
    const [edit, other] = f.now().queued;
    expect(edit).toMatchObject({ text: "고친 요청", held: true, attachments: [f.picture] });
    expect(edit!.id).not.toBe("q1");
    expect(other).toEqual(f.waiting[1]);
    f.engine.steerGate = null;
    expect((await f.manager.sendQueued(f.session.id, edit!.id)).delivery).toBe("steered");
    expect(f.userItems().map((item) => item.text)).toEqual(["하던 일", "첫 요청", "고친 요청"]);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });
});

// A conversation is idle while its request is prepared, so it can be archived meanwhile. The
// engine gets nothing for an archived conversation, whichever way the request was on its way.
describe("a conversation archived while its request is being prepared", () => {
  const HANGUL = "한글 문서로 정리해 줘";
  /** The next read of the user's skills (a step of preparing a Hangul request) is held open. */
  function preparing(f: ReturnType<typeof setup>) {
    const { gate, release } = held();
    const list = f.manager.userSkills.list.bind(f.manager.userSkills);
    vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
    return release;
  }
  const archive = (f: ReturnType<typeof setup>) => f.manager.updateSession(f.session.id, { archived: true });

  it("a direct send is refused as archived: nothing reaches the engine or the conversation, and what it prepared is undone", async () => {
    const f = setup();
    const file = join(f.work.cwd, "강의안.md");
    writeFileSync(file, "# 강의안\n");
    const artifact = f.manager.openFile(f.work.id, file);
    const refs = [{ artifactId: artifact.id, revision: 1, mode: "edit" as const }];
    const release = preparing(f);
    const sending = f.manager.send(f.session.id, "r1", HANGUL, refs);
    await tick();
    archive(f);
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "archived" });
    expect(f.engine.sent).toEqual([]);
    expect(f.items()).toEqual([]);
    expect(f.store.findRequest("r1")).toBeNull();
    expect(f.now()).toMatchObject({ status: "idle", queued: [] });
    expect(f.now().archivedAt).not.toBeNull();
    expect(f.manager.documents.runningProposals(f.session.id)).toEqual([]);
    // Brought back, the same request is sent (it was never recorded as sent).
    f.manager.updateSession(f.session.id, { archived: false });
    expect(await f.manager.send(f.session.id, "r1", HANGUL, refs)).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.engine.sent).toHaveLength(1);
  });

  it("지금 보내기 is refused as archived and the request waits as it was", async () => {
    const f = setup();
    const hangul: QueuedMessage[] = [{ ...f.waiting[0]!, text: HANGUL }, f.waiting[1]!];
    f.keep(hangul);
    const release = preparing(f);
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    archive(f);
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "archived" });
    expectUntouched(f, hangul);
  });

  it("지금 보내기 of a new document is refused as archived, and its reserved name stays usable", async () => {
    const f = setup();
    const creating: QueuedMessage[] = [{ ...f.waiting[0]!, text: HANGUL, create: { format: "markdown", name: "정리" } }, f.waiting[1]!];
    f.keep(creating);
    const release = preparing(f);
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    archive(f);
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "archived" });
    expectUntouched(f, creating);
    const reserved = f.manager.creations.get("q1")!;
    expect(reserved.state).toBe("ready");
    f.manager.updateSession(f.session.id, { archived: false });
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "sent", path: reserved.path });
  });

  it("the request sent by itself at the turn's end is not sent: it stays in the list, kept for the person, and the conversation says why", async () => {
    const f = setup();
    await f.manager.send(f.session.id, "r1", "하던 일");
    const hangul: QueuedMessage[] = [{ ...f.waiting[0]!, text: HANGUL }, f.waiting[1]!];
    f.keep(hangul.map((entry) => ({ ...entry, held: false })));
    const release = preparing(f);
    f.engine.finish();
    await tick();
    archive(f);
    release();
    await vi.waitFor(() => expect(f.items().some((item) => item.id === "queue-failed:q1")).toBe(true));
    expect(f.engine.sent).toEqual(["하던 일"]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1"]);
    expect(f.store.findRequest("q1")).toBeNull();
    // Same order, text and files; as after any request that could not be sent, both wait for the person.
    expect(f.now().queued).toEqual(hangul);
    expect(f.now().status).toBe("idle");
    const notice = f.items().find((item) => item.id === "queue-failed:q1");
    expect(notice?.kind === "notice" ? notice.text : "").toMatch(/보관한 대화/);
  });

  it("끼워 넣기 is refused as archived when the turn ended and the conversation was archived meanwhile: the engine is not handed the request", async () => {
    const f = setup();
    const file = join(f.work.cwd, "강의안.md");
    writeFileSync(file, "# 강의안\n");
    const artifact = f.manager.openFile(f.work.id, file);
    await f.manager.send(f.session.id, "r1", "하던 일");
    const reading: QueuedMessage[] = [{ ...f.waiting[0]!, refs: [{ artifactId: artifact.id, revision: 1, mode: "review" }] }, f.waiting[1]!];
    f.keep(reading);
    const { gate, release } = held();
    const prepare = f.manager.documents.prepare.bind(f.manager.documents);
    vi.spyOn(f.manager.documents, "prepare").mockImplementationOnce(async (...args) => { await gate; return prepare(...args); });
    // An engine that takes whatever it is handed.
    const steer = vi.spyOn(f.engine, "steer").mockResolvedValue(true);
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    f.engine.finish();
    archive(f);
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "archived" });
    expect(steer).not.toHaveBeenCalled();
    expect(f.engine.sent).toEqual(["하던 일"]);
    expect(f.userItems().map((item) => item.id)).toEqual(["user:r1"]);
    expect(f.store.findRequest("q1")).toBeNull();
    expect(f.now().queued).toEqual(reading);
  });
});

it("a request the person deleted while it was being sent at the turn's end is not reported as a failure, and the next one goes", async () => {
  const f = setup();
  await f.manager.send(f.session.id, "r1", "하던 일");
  f.keep([{ ...f.waiting[0]!, text: "한글 문서로 정리해 줘", held: false }, { ...f.waiting[1]!, held: false }]);
  const { gate, release } = held();
  const list = f.manager.userSkills.list.bind(f.manager.userSkills);
  vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
  f.engine.finish();
  await tick();
  f.manager.cancelQueued(f.session.id, "q1");
  release();
  await vi.waitFor(() => expect(f.engine.sent).toEqual(["하던 일", "둘째 요청"]));
  expect(f.items().filter((item) => item.kind === "notice")).toEqual([]);
  expect(f.userItems().map((item) => item.id)).toEqual(["user:r1", "user:q2"]);
  expect(f.now().queued).toEqual([]);
});

// A request for a new document reserves its name first. While the request still waits, that
// reservation must stay usable, also across a restart: it was never handed to the engine.
describe("a waiting request for a new document, after the app starts again", () => {
  const creating = (f: ReturnType<typeof setup>): QueuedMessage[] => [{ ...f.waiting[0]!, create: { format: "markdown", name: "정리" } }, f.waiting[1]!];
  const interruptedNotice = (f: ReturnType<typeof setup>) => f.items().filter((item) => item.id.startsWith("create-recovered:"));

  it("that failed before reaching the conversation is really sent, under the name it reserved, with no notice of an interrupted document", async () => {
    let f = setup();
    f.keep(creating(f));
    f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("바뀐 것을 읽지 못했습니다");
    const reserved = f.manager.creations.get("q1")!.path;
    f = await restart(f);
    expect(interruptedNotice(f)).toEqual([]);
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "ready", path: reserved });
    expect(f.now().queued).toEqual(creating(f));
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.engine.sent).toHaveLength(1);
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "sent", path: reserved });
    expect(f.userItems()).toMatchObject([{ id: "user:q1", create: { path: reserved } }]);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });

  it("whose queue write failed after its user item was written keeps a usable reservation, and is really sent after the restart", async () => {
    let f = setup();
    f.keep(creating(f));
    const manager = f.manager as unknown as { saveSession: (session: Session) => void };
    const save = manager.saveSession.bind(f.manager);
    vi.spyOn(manager, "saveSession").mockImplementation((session) => {
      if (f.userItems().length && session.queued.every((entry) => entry.id !== "q1")) throw new Error("대기 목록을 쓰지 못했습니다");
      save(session);
    });
    // In the conversation with the failure said on it, and still in the list: the engine never got it.
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    vi.restoreAllMocks();
    expect(f.engine.sent).toEqual([]);
    expect(f.items().find((item) => item.id === "error:q1")).toMatchObject({ kind: "notice", level: "error" });
    expect(f.now().queued.map((entry) => entry.id)).toEqual(["q1", "q2"]);
    const reserved = f.manager.creations.get("q1")!;
    expect(reserved.state).toBe("ready");
    f = await restart(f);
    expect(interruptedNotice(f)).toEqual([]);
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.engine.sent).toHaveLength(1);
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "sent", path: reserved.path });
    expect(f.userItems()).toHaveLength(1);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });

  it("left in both places by a stop between the two writes (reservation already marked sent) is really sent after the restart", async () => {
    let f = setup();
    f.keep(creating(f));
    f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow();
    // What the stop leaves on disk: the reservation marked sent, the user item written, the queue not yet.
    const reserved = f.manager.creations.update("q1", { state: "sent" })!.path;
    f.manager.sink.upsertItem(f.session.id, { kind: "user", id: "user:q1", text: "첫 요청", at: 1 });
    f = await restart(f);
    expect(interruptedNotice(f)).toEqual([]);
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "ready", path: reserved });
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.engine.sent).toHaveLength(1);
    expect(f.userItems()).toMatchObject([{ id: "user:q1", create: { path: reserved } }]);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });

  it("is still marked interrupted, with its notice, when its request no longer waits because the engine got it", async () => {
    let f = setup();
    f.keep(creating(f));
    expect((await f.manager.sendQueued(f.session.id, "q1")).delivery).toBe("turn");
    f = await restart(f);
    expect(f.manager.creations.get("q1")?.state).toBe("interrupted");
    expect(interruptedNotice(f)).toHaveLength(1);
  });
});

// A waiting request for a new document that was tried once holds a name and a file in the project
// folder. Deleting the request gives them up: the file goes only when it is still exactly the file
// the reservation made; and nothing is said about it, now or at the next start.
const creating = (f: ReturnType<typeof setup>): QueuedMessage[] => [{ ...f.waiting[0]!, create: { format: "markdown", name: "정리" } }, f.waiting[1]!];
/** A waiting request for a new document was tried and failed before reaching the conversation: its name and empty file are reserved. */
async function tried(f: ReturnType<typeof setup>, change: Partial<QueuedMessage> = {}) {
  f.keep([{ ...creating(f)[0]!, ...change }, f.waiting[1]!]);
  f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
  await expect(f.manager.sendQueued(f.session.id, "q1")).rejects.toThrow("바뀐 것을 읽지 못했습니다");
  f.manager.changeHook = null;
  const reserved = f.manager.creations.get("q1")!.path;
  expect(readFileSync(reserved, "utf8")).toBe("");
  return reserved;
}

describe("a waiting request for a new document that the person deletes after a failed send", () => {
  /** No reservation is held, and nothing in the conversation speaks of the request. */
  function expectReleased(f: ReturnType<typeof setup>) {
    expect(["reserved", "ready", "sent", "interrupted"]).not.toContain(f.manager.creations.get("q1")?.state);
    expect(f.items()).toEqual([]);
    expect(f.now().queued).toEqual([f.waiting[1]]);
  }

  it("removes the empty file it reserved, and the next start says nothing of an interrupted document", async () => {
    let f = setup();
    const reserved = await tried(f);
    f.manager.cancelQueued(f.session.id, "q1");
    expect(existsSync(reserved)).toBe(false);
    expectReleased(f);
    f = await restart(f);
    expectReleased(f);
    expect(existsSync(reserved)).toBe(false);
    // The name is free: a new request for the same document gets it.
    f.keep([{ ...creating(f)[0]!, id: "q9" }]);
    expect((await f.manager.sendQueued(f.session.id, "q9")).delivery).toBe("turn");
    expect(f.manager.creations.get("q9")?.path).toBe(reserved);
  });

  it("keeps the file when someone wrote into it, and says nothing, now or at the next start", async () => {
    let f = setup();
    const reserved = await tried(f);
    writeFileSync(reserved, "# 내가 쓴 글\n");
    f.manager.cancelQueued(f.session.id, "q1");
    expect(readFileSync(reserved, "utf8")).toBe("# 내가 쓴 글\n");
    expectReleased(f);
    f = await restart(f);
    expectReleased(f);
    expect(readFileSync(reserved, "utf8")).toBe("# 내가 쓴 글\n");
  });

  it("keeps what is at the reserved name when it is no longer that file but a link, and the file the link leads to", async () => {
    const f = setup();
    const reserved = await tried(f);
    const elsewhere = join(f.dir, "남의 빈 파일.md");
    writeFileSync(elsewhere, "");
    rmSync(reserved);
    symlinkSync(elsewhere, reserved);
    f.manager.cancelQueued(f.session.id, "q1");
    expect(lstatSync(reserved).isSymbolicLink()).toBe(true);
    expect(existsSync(elsewhere)).toBe(true);
    expectReleased(f);
  });

  it("deleted while it is being sent again: the send stops, and the reservation does not come back", async () => {
    let f = setup();
    // A Hangul request reads the user's skills after its name is reserved: held open there.
    const reserved = await tried(f, { text: "한글 문서로 정리해 줘" });
    const { gate, release } = held();
    const list = f.manager.userSkills.list.bind(f.manager.userSkills);
    vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    f.manager.cancelQueued(f.session.id, "q1");
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "queued_changed" });
    expect(f.engine.sent).toEqual([]);
    expect(existsSync(reserved)).toBe(false);
    expectReleased(f);
    f = await restart(f);
    expectReleased(f);
  });

  it("deleted while a document it refers to is prepared for sending it again: the same, and the send is told the request is gone", async () => {
    let f = setup();
    const file = join(f.work.cwd, "강의안.md");
    writeFileSync(file, "# 강의안\n");
    const artifact = f.manager.openFile(f.work.id, file);
    const reserved = await tried(f, { refs: [{ artifactId: artifact.id, revision: 1, mode: "review" }] });
    const { gate, release } = held();
    const prepare = f.manager.documents.prepare.bind(f.manager.documents);
    vi.spyOn(f.manager.documents, "prepare").mockImplementationOnce(async (...args) => { await gate; return prepare(...args); });
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    f.manager.cancelQueued(f.session.id, "q1");
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "queued_changed" });
    expect(f.engine.sent).toEqual([]);
    expect(existsSync(reserved)).toBe(false);
    expectReleased(f);
    f = await restart(f);
    expectReleased(f);
  });

  it("deleted while it is being sent for the first time: the name it reserved meanwhile is given up too", async () => {
    let f = setup();
    f.keep([{ ...creating(f)[0]!, text: "한글 문서로 정리해 줘" }, f.waiting[1]!]);
    const { gate, release } = held();
    const list = f.manager.userSkills.list.bind(f.manager.userSkills);
    vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    const reserved = f.manager.creations.get("q1")!.path;
    f.manager.cancelQueued(f.session.id, "q1");
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "queued_changed" });
    expect(existsSync(reserved)).toBe(false);
    expectReleased(f);
    f = await restart(f);
    expectReleased(f);
  });

  it("does not touch a file or a reservation when the deleted request was never tried", async () => {
    const f = setup();
    f.keep(creating(f));
    writeFileSync(join(f.work.cwd, "정리.md"), "");
    f.manager.cancelQueued(f.session.id, "q1");
    expect(existsSync(join(f.work.cwd, "정리.md"))).toBe(true);
    expect(f.manager.creations.get("q1")).toBeNull();
    expect(f.now().queued).toEqual([f.waiting[1]]);
  });
});

// The reservation was made for the request as it was. Edited, it is another request: the old
// reservation is given up as on a deletion, and the next send reserves for the request as it is now.
describe("a waiting request for a new document that the person edits after a failed send", () => {
  it("is really sent as edited by the next 지금 보내기, and the document is made under the name it asked for", async () => {
    const f = setup();
    const reserved = await tried(f);
    f.manager.updateQueued(f.session.id, "q1", "고친 요청");
    expect(f.now().queued).toEqual([{ ...creating(f)[0]!, text: "고친 요청", draft: true }, f.waiting[1]]);
    expect(await f.manager.sendQueued(f.session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.engine.sent).toHaveLength(1);
    expect(f.engine.sent[0]).toContain("고친 요청");
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "sent", path: reserved });
    expect(f.userItems()).toMatchObject([{ id: "user:q1", text: "고친 요청", create: { path: reserved } }]);
    expect(f.now().queued).toEqual([f.waiting[1]]);
    // The engine writes the document, the turn ends: it is one of the project's documents.
    writeFileSync(reserved, "# 정리\n");
    f.engine.finish();
    await vi.waitFor(() => expect(f.manager.creations.get("q1")?.state).toBe("completed"));
    expect(f.manager.snapshot().artifacts.map((artifact) => artifact.path)).toEqual([reserved]);
  });

  it("keeps what someone wrote into the file reserved before the edit, and makes the document under the next free name", async () => {
    const f = setup();
    const reserved = await tried(f);
    writeFileSync(reserved, "# 내가 쓴 글\n");
    f.manager.updateQueued(f.session.id, "q1", "고친 요청");
    expect((await f.manager.sendQueued(f.session.id, "q1")).delivery).toBe("turn");
    expect(readFileSync(reserved, "utf8")).toBe("# 내가 쓴 글\n");
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "sent", path: join(f.work.cwd, "정리 2.md") });
  });

  it("edited while it is being sent again: that send stops, and the edited request is then really sent", async () => {
    const f = setup();
    const reserved = await tried(f, { text: "한글 문서로 정리해 줘" });
    const { gate, release } = held();
    const list = f.manager.userSkills.list.bind(f.manager.userSkills);
    vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
    const sending = f.manager.sendQueued(f.session.id, "q1");
    await tick();
    f.manager.updateQueued(f.session.id, "q1", "고친 요청");
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "queued_changed" });
    expect(f.engine.sent).toEqual([]);
    expect(["reserved", "ready", "sent"]).not.toContain(f.manager.creations.get("q1")?.state);
    expect(existsSync(reserved)).toBe(false);
    expect((await f.manager.sendQueued(f.session.id, "q1")).delivery).toBe("turn");
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "sent", path: reserved });
    expect(f.userItems()).toMatchObject([{ id: "user:q1", text: "고친 요청" }]);
  });

  it("keeps its reservation when the text typed back is the same", async () => {
    const f = setup();
    const reserved = await tried(f);
    f.manager.updateQueued(f.session.id, "q1", ` ${f.waiting[0]!.text} `);
    expect(f.manager.creations.get("q1")).toMatchObject({ state: "ready", path: reserved });
    expect(existsSync(reserved)).toBe(true);
  });
});

// Asked for directly (not from the list), a request that does not reach the conversation is
// nowhere: nothing holds its reserved name, so the name and the untouched file are given up.
describe("a new document asked for directly whose request does not reach the conversation", () => {
  const HANGUL = "한글 문서로 정리해 줘";
  const target = { format: "markdown" as const, name: "정리" };
  /** The next read of the user's skills (after the name is reserved) is held open. */
  function preparing(f: ReturnType<typeof setup>) {
    const { gate, release } = held();
    const list = f.manager.userSkills.list.bind(f.manager.userSkills);
    vi.spyOn(f.manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
    return release;
  }
  /** No reservation is held and nothing in the conversation speaks of the request. */
  function expectGivenUp(f: ReturnType<typeof setup>) {
    expect(["reserved", "ready", "sent", "interrupted"]).not.toContain(f.manager.creations.get("d1")?.state);
    expect(f.items()).toEqual([]);
    expect(f.engine.sent).toEqual([]);
  }

  it("refused because the conversation was archived while it was prepared: no reserved name or file is left, and the next start says nothing", async () => {
    let f = setup();
    const release = preparing(f);
    const sending = f.manager.send(f.session.id, "d1", HANGUL, [], null, target);
    await tick();
    const reserved = f.manager.creations.get("d1")!.path;
    expect(existsSync(reserved)).toBe(true);
    f.manager.updateSession(f.session.id, { archived: true });
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "archived" });
    expect(existsSync(reserved)).toBe(false);
    expectGivenUp(f);
    f = await restart(f);
    expect(existsSync(reserved)).toBe(false);
    expectGivenUp(f);
    // Brought back, the same request is sent and gets the name.
    f.manager.updateSession(f.session.id, { archived: false });
    expect(await f.manager.send(f.session.id, "d1", HANGUL, [], null, target)).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.manager.creations.get("d1")).toMatchObject({ state: "sent", path: reserved });
  });

  it("failed at a step before the conversation: the same, and sending it again really sends it", async () => {
    let f = setup();
    f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    await expect(f.manager.send(f.session.id, "d1", "새 문서로", [], null, target)).rejects.toThrow("바뀐 것을 읽지 못했습니다");
    expect(existsSync(join(f.work.cwd, "정리.md"))).toBe(false);
    expectGivenUp(f);
    f = await restart(f);
    expectGivenUp(f);
    expect(await f.manager.send(f.session.id, "d1", "새 문서로", [], null, target)).toEqual({ duplicate: false, delivery: "turn" });
    expect(f.manager.creations.get("d1")).toMatchObject({ state: "sent", path: join(f.work.cwd, "정리.md") });
  });

  it("keeps what someone wrote into the reserved file meanwhile, and says nothing, now or at the next start", async () => {
    let f = setup();
    const release = preparing(f);
    f.manager.changeHook = () => { throw new Error("바뀐 것을 읽지 못했습니다"); };
    const sending = f.manager.send(f.session.id, "d1", HANGUL, [], null, target);
    await tick();
    const reserved = f.manager.creations.get("d1")!.path;
    writeFileSync(reserved, "# 내가 쓴 글\n");
    release();
    await expect(sending).rejects.toThrow("바뀐 것을 읽지 못했습니다");
    expectGivenUp(f);
    f = await restart(f);
    expectGivenUp(f);
    expect(readFileSync(reserved, "utf8")).toBe("# 내가 쓴 글\n");
  });
});
