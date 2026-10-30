import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ScmComparison, ScmComparisonRequest } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(unborn = false) {
  const dir = mkdtempSync(join(tmpdir(), "wb-compare-")), root = join(dir, "repo"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", "-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const write = (path: string, text: string | Buffer) => writeFileSync(join(root, path), text);
  git("init", "-q", "-b", "main"); git("config", "user.name", "Comparison Test"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false"); git("config", "core.autocrlf", "false");
  write("note.txt", "original\n");
  const commit = (message = "fixture") => { git("add", "."); git("commit", "-qm", message); return git("rev-parse", "HEAD").trim(); };
  const base = unborn ? null : commit("base");
  const store = new Store(join(dir, "state.sqlite")), manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  const work = manager.createWork({ title: "비교 검토", cwd: root }), id = work.defaultWorkspaceId!, scm = manager.sourceControl;
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const compare = (request: ScmComparisonRequest) => scm.compare(id, request);
  const diff = (view: ScmComparison, path: string) => scm.compareDiff(id, view.id, view.revision, path);
  return { dir, root, git, write, commit, base: base!, store, manager, id, scm, compare, diff };
}

it("distinguishes merge-base from endpoints and pins selected refs across branch and HEAD movement", async () => {
  const f = fixture(); f.write("main.txt", "main only\n"); const main = f.commit(); f.git("checkout", "-qb", "topic", f.base); f.write("note.txt", "topic one\n"); const tip = f.commit();
  const merge = await f.compare({ mode: "branch", baseRef: "main", headRef: "topic" });
  expect(merge.beforeOid).toBe(f.base); expect(merge.baseOid).toBe(main); expect(merge.headOid).toBe(tip); expect(merge.files.map((v) => v.path)).toEqual(["note.txt"]);
  const ends = await f.compare({ mode: "branch", baseRef: "main", headRef: "topic", mergeBase: false }); expect(ends.files.find((v) => v.path === "main.txt")?.change).toBe("D");
  f.write("note.txt", "topic two\n"); f.commit(); f.git("checkout", "-q", "main"); f.write("main.txt", "later working\n");
  const diff = await f.diff(merge, "note.txt"); expect(diff.patch).toContain("+topic one"); expect(diff.patch).not.toContain("topic two"); expect(diff).not.toHaveProperty("hunks");
  expect((await f.compare({ mode: "branch", baseRef: "main", headRef: "topic" })).headOid).not.toBe(tip);
});

it("compares root creation and each real parent of a merge without synthesizing repository objects", async () => {
  const f = fixture(), root = await f.compare({ mode: "commit", headRef: f.base });
  expect(root.parents).toEqual([]); expect(root.beforeOid).toBeNull(); expect((await f.diff(root, "note.txt")).patch).toContain("+original");
  f.git("checkout", "-qb", "feature"); f.write("feature.txt", "feature\n"); const feature = f.commit(); f.git("checkout", "-q", "main"); f.write("main.txt", "main\n"); const main = f.commit(); f.git("merge", "--no-ff", "-qm", "merge", "feature");
  const one = await f.compare({ mode: "commit" }), two = await f.compare({ mode: "commit", parent: 2 });
  expect(one.parents).toEqual([main, feature]); expect(one.files.map((v) => v.path)).toEqual(["feature.txt"]); expect(two.files.map((v) => v.path)).toEqual(["main.txt"]);
  await expect(f.compare({ mode: "commit", parent: 3 })).rejects.toMatchObject({ code: "scm_compare_parent" });
});

it("combines committed, index, working and untracked changes including recreated and canceled intermediate files", async () => {
  const f = fixture(); f.write("recreate.txt", "old saved\n"); f.write("cancel.txt", "unchanged\n"); const start = f.commit();
  f.write("committed.txt", "already committed\n"); f.commit(); f.write("note.txt", "staged\n"); f.git("add", "note.txt"); f.write("note.txt", "working final\n");
  f.git("rm", "--cached", "recreate.txt"); f.write("recreate.txt", "recreated working\n"); f.write("cancel.txt", "index only\n"); f.git("add", "cancel.txt"); f.write("cancel.txt", "unchanged\n"); f.write("untracked.txt", "new\n");
  const index = readFileSync(join(f.root, ".git/index")), objects = readdirSync(join(f.root, ".git/objects"), { recursive: true }).sort();
  const view = await f.compare({ mode: "combined", baseRef: start });
  expect(view.files.map((v) => v.path)).toEqual(["cancel.txt", "committed.txt", "note.txt", "recreate.txt", "untracked.txt"]);
  expect((await f.diff(view, "note.txt")).patch).toContain("+working final"); expect((await f.diff(view, "note.txt")).patch).not.toContain("staged");
  const recreated = await f.diff(view, "recreate.txt"); expect(recreated.patch).toContain("-old saved"); expect(recreated.patch).toContain("+recreated working");
  expect((await f.diff(view, "cancel.txt")).patch).toBe(""); expect((await f.diff(view, "cancel.txt")).notice).toContain("중간 스테이징");
  expect((await f.diff(view, "untracked.txt")).patch).toContain("+new"); expect(readFileSync(join(f.root, ".git/index"))).toEqual(index); expect(readdirSync(join(f.root, ".git/objects"), { recursive: true }).sort()).toEqual(objects); expect(readFileSync(join(f.root, "recreate.txt"), "utf8")).toBe("recreated working\n");
});

it("supports unborn combined review including staged files changed or deleted again", async () => {
  const f = fixture(true); f.git("add", "note.txt"); f.write("note.txt", "unborn working\n"); f.write("gone.txt", "staged\n"); f.git("add", "gone.txt"); rmSync(join(f.root, "gone.txt"));
  const view = await f.compare({ mode: "combined" }); expect(view.beforeOid).toBeNull(); expect(view.files.map((v) => v.path)).toEqual(["gone.txt", "note.txt"]);
  expect((await f.diff(view, "note.txt")).patch).toContain("+unborn working"); expect((await f.diff(view, "gone.txt")).patch).toBe("");
  await expect(f.compare({ mode: "commit" })).rejects.toMatchObject({ code: "scm_compare_ref" });
});

it("preserves literal renamed paths and both image sides, regardless of caller diff configuration", async () => {
  const f = fixture(), old = ':(glob) 한글"\n전.png', next = ':(glob) 한글"\n후.png', image = Buffer.from([137, 80, 78, 71, 0, 1, 2]);
  f.write(old, image); const before = f.commit(); renameSync(join(f.root, old), join(f.root, next)); const after = f.commit();
  f.git("config", "diff.external", "this-command-must-not-run"); f.git("config", "diff.noprefix", "true"); f.git("config", "diff.outputIndicatorNew", ">");
  const view = await f.compare({ mode: "branch", baseRef: before, headRef: after, mergeBase: false }); expect(view.files).toHaveLength(1); expect(view.files[0]).toMatchObject({ path: next, oldPath: old, change: "R" });
  const result = await f.diff(view, next); expect(result.images?.before).toBe(`data:image/png;base64,${image.toString("base64")}`); expect(result.images?.after).toBe(result.images?.before); expect(result.patch).toContain("rename from");
});

it("rejects stale working snapshots, forged revisions, arbitrary file paths and another workspace's snapshot", async () => {
  const f = fixture(); f.write("note.txt", "changed\n"); const view = await f.compare({ mode: "combined" });
  await expect(f.scm.compareDiff(f.id, view.id, "0".repeat(64), "note.txt")).rejects.toMatchObject({ code: "scm_compare_changed" });
  await expect(f.diff(view, "../outside")).rejects.toMatchObject({ code: "scm_compare_file" });
  const other = f.manager.createWork({ title: "other", cwd: f.root }); await expect(f.scm.compareDiff(other.defaultWorkspaceId!, view.id, view.revision, "note.txt")).rejects.toMatchObject({ code: "scm_compare_expired" });
  f.write("new.txt", "external\n"); await expect(f.diff(view, "note.txt")).rejects.toMatchObject({ code: "scm_compare_changed" });
  expect(f.scm.list(f.id)).toEqual([]);
});

it("pins stamps for clean committed paths in a working comparison, even after contents are restored", async () => {
  const f = fixture(); f.write("committed.txt", "stable\n"); f.commit(); const view = await f.compare({ mode: "combined", baseRef: f.base });
  f.write("committed.txt", "temporary\n"); f.write("committed.txt", "stable\n");
  await expect(f.diff(view, "committed.txt")).rejects.toMatchObject({ code: "scm_compare_changed" });
});

it("reviews link bytes without following image links or opening nested repositories", async () => {
  const f = fixture(), external = join(f.dir, "outside.png"); writeFileSync(external, "PRIVATE\0BYTES"); symlinkSync(external, join(f.root, "link.png"));
  const view = await f.compare({ mode: "combined" }), diff = await f.diff(view, "link.png"); expect(diff.images).toBeUndefined(); expect(diff.patch).toContain(external); expect(diff.patch).not.toContain("PRIVATE");
  mkdirSync(join(f.root, "nested")); execFileSync("git", ["init", "-q", join(f.root, "nested")]); writeFileSync(join(f.root, "nested", "note"), "nested");
  const nested = await f.compare({ mode: "combined" }); expect((await f.diff(nested, "nested/")).notice).toContain("서브모듈");
});

it("uses actual commit objects despite replacement refs and rejects absent or ambiguous ancestry", async () => {
  const f = fixture(); f.write("note.txt", "replacement bytes\n"); const second = f.commit(); f.git("replace", "-f", f.base, second);
  const actual = await f.compare({ mode: "commit", headRef: f.base }); expect(actual.parents).toEqual([]); expect((await f.diff(actual, "note.txt")).patch).toContain("+original");
  await expect(f.compare({ mode: "commit", headRef: "--output=bad" })).rejects.toMatchObject({ code: "scm_compare_ref" });
  f.git("replace", "-d", f.base); f.git("checkout", "--orphan", "orphan"); f.git("rm", "-rf", "."); f.write("orphan.txt", "unrelated\n"); f.commit();
  await expect(f.compare({ mode: "branch", baseRef: "main" })).rejects.toMatchObject({ code: "scm_compare_ancestor" });
  expect((await f.compare({ mode: "branch", baseRef: "main", mergeBase: false })).files.length).toBeGreaterThan(0);
});

it("does not mislabel shallow commits as roots and surfaces missing history instead of fabricated additions", async () => {
  const f = fixture(); f.write("note.txt", "second\n"); const second = f.commit(); writeFileSync(join(f.root, ".git/shallow"), second + "\n");
  const view = await f.compare({ mode: "commit", headRef: second }); expect(view.beforeOid).toBe(f.base); expect((await f.diff(view, "note.txt")).patch).toContain("-original");
  rmSync(join(f.root, ".git/objects", f.base.slice(0, 2), f.base.slice(2)));
  await expect(f.compare({ mode: "commit", headRef: second })).rejects.toThrow();
});

it("bounds large changes and presents unsupported untracked encoding and mode metadata without mutation", async () => {
  const f = fixture(); f.write("note.txt", Array.from({ length: 7000 }, (_, i) => `changed ${i}\n`).join("")); f.write("invalid.bin", Buffer.from([255, 254, 1])); f.write("huge.txt", Buffer.alloc(9 * 1024 * 1024, 97));
  const view = await f.compare({ mode: "combined" }); expect((await f.diff(view, "note.txt")).truncated).toBe(true); expect((await f.diff(view, "invalid.bin")).binary).toBe(true); expect((await f.diff(view, "huge.txt")).notice).toContain("8 MiB");
  chmodSync(join(f.root, "note.txt"), 0o755); await expect(f.diff(view, "note.txt")).rejects.toMatchObject({ code: "scm_compare_changed" });
});

it("refuses non-UTF8 path bytes instead of replacing them with another filename", async () => {
  const f = fixture(), rawPath = Buffer.concat([Buffer.from(f.root + "/"), Buffer.from([255]), Buffer.from(".txt")]); writeFileSync(rawPath, "raw path");
  await expect(f.compare({ mode: "combined" })).rejects.toMatchObject({ code: "scm_path_encoding" });
  f.git("add", "."); f.git("commit", "-qm", "raw name");
  await expect(f.compare({ mode: "commit" })).rejects.toMatchObject({ code: "scm_path_encoding" });
});

it("uses the linked workspace's recorded starting commit as the default combined base", async () => {
  const f = fixture(), path = join(f.dir, "linked"); f.git("worktree", "add", "-b", "linked", path, f.base);
  const linked = await f.manager.worktreeWorkspaces.connect(f.id, path, f.base);
  writeFileSync(join(path, "note.txt"), "linked committed\n"); execFileSync("git", ["-C", path, "commit", "-qam", "linked"]);
  const view = await f.scm.compare(linked.id, { mode: "combined" }); expect(view.beforeOid).toBe(f.base); expect(view.files.map((v) => v.path)).toEqual(["note.txt"]);
  expect((await f.scm.compareDiff(linked.id, view.id, view.revision, "note.txt")).patch).toContain("+linked committed"); expect(readFileSync(join(f.root, "note.txt"), "utf8")).toBe("original\n");
});

it("does not fetch a missing promised object during comparison", async () => {
  const f = fixture(), remote = join(f.dir, "remote.git"); execFileSync("git", ["clone", "--bare", "--no-hardlinks", f.root, remote], { stdio: "pipe" });
  const view = await f.compare({ mode: "commit" }), blob = f.git("rev-parse", "HEAD:note.txt").trim(), objectPath = join(f.root, ".git/objects", blob.slice(0, 2), blob.slice(2));
  f.git("remote", "add", "origin", remote); f.git("config", "remote.origin.promisor", "true"); f.git("config", "remote.origin.partialclonefilter", "blob:none"); rmSync(objectPath);
  // Git can reuse a clean checkout for an identical blob without fetching it. Force an object read.
  f.write("note.txt", "different working bytes\n");
  await expect(f.diff(view, "note.txt")).rejects.toThrow(); expect(existsSync(objectPath)).toBe(false); expect(readdirSync(join(f.root, ".git/objects/pack"))).toEqual([]);
});

it("refuses a tracked path underneath a substituted directory symlink", async () => {
  const f = fixture(); mkdirSync(join(f.root, "folder")); f.write("folder/note.txt", "tracked\n"); f.commit();
  const external = join(f.dir, "outside"); mkdirSync(external); writeFileSync(join(external, "note.txt"), "never read\n"); rmSync(join(f.root, "folder"), { recursive: true }); symlinkSync(external, join(f.root, "folder"));
  const view = await f.compare({ mode: "combined" }); await expect(f.diff(view, "folder/note.txt")).rejects.toMatchObject({ code: "scm_compare_path" });
});

it("persists bounded preferences per workspace without replacing global settings or storing unknown fields", async () => {
  const f = fixture(), other = f.manager.createWork({ title: "other", cwd: f.root }); f.store.setMeta("ui.prefs", '{"theme":"dark"}');
  expect(f.scm.comparisonPreferences(f.id)).toBeNull();
  const value = { mode: "branch" as const, base: "main", head: "topic", merge: false, parent: 2, wrap: true };
  expect(f.scm.saveComparisonPreferences(f.id, { ...value, ignored: "no" } as typeof value)).toEqual(value);
  expect(f.scm.comparisonPreferences(other.defaultWorkspaceId!)).toBeNull(); expect(f.store.getMeta("ui.prefs")).toBe('{"theme":"dark"}');
  expect(() => f.scm.saveComparisonPreferences(f.id, { ...value, parent: 0 })).toThrow(); expect(() => f.scm.saveComparisonPreferences(f.id, { ...value, base: "x".repeat(1025) })).toThrow();
  expect(JSON.parse(f.store.getMeta(`scm-comparison-prefs:${f.id}`)!)).toEqual(value); expect(f.scm.comparisonPreferences(f.id)).toEqual(value);
});
