import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import type { PreparationOptions } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./sessions.ts";
import { WorkspacePreparation } from "./workspace-preparation.ts";
import { readIncludes, readOrca, relativeEntry } from "./preparation-config.ts";
import { git } from "./worktrees.ts";

const binary = process.env.PTY_TEST_BINARY || fileURLToPath(new URL("../../desktop/src-tauri/target/debug/achmage-workbench", import.meta.url));
const real = process.platform !== "win32" && existsSync(binary);
const all: PreparationOptions = { kind: "setup", applyPaths: true, runCommands: true, openTabs: true };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function directory() { const root = mkdtempSync(join(tmpdir(), "wb-prepare-")); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; }
async function until(check: () => boolean, ms = 8000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); } }
async function fixture(config: unknown = {}) {
  const root = directory(), primary = join(root, "primary"), data = join(root, "state"); mkdirSync(primary);
  await git(primary, ["init", "-b", "main"]); await git(primary, ["config", "user.name", "Test"]); await git(primary, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(primary, "orca.yaml"), stringify(config));
  writeFileSync(join(primary, ".gitignore"), ".env\n.cache/\nprivate/\n*.local\nlarge\n");
  writeFileSync(join(primary, "tracked.txt"), "original");
  await git(primary, ["add", "."]); await git(primary, ["commit", "-m", "fixture"]);
  const store = new Store(join(data, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "test", managedWorksDir: data, dataDir: data, ptyBinary: binary });
  cleanup.push(async () => { await manager.shutdown(); store.close(); });
  const work = manager.createWork({ title: "준비 검사", cwd: primary });
  const creation = manager.worktreeWorkspaces.start(work.id, { requestId: randomUUID(), sourceWorkspaceId: work.defaultWorkspaceId!, label: "feature", branch: "feature", baseRef: "HEAD" });
  await until(() => manager.worktreeWorkspaces.list(work.id).find((job) => job.id === creation.id)?.phase === "ready");
  const workspace = manager.workspaces.get(manager.worktreeWorkspaces.list(work.id)[0]!.workspaceId!), target = workspace.cwd, api = manager.preparation;
  const apply = async (opts = all) => { const preview = await api.preview(workspace.id, opts); const job = await api.start(workspace.id, { requestId: randomUUID(), expectedRevision: preview.revision, options: opts }); await until(() => ["complete", "failed", "canceled", "interrupted"].includes(api.get(job.id).phase)); return api.get(job.id); };
  return { root, primary, target, data, store, manager, work, workspace, api, apply };
}

it("rejects duplicate/aliased/oversized YAML as a whole and keeps bounded valid fields", () => {
  const root = directory(), path = join(root, "orca.yaml");
  writeFileSync(path, "scripts:\n  setup: echo first\n  setup: echo second\n");
  expect(readOrca(root)).toMatchObject({ setup: "", tabs: [] }); expect(readOrca(root).warnings.length).toBeGreaterThan(0);
  writeFileSync(path, "a: &a [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nscripts: {setup: echo should-not-run}\n");
  expect(readOrca(root).setup).toBe("");
  writeFileSync(path, "#".repeat(262145)); expect(readOrca(root).warnings[0]).toContain("256 KiB");
  writeFileSync(path, stringify({ scripts: { setup: "x".repeat(65537), archive: "echo kept" }, defaultTabs: [{ title: "Build", command: "echo build", color: "#abc" }], worktree: { sharedDirectories: ["./cache/", "cache", "nested/.git", "C:\\outside", "../escape"] } }));
  expect(readOrca(root)).toMatchObject({ setup: "", archive: "echo kept", shared: ["cache"], tabs: [{ title: "Build", command: "echo build", color: "#abc" }] });
});

