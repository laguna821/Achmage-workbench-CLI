import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { scmPatchRows, type ScmArea, type ScmReviewBatchRequest, type ScmReviewCreate, type ScmReviewSelection, type Session, type Work } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { ScmReviews, type ScmReviewHooks } from "./scm-review.ts";
import { emptyStatus, type ProviderAdapter } from "./providers/types.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const lines = () => Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`);
function fixture(initial = lines().join(""), path = "한글.txt", unborn = false) {
  const dir = mkdtempSync(join(tmpdir(), "wb-review-")), root = join(dir, "repo"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const write = (text: string | Buffer, name = path) => writeFileSync(join(root, name), text);
  git("init", "-q", "-b", "main"); git("config", "user.name", "Review Test"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false"); git("config", "core.autocrlf", "false");
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD").trim(); };
  write(initial); if (!unborn) commit();
  let store: Store, manager: SessionManager;
  const start = () => { store = new Store(join(dir, "state.sqlite")); manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: join(dir, "data") }); };
  start();
  const work = manager!.createWork({ title: "의견 검토", cwd: root }), id = work.defaultWorkspaceId!;
  const restart = async () => { await manager.shutdown(); store.close(); start(); };
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const diff = async (area: ScmArea = "working", name = path) => manager.sourceControl.diff(id, name, area, (await manager.sourceControl.status(id)).revision);
  const create = async (selection: ScmReviewSelection | null = { side: "after", start: 5, end: 5 }, body = "확인 부탁합니다") => manager.scmReviews.create(id, { requestId: randomUUID(), snapshotId: (await diff()).review!.id, selection, body });
  return { dir, root, path, git, write, commit, work, id, diff, create, restart, get manager() { return manager; }, get store() { return store; } };
}
function changed(f: ReturnType<typeof fixture>) { const text = lines(); text[4] = "reviewed code\n"; f.write(text.join("")); return text; }

it("saves the reviewed server-owned before/after range even when the disk changes before saving", async () => {
  const f = fixture(), bytes = changed(f), diff = await f.diff(), index = readFileSync(join(f.root, ".git/index"));
  f.write("external edit\n");
  const input: ScmReviewCreate = { requestId: randomUUID(), snapshotId: diff.review!.id, selection: { side: "after", start: 4, end: 6 }, body: "**검토** \n 코드 바꾸기" };
  const note = f.manager.scmReviews.create(f.id, { ...input, quote: ["forged"] } as ScmReviewCreate);
  expect(note.anchor.quote).toEqual(["line 4", "reviewed code", "line 6"]); expect(note.anchor.source.kind).toBe("local");
  expect(note.anchor.prefix).toEqual(["line 1", "line 2", "line 3"]); expect(note.anchor.contentHash).toMatch(/^[a-f0-9]{64}$/);
  const before = f.manager.scmReviews.create(f.id, { ...input, requestId: randomUUID(), selection: { side: "before", start: 5, end: 5 } }); expect(before.anchor.quote).toEqual(["line 5"]);
  expect(readFileSync(join(f.root, ".git/index"))).toEqual(index); expect(readFileSync(join(f.root, f.path), "utf8")).toBe("external edit\n"); expect(bytes[4]).toBe("reviewed code\n");
});

it("refuses invisible ranges, forged snapshots, wrong workspaces and oversized comments", async () => {
  const f = fixture(); changed(f); const view = await f.diff(), input = { requestId: randomUUID(), snapshotId: view.review!.id, body: "review", selection: { side: "after" as const, start: 1, end: 50 } };
  expect(() => f.manager.scmReviews.create(f.id, input)).toThrow(/표시된 연속/);
  expect(() => f.manager.scmReviews.create(f.id, { ...input, selection: { side: "after", start: 5, end: 105 } })).toThrow(/100행/);
  expect(() => f.manager.scmReviews.create(f.id, { ...input, selection: null, body: "한".repeat(6000) })).toThrow(/16 KiB/);
  const other = f.manager.createWork({ title: "other", cwd: f.root });
  expect(() => f.manager.scmReviews.create(other.defaultWorkspaceId!, { ...input, selection: null })).toThrow(/만료/);
  expect(() => f.manager.scmReviews.create(f.id, { ...input, snapshotId: "fake", selection: null })).toThrow(/만료/);
});

