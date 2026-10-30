import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ScmArea, ScmJob, ScmRequest } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", "-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const lines = () => Array.from({ length: 60 }, (_, i) => `line ${i + 1}\n`);
function fixture(path = "한글 파일.txt", initial = lines().join(""), unborn = false) {
  const dir = mkdtempSync(join(tmpdir(), "wb-hunks-")), root = join(dir, "repo"); mkdirSync(root);
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "Hunks Test"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "commit.gpgsign", "false"); git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, path), initial); if (!unborn) { git(root, "add", "."); git(root, "commit", "-qm", "base"); }
  const store = new Store(join(dir, "state.sqlite")), manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  const work = manager.createWork({ title: "구간 검토", cwd: root }), id = work.defaultWorkspaceId!, scm = manager.sourceControl;
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const state = () => scm.status(id), diff = async (area: ScmArea, file = path) => scm.diff(id, file, area, (await state()).revision);
  const finish = async (job: ScmJob) => { for (let n = 0; n < 250; n++) { const next = scm.get(job.id); if (next.phase !== "running") return next; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("hunk job timeout"); };
  const request = async (area: ScmArea, indices: number[], file = path): Promise<ScmRequest> => { const view = await diff(area, file); return { requestId: randomUUID(), expectedRevision: (await state()).revision, action: area === "working" ? "stage-hunks" : "unstage-hunks", selection: { path: file, expectedRevision: view.revision, hunks: indices.map((i) => view.hunks![i]!.id) } }; };
  const act = async (area: ScmArea, indices: number[], file = path) => finish(await scm.start(id, await request(area, indices, file)));
  return { dir, root, path, manager, scm, id, state, diff, request, act, finish };
}

it("stages only a later selected hunk despite earlier line-count changes, leaving working bytes and other files untouched", async () => {
  const f = fixture(), changed = lines(); changed.splice(0, 0, "prefix A\n", "prefix B\n"); changed[22] = "selected change\n"; changed[48] = "other change\n"; const working = changed.join(""); writeFileSync(join(f.root, f.path), working); writeFileSync(join(f.root, "unrelated.txt"), "never stage\n");
  const view = await f.diff("working"); expect(view.hunks).toHaveLength(3); const before = readFileSync(join(f.root, ".git", "index")); await f.diff("working"); expect(readFileSync(join(f.root, ".git", "index"))).toEqual(before);
  const job = await f.act("working", [1]); expect(job.phase, job.error ?? "").toBe("complete"); const expected = lines(); expected[20] = "selected change\n"; expect(git(f.root, "show", `:${f.path}`)).toBe(expected.join(""));
  expect(readFileSync(join(f.root, f.path), "utf8")).toBe(working); expect(git(f.root, "diff", "--cached", "--name-only").trim()).toBe(f.path);
  expect((await f.diff("working")).hunks).toHaveLength(2); expect((await f.act("working", [0, 1])).phase).toBe("complete"); expect(git(f.root, "show", `:${f.path}`)).toBe(working);
});

it("unstages selected cached changes while retaining other staged and newer working changes", async () => {
  const f = fixture(), staged = lines(); staged[2] = "staged first\n"; staged[40] = "staged second\n"; writeFileSync(join(f.root, f.path), staged.join("")); git(f.root, "add", ".");
  const working = [...staged]; working[20] = "later working\n"; writeFileSync(join(f.root, f.path), working.join(""));
  const job = await f.act("staged", [0]); expect(job.phase, job.error ?? "").toBe("complete"); const expected = lines(); expected[40] = "staged second\n";
  expect(git(f.root, "show", `:${f.path}`)).toBe(expected.join("")); expect(readFileSync(join(f.root, f.path), "utf8")).toBe(working.join("")); expect((await f.diff("staged")).hunks).toHaveLength(1);
});

it("rejects stale diff IDs and unknown hunks before a job", async () => {
  const f = fixture(), changed = lines(); changed[3] = "changed\n"; writeFileSync(join(f.root, f.path), changed.join(""));
  const old = await f.request("working", [0]); changed[4] = "external\n"; writeFileSync(join(f.root, f.path), changed.join(""));
  await expect(f.scm.start(f.id, { ...old, expectedRevision: (await f.state()).revision })).rejects.toMatchObject({ code: "scm_changed" });
  const fresh = await f.request("working", [0]); await expect(f.scm.start(f.id, { ...fresh, selection: { ...fresh.selection!, hunks: ["a".repeat(64)] } })).rejects.toMatchObject({ code: "scm_hunks" });
  expect(f.scm.list(f.id)).toHaveLength(0); expect(git(f.root, "diff", "--cached")).toBe("");
});

it("deduplicates selected hunks and ignores caller-authored patch text", async () => {
  const f = fixture(), changed = lines(); changed[15] = "selected\n"; writeFileSync(join(f.root, f.path), changed.join("")); const request = await f.request("working", [0, 0]);
  const [first, duplicate] = await Promise.all([f.scm.start(f.id, { ...request, patch: "forged patch" } as ScmRequest), f.scm.start(f.id, request)]); expect(first.id).toBe(duplicate.id); expect((await f.finish(first)).phase).toBe("complete");
  const index = readFileSync(join(f.root, ".git", "index")); expect((await f.scm.start(f.id, request)).id).toBe(first.id); expect(readFileSync(join(f.root, ".git", "index"))).toEqual(index); expect(f.scm.list(f.id)).toHaveLength(1); expect(f.scm.get(first.id).request).not.toHaveProperty("patch");
});