it("parses literal include paths without accepting traversal, globs, drive paths or embedded Git directories", () => {
  const root = directory(); writeFileSync(join(root, ".worktreeinclude"), "# comment\n./.env\n.env\nfolder\\local/\n!except\n*.env\n/absolute\n../escape\ninner/.git/config\nfile # literal\n");
  expect(readIncludes(root).paths).toEqual([".env", "folder/local", "file # literal"]);
  for (const invalid of ["..", "a/./b", "a//b", "D:foo", "a\0b", "a\nb", "a/.GIT/b"]) expect(relativeEntry(invalid)).toBeNull();
});

it("previews primary copy/share rules and target hook/tabs without materializing or executing anything", async () => {
  const { primary, target, api, workspace } = await fixture({ scripts: { setup: "echo primary", archive: "echo primary-archive" }, worktree: { sharedDirectories: [".cache"] } });
  mkdirSync(join(primary, ".cache")); writeFileSync(join(primary, ".cache/value"), "shared"); writeFileSync(join(primary, ".env"), "fake-local-value");
  writeFileSync(join(primary, ".worktreeinclude"), ".env\ntracked.txt\nmissing.local\n");
  writeFileSync(join(target, "orca.yaml"), stringify({ scripts: { setup: "echo target", archive: "echo wrong-archive" }, defaultTabs: [{ title: "Target", command: "pwd" }], worktree: { sharedDirectories: ["wrong"] } }));
  const preview = await api.preview(workspace.id, all);
  expect(preview.hook.script).toBe("echo target"); expect(preview.tabs[0]!.title).toBe("Target");
  expect(preview.paths.map((entry) => [entry.path, entry.mode, entry.action])).toEqual([[".cache", "share", "apply"], [".env", "copy", "apply"], ["tracked.txt", "copy", "preserve"], ["missing.local", "copy", "skip"]]);
  expect(existsSync(join(target, ".env"))).toBe(false); expect(api.list(workspace.id)).toHaveLength(0);
  expect((await api.preview(workspace.id, { ...all, kind: "archive" })).hook.script).toBe("echo primary-archive");
});

it("copies independently, shares explicitly, retains nested links and never overwrites an existing destination", async () => {
  const { primary, target, api, workspace, apply } = await fixture({ worktree: { sharedDirectories: [".cache"] } });
  mkdirSync(join(primary, ".cache")); writeFileSync(join(primary, ".cache/value"), "shared");
  mkdirSync(join(primary, "private")); writeFileSync(join(primary, "private/local"), "private"); symlinkSync("local", join(primary, "private/link"));
  writeFileSync(join(primary, ".env"), "source"); writeFileSync(join(target, ".env"), "keep destination");
  writeFileSync(join(primary, ".worktreeinclude"), "private\n.env\n.cache/value\n");
  const job = await apply({ ...all, runCommands: false, openTabs: false }); expect(job.phase).toBe("complete");
  expect(realpathSync(join(target, ".cache"))).toBe(join(primary, ".cache")); expect(readlinkSync(join(target, "private/link"))).toBe("local");
  writeFileSync(join(target, "private/local"), "edited"); expect(readFileSync(join(primary, "private/local"), "utf8")).toBe("private");
  expect(readFileSync(join(target, ".env"), "utf8")).toBe("keep destination");
  const second = await api.start(workspace.id, { requestId: job.id, expectedRevision: job.preview.revision, options: job.preview.options }); expect(second.id).toBe(job.id); expect(api.list(workspace.id)).toHaveLength(1);
});

it("rejects stale preview before mutation and preserves escaped destination ancestors", async () => {
  const { root, primary, target, api, workspace, apply } = await fixture();
  writeFileSync(join(primary, ".env"), "before"); writeFileSync(join(primary, ".worktreeinclude"), ".env\n");
  const preview = await api.preview(workspace.id, all); writeFileSync(join(primary, ".env"), "changed-size");
  await expect(api.start(workspace.id, { requestId: randomUUID(), expectedRevision: preview.revision, options: all })).rejects.toThrow("미리보기 뒤"); expect(existsSync(join(target, ".env"))).toBe(false);
  const outside = join(root, "outside"); mkdirSync(outside); mkdirSync(join(primary, "private")); writeFileSync(join(primary, "private/x"), "do not escape"); symlinkSync(outside, join(target, "private"));
  writeFileSync(join(primary, ".worktreeinclude"), "private/x\n");
  const result = await apply({ ...all, runCommands: false, openTabs: false }); expect(result.phase).toBe("complete"); expect(result.preview.paths[0]!.action).toBe("skip"); expect(existsSync(join(outside, "x"))).toBe(false);
});