it("preserves BOM, CRLF-normalized displayed lines, EOF and literal path names", async () => {
  const f = fixture("\ufeffold\r\n++header\r\nlast", ':(glob) 한글"\n파일.txt');
  f.write("\ufeffnew\r\n++header\r\nlast changed"); const d = await f.diff(); expect(d.review?.lines).toBe(true);
  const n = f.manager.scmReviews.create(f.id, { requestId: randomUUID(), snapshotId: d.review!.id, body: "UTF-8", selection: { side: "after", start: 1, end: 3 } });
  expect(n.anchor.quote).toEqual(["\ufeffnew", "++header", "last changed"]); expect(n.anchor.path).toBe(f.path);
  const parsed = scmPatchRows(d.patch); expect(parsed.valid).toBe(true); expect(parsed.rows.find((r) => r.after === 3)?.text).toBe("+last changed");
  expect(scmPatchRows("@@ -1,2 +1,2 @@\n-x\n+y\n").valid).toBe(false); expect(scmPatchRows(d.patch + d.patch).valid).toBe(false);
});

it("anchors additions before the first commit and deletions from the old side", async () => {
  const f = fixture("new one\nnew two\n", "new.txt", true), d = await f.diff(); expect(d.review?.lines).toBe(true);
  const n = f.manager.scmReviews.create(f.id, { requestId: randomUUID(), snapshotId: d.review!.id, body: "new", selection: { side: "after", start: 1, end: 2 } }); expect(n.anchor.quote).toEqual(["new one", "new two"]);
  f.commit(); rmSync(join(f.root, f.path)); const removed = await f.diff();
  expect(f.manager.scmReviews.create(f.id, { requestId: randomUUID(), snapshotId: removed.review!.id, body: "deleted", selection: { side: "before", start: 1, end: 1 } }).anchor.quote).toEqual(["new one"]);
});

it("relocates unique text without changing the original anchor, and reports changed or ambiguous text", async () => {
  const f = fixture(), text = changed(f), note = await f.create();
  f.write("inserted\n" + text.join("")); let d = await f.diff();
  expect(f.manager.scmReviews.list(f.id, d.review!.id).placements[note.id]).toEqual({ kind: "moved", start: 6, end: 6 });
  f.write(text.join("") + text.join("")); d = await f.diff();
  expect(f.manager.scmReviews.list(f.id, d.review!.id).placements[note.id]?.kind).toBe("ambiguous");
  text[4] = "fixed now\n"; f.write(text.join("")); d = await f.diff();
  const saved = f.manager.scmReviews.list(f.id, d.review!.id); expect(saved.placements[note.id]?.kind).toBe("changed"); expect(saved.notes[0]!.anchor).toEqual(note.anchor); expect(saved.notes[0]!.resolved).toBe(false);
});

it("maps a Git-detected rename while keeping the original path and avoids another comparison scope", async () => {
  const f = fixture(); changed(f);
  const view = await f.manager.sourceControl.compare(f.id, { mode: "combined", baseRef: "HEAD" }), d = await f.manager.sourceControl.compareDiff(f.id, view.id, view.revision, f.path);
  const note = f.manager.scmReviews.create(f.id, { requestId: randomUUID(), snapshotId: d.review!.id, selection: { side: "after", start: 5, end: 5 }, body: "rename" });
  renameSync(join(f.root, f.path), join(f.root, "renamed.txt")); f.git("add", "-A");
  const next = await f.manager.sourceControl.compare(f.id, { mode: "combined", baseRef: "HEAD" }), renamed = await f.manager.sourceControl.compareDiff(f.id, next.id, next.revision, "renamed.txt");
  expect(f.manager.scmReviews.list(f.id, renamed.review!.id).placements[note.id]).toEqual({ kind: "moved", start: 5, end: 5 });
  const local = await f.diff("staged", "renamed.txt"); expect(f.manager.scmReviews.list(f.id, local.review!.id).placements[note.id]?.kind).toBe("other-scope");
});

it("stores notes outside the expiring cache, deduplicates creation and persists CAS edits/resolution across restart", async () => {
  const f = fixture(); changed(f); const d = await f.diff(), input: ScmReviewCreate = { requestId: randomUUID(), snapshotId: d.review!.id, selection: { side: "after", start: 5, end: 5 }, body: "first" };
  const note = f.manager.scmReviews.create(f.id, input); const saved = f.manager.scmReviews.edit(f.id, note.id, { version: 1, body: "updated", resolved: true });
  expect(() => f.manager.scmReviews.edit(f.id, note.id, { version: 1, body: "stale" })).toThrow(/다른 창/);
  await f.restart(); expect(f.manager.scmReviews.create(f.id, input)).toEqual(saved); expect(f.manager.scmReviews.list(f.id).notes[0]).toEqual(saved);
  expect(() => f.manager.scmReviews.create(f.id, { ...input, body: "different" })).toThrow(/다른 의견/);
  expect(() => f.manager.scmReviews.create(f.id, { ...input, requestId: randomUUID() })).toThrow(/만료/);
  const reopened = f.manager.scmReviews.edit(f.id, note.id, { version: 2, resolved: false }); expect(reopened.version).toBe(3);
  f.manager.scmReviews.edit(f.id, note.id, { version: 3, deleted: true }); expect(f.manager.scmReviews.list(f.id).notes).toEqual([]);
});