it("handles literal quote/newline/pathspec filenames independently of diff prefix and context configuration", async () => {
  const f = fixture(':(glob) 한글"\n탭\t.txt'), changed = lines(); changed[2] = "one\n"; changed[40] = "two\n"; writeFileSync(join(f.root, f.path), changed.join(""));
  git(f.root, "config", "diff.noprefix", "true"); git(f.root, "config", "diff.mnemonicPrefix", "true"); git(f.root, "config", "diff.interHunkContext", "100");
  expect((await f.diff("working")).hunks).toHaveLength(2); const job = await f.act("working", [1]); expect(job.phase, job.error ?? "").toBe("complete"); const expected = lines(); expected[40] = "two\n"; expect(git(f.root, "show", `:${f.path}`)).toBe(expected.join(""));
});

it("preserves no-final-newline markers and CRLF working bytes with text normalization", async () => {
  const f = fixture("eof.txt", lines().join("").trimEnd()), changed = lines(); changed[2] = "first\n"; changed[59] = "last without newline"; const working = changed.join(""); writeFileSync(join(f.root, f.path), working);
  expect((await f.act("working", [1])).phase).toBe("complete"); const expected = lines(); expected[59] = changed[59]!; expect(git(f.root, "show", `:${f.path}`)).toBe(expected.join("")); expect(readFileSync(join(f.root, f.path), "utf8")).toBe(working);
  const crlf = fixture("crlf.txt"); writeFileSync(join(crlf.root, ".gitattributes"), "*.txt text eol=crlf\n"); git(crlf.root, "add", "."); git(crlf.root, "commit", "-qm", "crlf attribute"); const edited = lines(); edited[5] = "한글 CRLF\n"; edited[35] = "later\n"; const bytes = edited.join("").replace(/\n/g, "\r\n"); writeFileSync(join(crlf.root, crlf.path), bytes);
  expect((await crlf.act("working", [0])).phase).toBe("complete"); expect(git(crlf.root, "show", `:${crlf.path}`)).toContain("한글 CRLF\n"); expect(readFileSync(join(crlf.root, crlf.path), "utf8")).toBe(bytes);
});

it("handles added/unborn and deleted whole-text hunks without removing or rewriting working files", async () => {
  const f = fixture("new.txt", "new\n", true); expect((await f.act("working", [0])).phase).toBe("complete"); expect(git(f.root, "show", ":new.txt")).toBe("new\n"); expect((await f.act("staged", [0])).phase).toBe("complete"); expect(git(f.root, "ls-files")).toBe(""); expect(readFileSync(join(f.root, f.path), "utf8")).toBe("new\n");
  const deleted = fixture(); rmSync(join(deleted.root, deleted.path)); expect((await deleted.act("working", [0])).phase).toBe("complete"); expect(git(deleted.root, "ls-files")).toBe("");
});

it("offers whole-file handling for binary, non-UTF8, truncated, rename, mode and link changes", async () => {
  const f = fixture(); writeFileSync(join(f.root, f.path), Buffer.from([0, 12, 4])); expect((await f.diff("working")).hunks).toHaveLength(0);
  writeFileSync(join(f.root, f.path), Buffer.from([0x66, 0xe9, 10])); expect((await f.diff("working")).partialReason).toContain("UTF-8");
  writeFileSync(join(f.root, f.path), "long line\n".repeat(9000)); expect((await f.diff("working")).partialReason).toContain("일부만");
  writeFileSync(join(f.root, f.path), "mode\n"); chmodSync(join(f.root, f.path), 0o755); expect((await f.diff("working")).partialReason).toContain("모드"); chmodSync(join(f.root, f.path), 0o644);
  const renamed = fixture(); renameSync(join(renamed.root, renamed.path), join(renamed.root, "renamed.txt")); git(renamed.root, "add", "-A"); expect((await renamed.diff("staged", "renamed.txt")).partialReason).toContain("이름");
  const link = fixture(); rmSync(join(link.root, link.path)); symlinkSync("some-target", join(link.root, link.path)); expect((await link.diff("working")).hunks).toHaveLength(0);
});

it("retains index and working files if Git refuses its index lock", async () => {
  const f = fixture(), changed = lines(); changed[3] = "pending\n"; writeFileSync(join(f.root, f.path), changed.join("")); const before = readFileSync(join(f.root, ".git", "index"));
  writeFileSync(join(f.root, ".git", "index.lock"), "external owner"); const job = await f.act("working", [0]); expect(job.phase).toBe("failed"); expect(job.error).toContain("index.lock"); expect(readFileSync(join(f.root, ".git", "index"))).toEqual(before); expect(readFileSync(join(f.root, f.path), "utf8")).toBe(changed.join(""));
});