it("skips a sparse copy larger than the byte budget without reading its contents", async () => {
  const { primary, target, api, workspace } = await fixture(); writeFileSync(join(primary, "large"), ""); truncateSync(join(primary, "large"), 2 * 1024 * 1024 * 1024 + 1); writeFileSync(join(primary, ".worktreeinclude"), "large\n");
  const preview = await api.preview(workspace.id, all); expect(preview.paths[0]).toMatchObject({ action: "skip", reason: "복사 파일 2 GiB 한도를 넘었습니다." }); expect(existsSync(join(target, "large"))).toBe(false);
});

it("keeps personal settings separate, uses CAS and defaults to local hooks while suppressing YAML commands", async () => {
  const { primary, api, workspace, work } = await fixture({ scripts: { setup: "echo shared" }, defaultTabs: [{ title: "Shared tab", command: "echo shared-tab" }] });
  const before = readFileSync(join(primary, "orca.yaml"));
  const settings = api.settings(work.id); api.saveSettings(work.id, settings.revision, { ...settings, setupScript: "echo personal" });
  await expect(api.preview(workspace.id, all)).resolves.toMatchObject({ hook: { script: "echo personal", source: "local-only", }, tabs: [{ title: "Shared tab", command: null }] });
  expect(() => api.saveSettings(work.id, settings.revision, settings)).toThrow("다른 창"); expect(readFileSync(join(primary, "orca.yaml"))).toEqual(before);
});

it.skipIf(!real)("runs the exact target setup in an owned PTY with environment and creates each default terminal once", async () => {
  const { target, primary, api, workspace, manager, apply } = await fixture({ scripts: { setup: 'printf "%s\\n" "$ORCA_ROOT_PATH" "$ORCA_WORKTREE_PATH" "$ORCA_WORKSPACE_NAME" > setup.local' }, defaultTabs: [{ title: "Status", command: "printf 'TAB\\n' > tab.local", color: "#abc" }], setupAgentStartupPolicy: "wait-for-setup" });
  expect(() => api.assertAgentReady(workspace.id)).toThrow("준비 완료");
  const job = await apply(); expect(job.phase).toBe("complete"); expect(job.terminalIds).toHaveLength(2);
  await until(() => existsSync(join(target, "tab.local")));
  expect(readFileSync(join(target, "setup.local"), "utf8").split("\n")).toEqual([primary, target, target.split("/").at(-1), ""]);
  expect(manager.terminals.get(job.terminalIds[1]!)).toMatchObject({ label: "Status", color: "#abc" }); expect(() => api.assertAgentReady(workspace.id)).not.toThrow();
  const second = await apply(); expect(second.phase).toBe("complete"); expect(second.terminalIds[1]).toBe(job.terminalIds[1]); expect(manager.terminals.list(workspace.id).terminals).toHaveLength(3);
});

it.skipIf(!real)("blocks archive/removal after a failed hook until an explicit skip of that exact script", async () => {
  const { workspace, manager, work, target, primary, apply } = await fixture({ scripts: { archive: "printf 'ARCHIVE_FAILED\\n'; exit 9" } });
  const session = manager.createSession(work.id, { provider: "codex", workspaceId: workspace.id });
  expect(() => manager.updateWorkspace(workspace.id, { archived: true })).toThrow("보관 명령");
  const failed = await apply({ ...all, kind: "archive" }); expect(failed.phase).toBe("failed");
  await expect(manager.discardWorktree(session.id)).rejects.toThrow("보관 명령"); expect(existsSync(target)).toBe(true);
  const skipped = await apply({ ...all, kind: "archive", runCommands: false }); expect(skipped.phase).toBe("complete");
  await manager.discardWorktree(session.id); expect(existsSync(target)).toBe(false); expect(readFileSync(join(primary, "tracked.txt"), "utf8")).toBe("original");
});