it("does not pin old notes into a different repository recreated at the same directory", async () => {
  const f = fixture(); changed(f); const note = await f.create();
  renameSync(f.root, join(f.dir, "old-repo")); mkdirSync(f.root); f.git("init", "-q", "-b", "main"); f.git("config", "user.name", "Replacement"); f.git("config", "user.email", "test@example.invalid"); f.git("config", "commit.gpgsign", "false"); f.write(lines().join("")); f.commit(); changed(f);
  const diff = await f.diff(); expect(f.manager.scmReviews.list(f.id, diff.review!.id).placements[note.id]?.kind).toBe("other-scope");
});

it("expires snapshots without losing saved notes, and supports file notes when text is unavailable", async () => {
  const f = fixture(); changed(f); const d = await f.diff(), note = await f.create();
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
  expect(() => f.manager.scmReviews.create(f.id, { requestId: randomUUID(), snapshotId: d.review!.id, selection: null, body: "late" })).toThrow(/만료/);
  expect(f.manager.scmReviews.list(f.id).notes[0]).toEqual(note); vi.restoreAllMocks();
  for (const content of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xff]), Buffer.from("large\n".repeat(7000))]) {
    f.write(content); const binary = await f.diff(); expect(binary.review?.lines).toBe(false);
    const file = f.manager.scmReviews.create(f.id, { requestId: randomUUID(), snapshotId: binary.review!.id, selection: null, body: "file comment" }); expect(file.anchor.selection).toBeNull();
  }
});

function engine(f: ReturnType<typeof fixture>, fail = false) {
  const sent: { text: string; cwd: string }[] = [];
  const adapter: ProviderAdapter = { provider: "claude", init: async () => {}, status: () => emptyStatus("claude"), refreshStatus: async () => emptyStatus("claude"), login: async () => ({ url: null, message: "" }), interrupt: async () => {}, answerApproval: async () => false, shutdown: async () => {}, send: async (session: Session, work: Work, text: string) => { if (fail) throw new Error("provider refused fixture"); sent.push({ text, cwd: work.cwd }); f.manager.sink.updateSession(session.id, { status: "running" }); } };
  f.manager.registerAdapter(adapter); return sent;
}
async function delivery(f: ReturnType<typeof fixture>) {
  changed(f); const note = await f.create(), session = f.manager.createSession(f.work.id, { provider: "claude", workspaceId: f.id, purpose: "review target" });
  const request: ScmReviewBatchRequest = { requestId: randomUUID(), sessionId: session.id, notes: [{ id: note.id, version: note.version }] };
  return { note, session, request };
}

it("delivers one immutable batch to the exact workspace, preserves edited note versions and never auto-resolves", async () => {
  const f = fixture(), { note, request } = await delivery(f), sent = engine(f);
  const [one, duplicate] = await Promise.all([f.manager.scmReviews.send(f.id, request), f.manager.scmReviews.send(f.id, request)]);
  expect(one.phase).toBe("accepted"); expect(one.id).toBe(duplicate.id); expect(sent).toHaveLength(1); expect(sent[0]!.cwd).toBe(f.root); expect(sent[0]!.text).toContain('"reviewed code"');
  f.manager.scmReviews.edit(f.id, note.id, { version: 1, body: "new feedback" });
  const state = f.manager.scmReviews.list(f.id); expect(state.notes[0]).toMatchObject({ version: 2, resolved: false }); expect(state.batches[0]!.notes[0]!.body).toBe("확인 부탁합니다");
  expect((await f.manager.scmReviews.send(f.id, request)).id).toBe(one.id); expect(sent).toHaveLength(1);
  await expect(f.manager.scmReviews.send(f.id, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: "scm_review_changed" });
});