it.skipIf(!real)("cancels only preparation-owned commands and keeps the exact partial output/files", async () => {
  const { api, workspace, manager, target } = await fixture({ scripts: { setup: "printf before > before.local; sleep 60; printf after > after.local" } });
  const preview = await api.preview(workspace.id, all), job = await api.start(workspace.id, { requestId: randomUUID(), expectedRevision: preview.revision, options: all });
  await until(() => existsSync(join(target, "before.local")));
  expect(() => manager.updateWorkspace(workspace.id, { archived: true })).toThrow("환경 준비");
  const canceled = await api.cancel(job.id); expect(canceled.phase).toBe("canceled"); expect(existsSync(join(target, "before.local"))).toBe(true); expect(existsSync(join(target, "after.local"))).toBe(false);
  expect(manager.terminals.get(canceled.hookTerminalId!).pid).toBeNull();
});

it("restores an interrupted job without replaying a script or deleting partial results", async () => {
  const { api, workspace, manager, store, data, work, target } = await fixture();
  const preview = await api.preview(workspace.id, all); writeFileSync(join(target, "partial.local"), "keep");
  store.savePreparation({ id: randomUUID(), workspaceId: workspace.id, workId: work.id, preview, phase: "hook", pathResults: [], terminalIds: [], hookTerminalId: null, error: null, createdAt: Date.now(), updatedAt: Date.now() });
  const restored = new WorkspacePreparation(store, manager.workspaces, manager.terminals, data, () => work);
  expect(restored.list(workspace.id)[0]!.phase).toBe("interrupted"); expect(restored.busy(target)).toBe(false); expect(lstatSync(join(target, "partial.local")).isFile()).toBe(true);
});

it("allows explicit archive-hook skip for a checkout already removed outside the app", async () => {
  const { primary, target, workspace, manager, apply } = await fixture({ scripts: { archive: "echo cleanup" } });
  await git(primary, ["worktree", "remove", "--force", target]);
  expect(() => manager.updateWorkspace(workspace.id, { archived: true })).toThrow("보관 명령");
  expect((await apply({ ...all, kind: "archive", runCommands: false })).phase).toBe("complete");
  expect(manager.updateWorkspace(workspace.id, { archived: true }).archivedAt).not.toBeNull();
  expect(existsSync(target)).toBe(false);
});

it("keeps shared links out of untracked patch application without hiding changed links or deleting source data", async () => {
  const { root, primary, target, manager, workspace, work, apply } = await fixture({ worktree: { sharedDirectories: [".cache"] } });
  mkdirSync(join(primary, ".cache")); writeFileSync(join(primary, ".cache/value"), "keep shared");
  expect((await apply({ ...all, runCommands: false, openTabs: false })).phase).toBe("complete");
  const session = manager.createSession(work.id, { provider: "codex", workspaceId: workspace.id });
  expect((await manager.worktreeChanges(session.id)).files).toEqual([]);
  writeFileSync(join(target, "tracked.txt"), "changed text");
  await manager.applyWorktree(session.id);
  expect(readFileSync(join(primary, "tracked.txt"), "utf8")).toBe("changed text");
  expect(readFileSync(join(primary, ".cache/value"), "utf8")).toBe("keep shared");
  const different = join(root, "different"); mkdirSync(different); writeFileSync(join(different, "data"), "keep different");
  rmSync(join(target, ".cache")); symlinkSync(different, join(target, ".cache"));
  expect((await manager.worktreeChanges(session.id)).files.some((file) => file.path === ".cache")).toBe(true);
  await manager.discardWorktree(session.id);
  expect(readFileSync(join(primary, ".cache/value"), "utf8")).toBe("keep shared"); expect(readFileSync(join(different, "data"), "utf8")).toBe("keep different");
});