it("rejects cross-workspace, archived and resolved targets before engine dispatch", async () => {
  const f = fixture(), { request, session, note } = await delivery(f), sent = engine(f);
  const other = f.manager.createWork({ title: "other", cwd: f.root }), alien = f.manager.createSession(other.id, { provider: "claude" });
  await expect(f.manager.scmReviews.send(f.id, { ...request, sessionId: alien.id })).rejects.toMatchObject({ code: "scm_review_target" });
  f.manager.updateSession(session.id, { archived: true }); await expect(f.manager.scmReviews.send(f.id, request)).rejects.toMatchObject({ code: "scm_review_target" });
  f.manager.updateSession(session.id, { archived: false }); f.manager.scmReviews.edit(f.id, note.id, { version: 1, resolved: true });
  await expect(f.manager.scmReviews.send(f.id, { ...request, notes: [{ id: note.id, version: 2 }] })).rejects.toMatchObject({ code: "scm_review_changed" }); expect(sent).toHaveLength(0);
});

it("reports provider failure even though SessionManager returned a receipt, without retrying the same batch", async () => {
  const f = fixture(), { request } = await delivery(f); engine(f, true);
  const batch = await f.manager.scmReviews.send(f.id, request); expect(batch.phase).toBe("failed"); expect(batch.detail).toContain("provider refused"); expect(f.store.findRequest(batch.requestId)).not.toBeNull();
  expect((await f.manager.scmReviews.send(f.id, request)).phase).toBe("failed"); await f.restart(); expect(f.manager.scmReviews.list(f.id).batches[0]!.phase).toBe("failed");
});

it("uses queue mode without steering, detects edited/canceled queues, and accepts actual later delivery", async () => {
  const f = fixture(), { request, session } = await delivery(f), sent = engine(f);
  await f.manager.send(session.id, "first-turn", "already running");
  const batch = await f.manager.scmReviews.send(f.id, request); expect(batch.phase).toBe("queued"); expect(sent).toHaveLength(1);
  f.manager.updateQueued(session.id, batch.requestId, "different queued text"); expect(f.manager.scmReviews.list(f.id).batches[0]!.phase).toBe("changed");
  f.manager.cancelQueued(session.id, batch.requestId);
  const canceled = await f.manager.scmReviews.send(f.id, { ...request, requestId: randomUUID() }); f.manager.cancelQueued(session.id, canceled.requestId);
  expect(f.manager.scmReviews.list(f.id).batches.find((b) => b.id === canceled.id)?.phase).toBe("uncertain");
  const waiting = await f.manager.scmReviews.send(f.id, { ...request, requestId: randomUUID() });
  f.manager.sink.updateSession(session.id, { status: "idle" }); await f.manager.sendQueued(session.id, waiting.requestId);
  expect(f.manager.scmReviews.list(f.id).batches.find((b) => b.id === waiting.id)?.phase).toBe("accepted");
});

it("persists the batch before delayed dispatch and never replays an uncertain sending record on restart", async () => {
  const f = fixture(), { request, note, session } = await delivery(f);
  let release!: () => void, calls = 0;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const hooks: ScmReviewHooks = { targets: () => [{ id: session.id, provider: "claude", purpose: "held", status: "idle" }], evidence: () => ({ receipt: true, sent: null, queued: null, failure: null }), send: async () => { calls++; await wait; return { duplicate: false, delivery: "turn" }; } };
  const reviews = new ScmReviews(f.store, f.manager.workspaces, f.manager.sourceControl.reviewSnapshots, hooks), send = reviews.send(f.id, request);
  const before = reviews.list(f.id).batches[0]!; expect(before.phase).toBe("sending"); expect(before.notes[0]).toEqual(note);
  f.manager.scmReviews.edit(f.id, note.id, { version: 1, body: "edited during delivery" });
  expect((await reviews.send(f.id, request)).id).toBe(before.id); expect(calls).toBe(1);
  const recovered = new ScmReviews(f.store, f.manager.workspaces, f.manager.sourceControl.reviewSnapshots, hooks);
  expect(recovered.list(f.id).batches[0]!.phase).toBe("uncertain"); expect(recovered.list(f.id).batches[0]!.phase).toBe("uncertain");
  expect((await recovered.send(f.id, request)).id).toBe(before.id); expect(calls).toBe(1);
  reviews.stop(); const write = vi.spyOn(f.store, "setMeta"); release(); expect((await send).phase).toBe("uncertain"); expect(write).not.toHaveBeenCalled(); write.mockRestore();
  expect(recovered.list(f.id).notes[0]!.body).toBe("edited during delivery"); expect(recovered.list(f.id).batches[0]!.notes[0]!.version).toBe(1);
});
