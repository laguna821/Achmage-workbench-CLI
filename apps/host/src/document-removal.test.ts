import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, WorkbenchEvent } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { fileOps } from "./artifacts.ts";
import { scopedSnapshot, scopedEvent } from "./devices/scope.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// Two actions. "목록에서 빼기" (unlisted) is record-only: the file is never touched. "휴지통으로
// 옮기기" (trash) exists only in a narrow case the gateway proves at the moment of the move: a
// regular file of the app's own work area, no link on the way, same file system as the trash, no
// other document on the same file, every configured root resolvable, nothing working on it.

class IdleAdapter implements ProviderAdapter {
  readonly provider: "claude" | "codex";
  /** Requests the engine was handed. */
  sent = 0;
  private readonly sink: () => AdapterSink;
  constructor(provider: "claude" | "codex", sink: () => AdapterSink) {
    this.provider = provider;
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus { return emptyStatus(this.provider); }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }
  async send(session: Session) { this.sent += 1; this.sink().updateSession(session.id, { status: "running" }); }
  async interrupt(session: Session) { this.sink().updateSession(session.id, { status: "idle" }); }
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) { return false; }
  async shutdown() {}
}

function setup(extra: { worksDir?: (dir: string) => () => string; linkedWorks?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-removal-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  if (extra.linkedWorks) {
    // <data>/works is a link to a folder elsewhere (a synced folder, say).
    mkdirSync(join(dir, "Dropbox", "works"), { recursive: true });
    symlinkSync(join(dir, "Dropbox", "works"), join(dataDir, "works"));
  }
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const events: WorkbenchEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const options = { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir, ...(extra.worksDir ? { worksDir: extra.worksDir(dir) } : {}) };
  const manager = new SessionManager(store, bus, options);
  const engines = [new IdleAdapter("claude", () => manager.sink), new IdleAdapter("codex", () => manager.sink)];
  for (const engine of engines) manager.registerAdapter(engine);
  /** How many requests reached an engine. */
  const sent = () => engines.reduce((sum, engine) => sum + engine.sent, 0);
  // The app's own work area (no folder chosen): the only place the trash can take a file from.
  const work = manager.createWork({ title: "강의" });
  mkdirSync(work.cwd, { recursive: true });
  const file = join(work.cwd, "강의안.md");
  writeFileSync(file, "# 강의안\n\n첫 판\n");
  const artifact = manager.openFile(work.id, file);
  // A folder the user chose.
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const userWork = manager.createWork({ title: "내 폴더", cwd: project });
  const userFile = join(project, "메모.md");
  writeFileSync(userFile, "사용자 파일");
  const userDoc = manager.openFile(userWork.id, userFile);
  const restart = () => new SessionManager(store, new EventBus(), options);
  return { dir, dataDir, store, bus, events, manager, work, file, artifact, project, userWork, userFile, userDoc, restart, sent };
}

const realLink = fileOps.link, realDevice = fileOps.device;
afterEach(() => { fileOps.link = realLink; fileOps.device = realDevice; });

const trash = (manager: SessionManager, id: string) => manager.removeDocument(id, { action: "trash" });
const unlist = (manager: SessionManager, id: string) => manager.removeDocument(id, { action: "unlisted" });
const removedIds = (manager: SessionManager) => (manager.snapshot().removedArtifacts ?? []).map((entry) => entry.id);
const actions = (manager: SessionManager, id: string) => manager.documentRemoval(id).actions;

describe("the trash: only the narrow case", () => {
  it("moves a file of the app's own work area to the trash, keeps its revisions, and restores it", () => {
    const { manager, file, artifact, dataDir, events } = setup();
    expect(actions(manager, artifact.id)).toEqual(["unlisted", "trash"]);
    const removed = trash(manager, artifact.id);
    expect(removed.removed).toMatchObject({ kind: "trash" });
    expect(removed.removed!.pending).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(removed.removed!.trashPath!.startsWith(join(dataDir, "trash"))).toBe(true);
    expect(readFileSync(removed.removed!.trashPath!, "utf8")).toContain("첫 판");
    expect(removedIds(manager)).toEqual([artifact.id]);
    expect(manager.documents.removedRevisions(artifact.id)).toHaveLength(1);
    expect(events.some((event) => event.type === "artifact.removed" && event.artifact.id === artifact.id)).toBe(true);
    const restored = manager.restoreDocument(artifact.id);
    expect(restored.id).toBe(artifact.id);
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(manager.documents.revisions(artifact.id)).toHaveLength(1);
  });

  it("offers only 목록에서 빼기 for a folder the user chose, and never touches that file", () => {
    const { manager, userDoc, userFile } = setup();
    expect(actions(manager, userDoc.id)).toEqual(["unlisted"]);
    expect(() => trash(manager, userDoc.id)).toThrow(expect.objectContaining({ status: 409, code: "removal_changed" }));
    const removed = unlist(manager, userDoc.id);
    expect(removed.removed).toMatchObject({ kind: "unlisted" });
    expect(removed.removed!.trashPath).toBeUndefined();
    expect(readFileSync(userFile, "utf8")).toBe("사용자 파일");
    manager.restoreDocument(userDoc.id);
    expect(manager.snapshot().artifacts.some((entry) => entry.id === userDoc.id)).toBe(true);
  });

  // I-1: the action asked for is the action done, or a refusal; never the other one.
  it("unlists when asked to unlist even where the trash is possible", () => {
    const { manager, artifact, file } = setup();
    expect(unlist(manager, artifact.id).removed?.kind).toBe("unlisted");
    expect(readFileSync(file, "utf8")).toContain("첫 판");
  });

  it("is not offered in a git repository inside the work area", () => {
    const { manager, work, artifact } = setup();
    mkdirSync(join(work.cwd, ".git"));
    expect(actions(manager, artifact.id)).toEqual(["unlisted"]);
  });

  // C-1 / P5: a link appears on the way after the menu was shown; the move decides at that moment.
  it("decides at the moment of the move: a folder turned into a link refuses the trash", () => {
    const { manager, work, dir } = setup();
    mkdirSync(join(work.cwd, "sub"));
    writeFileSync(join(work.cwd, "sub", "a.md"), "안쪽");
    const doc = manager.openFile(work.id, join(work.cwd, "sub", "a.md"));
    expect(actions(manager, doc.id)).toContain("trash");
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "a.md"), "바깥 원본");
    rmSync(join(work.cwd, "sub"), { recursive: true });
    symlinkSync(join(dir, "outside"), join(work.cwd, "sub"));
    expect(() => trash(manager, doc.id)).toThrow(expect.objectContaining({ status: 409, code: "removal_changed" }));
    expect(readFileSync(join(dir, "outside", "a.md"), "utf8")).toBe("바깥 원본");
  });

  it("never stops anything: while its AI works both actions are refused and the AI keeps working", () => {
    const { manager, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    manager.sink.updateSession(agent.id, { status: "running" });
    expect(manager.documentRemoval(artifact.id)).toMatchObject({ actions: [], running: [{ id: agent.id }] });
    expect(() => trash(manager, artifact.id)).toThrow(expect.objectContaining({ status: 409, code: "document_busy" }));
    expect(() => unlist(manager, artifact.id)).toThrow(expect.objectContaining({ status: 409, code: "document_busy" }));
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.status).toBe("running");
  });

  it("refuses either action while an editor reports unsaved edits, and says so", () => {
    const { manager, artifact, file } = setup();
    manager.documents.registry.open(artifact.id, { viewId: "v", windowId: "w", claim: true, dirty: true });
    expect(manager.documentRemoval(artifact.id)).toMatchObject({ dirty: true });
    expect(() => unlist(manager, artifact.id)).toThrow(expect.objectContaining({ status: 409, code: "document_unsaved" }));
    expect(() => trash(manager, artifact.id)).toThrow(expect.objectContaining({ status: 409, code: "document_unsaved" }));
    expect(readFileSync(file, "utf8")).toContain("첫 판");
  });

  it("only unlists a symlink, never moving the link or its target", () => {
    const { manager, work, dir } = setup();
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "real.md"), "바깥 원본");
    symlinkSync(join(dir, "outside", "real.md"), join(work.cwd, "link.md"));
    const doc = manager.openFile(work.id, join(work.cwd, "link.md"));
    expect(actions(manager, doc.id)).toEqual(["unlisted"]);
    unlist(manager, doc.id);
    expect(lstatSync(join(work.cwd, "link.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, "outside", "real.md"), "utf8")).toBe("바깥 원본");
  });

  // P6: a configured vault that cannot be resolved means nothing is trashable.
  it("fails closed when the configured vault cannot be found", () => {
    const { manager, store, artifact, dir } = setup();
    store.setMeta("pkm.vault", join(dir, "moved-vault"));
    expect(manager.documentRemoval(artifact.id)).toMatchObject({ actions: ["unlisted"], reason: expect.stringContaining("볼트") });
  });

  it("is not offered inside the vault", () => {
    const { manager, store, work, artifact } = setup();
    store.setMeta("pkm.vault", work.cwd);
    expect(actions(manager, artifact.id)).toEqual(["unlisted"]);
  });

  // P11: another project on the same file through a link, and a hard link.
  it("is not offered when another document is the same file (by device and inode)", () => {
    const { manager, file, artifact, project, userWork } = setup();
    symlinkSync(file, join(project, "shared.md"));
    manager.openFile(userWork.id, join(project, "shared.md"));
    expect(actions(manager, artifact.id)).toEqual(["unlisted"]);
  });

  it("is not offered for a hard link another document tracks", () => {
    const { manager, file, artifact, project, userWork } = setup();
    linkSync(file, join(project, "twin.md"));
    manager.openFile(userWork.id, join(project, "twin.md"));
    expect(actions(manager, artifact.id)).toEqual(["unlisted"]);
  });

  it("is not offered when the file and the trash are on different file systems", () => {
    const { manager, artifact, dataDir } = setup();
    fileOps.device = (path: string) => (path.startsWith(join(dataDir, "trash")) ? 1 : realDevice(path));
    expect(manager.documentRemoval(artifact.id)).toMatchObject({ actions: ["unlisted"], reason: expect.stringContaining("같은 디스크") });
  });
});

describe("moves that never replace or lose anything", () => {
  it("moves by an exclusive link (into the trash and back), never by rename", () => {
    const { manager, artifact } = setup();
    const calls: string[][] = [];
    fileOps.link = ((from: string, to: string) => { calls.push([from, to]); realLink(from, to); }) as typeof fileOps.link;
    trash(manager, artifact.id);
    manager.restoreDocument(artifact.id);
    expect(calls).toHaveLength(2);
  });

  it("leaves the document as it was when the link fails, with no stray file", () => {
    const { manager, file, artifact, dataDir } = setup();
    fileOps.link = (() => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); }) as typeof fileOps.link;
    expect(() => trash(manager, artifact.id)).toThrow(/옮기지 못했습니다/);
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(manager.snapshot().artifacts.some((entry) => entry.id === artifact.id)).toBe(true);
    expect(removedIds(manager)).toEqual([]);
    const leftovers = existsSync(join(dataDir, "trash")) ? readdirSync(join(dataDir, "trash")) : [];
    expect(leftovers).toEqual([]);
  });

  it("does not restore over a file that took its place, nor over a dangling link", () => {
    const { manager, file, artifact, dir } = setup();
    trash(manager, artifact.id);
    writeFileSync(file, "새 파일");
    expect(() => manager.restoreDocument(artifact.id)).toThrow(/자리에 이미/);
    expect(readFileSync(file, "utf8")).toBe("새 파일");
    rmSync(file);
    symlinkSync(join(dir, "nowhere.md"), file);
    expect(() => manager.restoreDocument(artifact.id)).toThrow(/자리에 이미/);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  // P8: a restore cut short after the file was back: the document is listed again, nothing lost.
  it("finishes an interrupted restore at start without deleting its record or revisions", () => {
    const { manager, file, artifact, store, restart } = setup();
    const removed = trash(manager, artifact.id);
    linkSync(removed.removed!.trashPath!, file);
    rmSync(removed.removed!.trashPath!);
    store.saveArtifact({ ...removed, removed: { ...removed.removed!, pending: "restoring" } });
    const again = restart();
    expect(again.snapshot().artifacts.some((entry) => entry.id === artifact.id)).toBe(true);
    expect(again.documents.revisions(artifact.id)).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toContain("첫 판");
  });

  it("reports, never deletes, a move found in both places or neither, and trash files without a record", () => {
    const { manager, file, artifact, store, dataDir, restart } = setup();
    const removed = trash(manager, artifact.id);
    linkSync(removed.removed!.trashPath!, file);
    store.saveArtifact({ ...removed, removed: { ...removed.removed!, pending: "moving" } });
    writeFileSync(join(dataDir, "trash", "loose.md"), "잃은 파일");
    const again = restart();
    expect(again.documents.trashReport.some((line) => line.includes("강의안.md"))).toBe(true);
    expect(again.documents.trashReport.some((line) => line.includes("loose.md"))).toBe(true);
    expect(existsSync(file) && existsSync(removed.removed!.trashPath!) && existsSync(join(dataDir, "trash", "loose.md"))).toBe(true);
    expect((again.snapshot().removedArtifacts ?? []).some((entry) => entry.id === artifact.id)).toBe(true);
  });

  it("finishes a move recorded as in flight when the file is only in the trash", () => {
    const { manager, artifact, store, restart } = setup();
    const removed = trash(manager, artifact.id);
    store.saveArtifact({ ...removed, removed: { ...removed.removed!, pending: "moving" } });
    expect((restart().snapshot().removedArtifacts ?? []).find((entry) => entry.id === artifact.id)?.removed?.pending).toBeUndefined();
  });
});

describe("영구 삭제 and 다른 곳에 저장", () => {
  it("deletes for good only a trashed document; an unlisted one is never the app's to delete", () => {
    const { manager, artifact, userDoc, userFile, dataDir, events } = setup();
    unlist(manager, userDoc.id);
    expect(() => manager.purgeDocument(userDoc.id)).toThrow(expect.objectContaining({ status: 409 }));
    expect(readFileSync(userFile, "utf8")).toBe("사용자 파일");
    const removed = trash(manager, artifact.id);
    manager.purgeDocument(artifact.id);
    expect(existsSync(removed.removed!.trashPath!)).toBe(false);
    expect(existsSync(join(dataDir, "artifacts", artifact.id))).toBe(false);
    expect(events.some((event) => event.type === "artifact.purged" && event.artifactId === artifact.id)).toBe(true);
  });

  // A stored path is never trusted with a recursive delete: only a real folder directly inside the
  // real <data>/trash is removed. Anything else is refused, and nothing at all is deleted.
  describe("영구 삭제 of a record whose trash path is not a folder directly inside the app's trash", () => {
    /** A trashed document whose record was changed to say its file is at `path`; the gateway opened again on it. */
    function tampered(path: (f: ReturnType<typeof setup>, real: string, kept: string) => string) {
      const f = setup();
      const other = join(f.work.cwd, "다른 문서.md");
      writeFileSync(other, "다른 문서");
      const kept = trash(f.manager, f.manager.openFile(f.work.id, other).id);
      const removed = trash(f.manager, f.artifact.id);
      const real = removed.removed!.trashPath!;
      f.store.saveArtifact({ ...removed, removed: { ...removed.removed!, trashPath: path(f, real, kept.removed!.trashPath!) } });
      return { ...f, again: f.restart(), real, kept: kept.removed!.trashPath! };
    }
    /** Every file and folder under the test's folder (the database's own files aside). */
    const tree = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).filter((name) => !name.includes("state.sqlite")).sort();
    function expectNothingDeleted(f: ReturnType<typeof tampered>) {
      const before = tree(f.dir);
      expect(() => f.again.purgeDocument(f.artifact.id)).toThrow(expect.objectContaining({ status: 409, code: "trash_path" }));
      expect(tree(f.dir)).toEqual(before);
      expect(removedIds(f.again)).toContain(f.artifact.id);
      expect(f.again.documents.removedRevisions(f.artifact.id)).toHaveLength(1);
    }

    // Each place carries the document's own folder name where it can, so that it is the place, not the name, that is refused.
    type Place = (f: ReturnType<typeof setup>, real: string, kept: string) => string;
    const outside: Place = (f) => {
      const folder = join(f.dir, "outside", `${f.artifact.id}-1234abcd`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "강의안.md"), "바깥 파일");
      return join(folder, "강의안.md");
    };
    const trashItself: Place = (f) => join(f.dataDir, "trash", "강의안.md");
    const deeper: Place = (f) => {
      const folder = join(f.dataDir, "trash", "안쪽", `${f.artifact.id}-1234abcd`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "강의안.md"), "안쪽 파일");
      return join(folder, "강의안.md");
    };
    const anotherDocument: Place = (_f, _real, kept) => kept;
    const linkOutside: Place = (f) => {
      symlinkSync(f.project, join(f.dataDir, "trash", `${f.artifact.id}-link`));
      return join(f.dataDir, "trash", `${f.artifact.id}-link`, "메모.md");
    };
    const linkToItsOwnFolder: Place = (f, real) => {
      symlinkSync(join(real, ".."), join(f.dataDir, "trash", `${f.artifact.id}-link`));
      return join(f.dataDir, "trash", `${f.artifact.id}-link`, "강의안.md");
    };
    const places = [
      ["a folder outside the trash", outside],
      ["the trash itself", trashItself],
      ["a folder deeper inside the trash", deeper],
      ["another document's folder in the trash", anotherDocument],
    ] as const;
    const links = [
      ["a link in the trash that leads outside", linkOutside],
      ["a link in the trash that leads to the document's own folder", linkToItsOwnFolder],
    ] as const;

    it.each([...places, ...links])("refuses %s", (_name, place) => {
      const f = tampered(place);
      expectNothingDeleted(f);
      expect(readFileSync(f.real, "utf8")).toContain("첫 판");
      expect(readFileSync(f.kept, "utf8")).toBe("다른 문서");
    });

    // The trash moved elsewhere and <data>/trash a link to it: the same refusals.
    it.each([...places, ...links])("refuses %s when the trash is itself a link", (_name, place) => {
      const f = tampered(place);
      renameSync(join(f.dataDir, "trash"), join(f.dir, "moved-trash"));
      symlinkSync(join(f.dir, "moved-trash"), join(f.dataDir, "trash"));
      expectNothingDeleted(f);
      expect(readFileSync(f.real, "utf8")).toContain("첫 판");
      expect(readFileSync(f.kept, "utf8")).toBe("다른 문서");
    });

    // The trash deleted by hand: a record that points anywhere but its own folder directly in it is still refused.
    it.each(places)("refuses %s when the trash is gone", (_name, place) => {
      const f = tampered(place);
      rmSync(join(f.dataDir, "trash"), { recursive: true });
      expectNothingDeleted(f);
      expect(existsSync(join(f.dataDir, "trash"))).toBe(false);
    });

    it("deletes the record for good when the trash itself is gone: there is nothing to delete, and no folder is deleted", () => {
      const f = setup();
      trash(f.manager, f.artifact.id);
      rmSync(join(f.dataDir, "trash"), { recursive: true });
      const before = tree(f.dir).filter((name) => !name.startsWith(join("data", "artifacts", f.artifact.id)));
      f.manager.purgeDocument(f.artifact.id);
      expect(removedIds(f.manager)).toEqual([]);
      expect(tree(f.dir)).toEqual(before);
      expect(existsSync(join(f.dataDir, "trash"))).toBe(false);
    });

    it("says the file is not in the trash when asked to restore while the trash is gone", () => {
      const { manager, artifact, dataDir } = setup();
      trash(manager, artifact.id);
      rmSync(join(dataDir, "trash"), { recursive: true });
      expect(() => manager.restoreDocument(artifact.id)).toThrow(expect.objectContaining({ status: 409, code: "trash_file_missing" }));
      expect(removedIds(manager)).toEqual([artifact.id]);
    });

    it("still deletes for good a record whose trash folder is already gone from the trash", () => {
      const { manager, artifact, dataDir } = setup();
      const removed = trash(manager, artifact.id);
      rmSync(join(removed.removed!.trashPath!, ".."), { recursive: true });
      manager.purgeDocument(artifact.id);
      expect(removedIds(manager)).toEqual([]);
      expect(existsSync(join(dataDir, "artifacts", artifact.id))).toBe(false);
    });
  });

  // The same for the revisions kept under <data>/artifacts/<id>: a record's id is never trusted
  // with a recursive delete. Checked before anything is deleted, the trash file included.
  describe("영구 삭제 of a record whose revisions folder is not a real folder directly inside <data>/artifacts", () => {
    /** A trashed record under an id that leads somewhere else, where `keep` is; the gateway opened again on it. */
    function strayId(id: string, keep: (dataDir: string) => string) {
      const f = setup();
      const removed = trash(f.manager, f.artifact.id);
      const kept = keep(f.dataDir);
      mkdirSync(join(kept, ".."), { recursive: true });
      writeFileSync(kept, "남의 것");
      f.store.saveArtifact({ ...removed, id, removed: { at: removed.removed!.at, kind: "trash" } });
      return { ...f, again: f.restart(), id, kept };
    }

    it.each([
      ["leads out of it (..)", "../victim", (dataDir: string) => join(dataDir, "victim", "keep.txt")],
      ["names a folder deeper inside it", "a/b", (dataDir: string) => join(dataDir, "artifacts", "a", "b", "keep.txt")],
    ] as const)("refuses an id that %s, and deletes nothing", (_name, id, keep) => {
      const f = strayId(id, keep);
      expect(() => f.again.purgeDocument(id)).toThrow(expect.objectContaining({ status: 409, code: "artifact_path" }));
      expect(readFileSync(f.kept, "utf8")).toBe("남의 것");
      expect(removedIds(f.again)).toContain(id);
    });

    it("refuses a revisions folder that is a link, and deletes nothing: not the trash file either", () => {
      const { manager, artifact, dataDir, dir } = setup();
      const removed = trash(manager, artifact.id);
      const revisions = join(dataDir, "artifacts", artifact.id);
      renameSync(revisions, join(dir, "elsewhere"));
      symlinkSync(join(dir, "elsewhere"), revisions);
      expect(() => manager.purgeDocument(artifact.id)).toThrow(expect.objectContaining({ status: 409, code: "artifact_path" }));
      expect(readFileSync(removed.removed!.trashPath!, "utf8")).toContain("첫 판");
      expect(lstatSync(revisions).isSymbolicLink()).toBe(true);
      expect(readdirSync(join(dir, "elsewhere")).length).toBeGreaterThan(0);
      expect(removedIds(manager)).toEqual([artifact.id]);
      expect(manager.documents.removedRevisions(artifact.id)).toHaveLength(1);
    });
  });

  // C-3 / P13
  it("keeps a trashed document of a deleted project; 다른 곳에 저장 copies it out and keeps everything", () => {
    const { manager, work, artifact, dir, restart } = setup();
    const removed = trash(manager, artifact.id);
    expect(() => manager.saveDocumentCopy(artifact.id, join(dir, "early.md"))).toThrow(expect.objectContaining({ status: 409 }));
    expect(manager.deleteWork(work.id)).toMatchObject({ trashedDocuments: 1 });
    const again = restart();
    expect((again.snapshot().removedArtifacts ?? []).find((entry) => entry.id === artifact.id)?.removed).toMatchObject({ orphaned: true, workTitle: "강의" });
    const target = join(dir, "saved.md");
    writeFileSync(join(dir, "taken.md"), "남의 것");
    expect(() => again.saveDocumentCopy(artifact.id, join(dir, "taken.md"))).toThrow();
    expect(readFileSync(join(dir, "taken.md"), "utf8")).toBe("남의 것");
    again.saveDocumentCopy(artifact.id, target);
    expect(readFileSync(target, "utf8")).toContain("첫 판");
    expect(existsSync(removed.removed!.trashPath!)).toBe(true);
    expect(again.documents.removedRevisions(artifact.id)).toHaveLength(1);
    expect(() => again.restoreDocument(artifact.id)).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe("a document's AI conversations travel with it", () => {
  it("are archived on removal, restored with it, and take no request by any route while it is away", async () => {
    const { manager, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    trash(manager, artifact.id);
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.archivedAt).not.toBeNull();
    for (const mode of ["auto", "queue", "steer"] as const) {
      await expect(manager.send(agent.id, `r-${mode}`, "안녕", [], null, null, mode)).rejects.toMatchObject({ status: 409, code: "document_removed" });
    }
    expect(() => manager.updateSession(agent.id, { archived: false })).toThrow(/문서를 지웠/);
    manager.restoreDocument(artifact.id);
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.archivedAt).toBeNull();
  });

  // P12: a waiting request is kept with the conversation, held, and back on restore.
  it("keeps its waiting requests through removal and restore", () => {
    const { manager, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    manager.sink.updateSession(agent.id, { queued: [{ id: "q1", text: "다음에 할 일", refs: [], create: null, at: 1 }] });
    unlist(manager, artifact.id);
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.queued).toMatchObject([{ id: "q1", text: "다음에 할 일", held: true }]);
    manager.restoreDocument(artifact.id);
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.queued).toMatchObject([{ id: "q1", text: "다음에 할 일" }]);
  });

  // The AI is idle while its request is prepared, so its document can be removed meanwhile.
  it("take no request whose document was moved to the trash while the request was being prepared", async () => {
    const { manager, artifact, sent } = setup();
    const agent = manager.documentSession(artifact.id, null);
    const before = manager.items(agent.id).items;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const list = manager.userSkills.list.bind(manager.userSkills);
    vi.spyOn(manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
    const sending = manager.send(agent.id, "r1", "한글 문서로 정리해 줘");
    await new Promise((done) => setTimeout(done, 5));
    expect(manager.documentRemoval(artifact.id)).toMatchObject({ actions: ["unlisted", "trash"], running: [] });
    trash(manager, artifact.id);
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "document_removed" });
    expect(sent()).toBe(0);
    expect(manager.items(agent.id).items).toEqual(before);
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)).toMatchObject({ status: "idle", queued: [] });
    // Back with its document, the same request is sent (it was never recorded as sent).
    manager.restoreDocument(artifact.id);
    expect(await manager.send(agent.id, "r1", "한글 문서로 정리해 줘")).toEqual({ duplicate: false, delivery: "turn" });
    expect(sent()).toBe(1);
  });

  it("keep a waiting request that was on its way (지금 보내기) when the document was unlisted meanwhile", async () => {
    const { manager, artifact, sent } = setup();
    const agent = manager.documentSession(artifact.id, null);
    const waiting = { id: "q1", text: "한글 문서로 정리해 줘", refs: [], create: null, at: 1, held: true };
    manager.sink.updateSession(agent.id, { queued: [waiting] });
    const before = manager.items(agent.id).items;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const list = manager.userSkills.list.bind(manager.userSkills);
    vi.spyOn(manager.userSkills, "list").mockImplementationOnce(async (scope) => { await gate; return list(scope); });
    const sending = manager.sendQueued(agent.id, "q1");
    await new Promise((done) => setTimeout(done, 5));
    unlist(manager, artifact.id);
    release();
    await expect(sending).rejects.toMatchObject({ status: 409, code: "document_removed" });
    expect(sent()).toBe(0);
    expect(manager.items(agent.id).items).toEqual(before);
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.queued).toEqual([waiting]);
  });

  it("stay as read-only history after the document is deleted for good", async () => {
    const { manager, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    trash(manager, artifact.id);
    manager.purgeDocument(artifact.id);
    await expect(manager.send(agent.id, "r2", "안녕", [], null, null, "queue")).rejects.toThrow(/영구 삭제/);
  });
});

// A document's AI becomes the project's active conversation when a request is sent to it.
describe("when the removed document's AI was the project's active conversation", () => {
  afterEach(() => { vi.useRealTimers(); });
  type Fixture = ReturnType<typeof setup>;
  const active = (f: Fixture) => f.manager.snapshot().works.find((work) => work.id === f.work.id)!.activeSessionId;
  /** A request answered in a conversation: it is the project's active one, at rest. */
  async function use(f: Fixture, sessionId: string) {
    await f.manager.send(sessionId, `r-${sessionId}`, "안녕");
    f.manager.sink.updateSession(sessionId, { status: "idle" });
    expect(active(f)).toBe(sessionId);
  }
  /** Another document of the project with an AI of its own (never a chat). */
  function otherAgent(f: Fixture) {
    const file = join(f.work.cwd, "다른 문서.md");
    writeFileSync(file, "다른 문서");
    return f.manager.documentSession(f.manager.openFile(f.work.id, file).id, null);
  }

  it("the project's most recent live chat becomes its active conversation, and restoring the document does not move it back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000 });
    const f = setup();
    const used = f.manager.createSession(f.work.id, { provider: "claude" });
    f.manager.createSession(f.work.id, { provider: "codex" });
    const put = f.manager.createSession(f.work.id, { provider: "claude" });
    const tab = f.manager.createSession(f.work.id, { provider: "claude" });
    f.manager.sink.updateSession(tab.id, { pageAgent: { pageId: "page-1", parentSessionId: used.id } });
    // The oldest chat is the one used last. Newer still, and never chosen: an archived chat, a web tab's AI, another document's AI.
    vi.setSystemTime(2_000);
    await use(f, used.id);
    vi.setSystemTime(3_000);
    await use(f, put.id);
    f.manager.updateSession(put.id, { archived: true });
    f.manager.sink.updateSession(tab.id, { activity: null });
    const other = otherAgent(f);
    await use(f, other.id);
    vi.setSystemTime(4_000);
    const agent = f.manager.documentSession(f.artifact.id, null);
    await use(f, agent.id);
    trash(f.manager, f.artifact.id);
    expect(active(f)).toBe(used.id);
    f.manager.restoreDocument(f.artifact.id);
    expect(active(f)).toBe(used.id);
  });

  it("the project has no active conversation when no live chat is left (목록에서 빼기 too)", async () => {
    const f = setup();
    const chat = f.manager.createSession(f.work.id, { provider: "claude" });
    f.manager.updateSession(chat.id, { archived: true });
    otherAgent(f);
    const agent = f.manager.documentSession(f.artifact.id, null);
    await use(f, agent.id);
    unlist(f.manager, f.artifact.id);
    expect(active(f)).toBeNull();
  });

  // The person archived the document's AI themselves before removing the document: it is still the active one.
  it("an AI of the document that was archived before the removal is moved off as well", async () => {
    const f = setup();
    const chat = f.manager.createSession(f.work.id, { provider: "claude" });
    const agent = f.manager.documentSession(f.artifact.id, null);
    await use(f, agent.id);
    f.manager.updateSession(agent.id, { archived: true });
    expect(active(f)).toBe(agent.id);
    unlist(f.manager, f.artifact.id);
    expect(active(f)).toBe(chat.id);
    f.manager.restoreDocument(f.artifact.id);
    expect(active(f)).toBe(chat.id);
  });

  it("an archived AI of the document leaves the project without an active conversation when no live chat is left", async () => {
    const f = setup();
    const agent = f.manager.documentSession(f.artifact.id, null);
    await use(f, agent.id);
    f.manager.updateSession(agent.id, { archived: true });
    trash(f.manager, f.artifact.id);
    expect(active(f)).toBeNull();
  });

  it("an archived chat that was still the active one is moved off by the removal of any document", async () => {
    const f = setup();
    const live = f.manager.createSession(f.work.id, { provider: "claude" });
    const put = f.manager.createSession(f.work.id, { provider: "codex" });
    await use(f, put.id);
    f.manager.updateSession(put.id, { archived: true });
    expect(active(f)).toBe(put.id);
    unlist(f.manager, f.artifact.id);
    expect(active(f)).toBe(live.id);
  });

  it("the active conversation stays when it is not the removed document's AI", async () => {
    const f = setup();
    const chat = f.manager.createSession(f.work.id, { provider: "claude" });
    f.manager.createSession(f.work.id, { provider: "codex" }, false);
    f.manager.documentSession(f.artifact.id, null);
    const other = otherAgent(f);
    await use(f, chat.id);
    trash(f.manager, f.artifact.id);
    expect(active(f)).toBe(chat.id);
    // Another document's AI that is active is not this removal's to move either.
    await use(f, other.id);
    const second = join(f.work.cwd, "셋째.md");
    writeFileSync(second, "셋째");
    unlist(f.manager, f.manager.openFile(f.work.id, second).id);
    expect(active(f)).toBe(other.id);
  });
});

describe("restart and paired devices", () => {
  it("survives a restart as removed", () => {
    const { manager, artifact, restart } = setup();
    trash(manager, artifact.id);
    const again = restart();
    expect(again.snapshot().artifacts.some((entry) => entry.id === artifact.id)).toBe(false);
    expect(removedIds(again)).toEqual([artifact.id]);
  });

  it("a paired device sees only its own projects' removed documents", () => {
    const { manager, artifact, userDoc, userWork } = setup();
    trash(manager, artifact.id);
    unlist(manager, userDoc.id);
    const grant = { workIds: [artifact.workId] } as Parameters<typeof scopedSnapshot>[1];
    expect((scopedSnapshot(manager.snapshot(), grant).removedArtifacts ?? []).map((entry) => entry.id)).toEqual([artifact.id]);
    const purged = { seq: 1, type: "artifact.purged", artifactId: userDoc.id, workId: userWork.id } as Parameters<typeof scopedEvent>[0];
    expect(scopedEvent(purged, manager, grant)).toBeNull();
  });
});

describe("the app's own work area is <data>/works, a real folder — never a folder the user chose", () => {
  // I-A / B1: the user set 새 프로젝트 폴더 위치; new works without a folder go there.
  it("does not offer the trash for files in the user's chosen new-project location", () => {
    const { manager, artifact } = setup({ worksDir: (dir) => { mkdirSync(join(dir, "내 문서", "프로젝트"), { recursive: true }); return () => join(dir, "내 문서", "프로젝트"); } });
    expect(actions(manager, artifact.id)).toEqual(["unlisted"]);
  });

  // B3: <data>/works itself is a link.
  it("does not offer the trash when <data>/works is a link", () => {
    const { manager, artifact } = setup({ linkedWorks: true });
    expect(actions(manager, artifact.id)).toEqual(["unlisted"]);
  });

  // B2: an unusable chosen location must not block 목록에서 빼기.
  it("still unlists when the chosen location throws", () => {
    let usable = true;
    const { manager, artifact, file } = setup({ worksDir: (dir) => () => { if (usable) return join(dir, "data", "works"); throw Object.assign(new Error("works_dir_unusable"), { status: 409 }); } });
    usable = false;
    expect(actions(manager, artifact.id)).toContain("unlisted");
    expect(unlist(manager, artifact.id).removed?.kind).toBe("unlisted");
    expect(readFileSync(file, "utf8")).toContain("첫 판");
  });

  it("unlists without touching the file system: a missing or unreadable folder does not matter", () => {
    const { manager, userDoc, project, artifact, work } = setup();
    renameSync(project, `${project}-unmounted`);
    expect(unlist(manager, userDoc.id).removed?.kind).toBe("unlisted");
    chmodSync(work.cwd, 0o000);
    try {
      expect(actions(manager, artifact.id)).toEqual(["unlisted"]);
      expect(unlist(manager, artifact.id).removed?.kind).toBe("unlisted");
    } finally { chmodSync(work.cwd, 0o755); }
  });

  // M-a: a folder on the way became a link while the document was in the trash.
  it("does not restore through a folder that became a link", () => {
    const { manager, work, dir } = setup();
    mkdirSync(join(work.cwd, "sub"));
    writeFileSync(join(work.cwd, "sub", "s.md"), "안");
    const doc = manager.openFile(work.id, join(work.cwd, "sub", "s.md"));
    trash(manager, doc.id);
    rmSync(join(work.cwd, "sub"), { recursive: true });
    mkdirSync(join(dir, "user-repo"));
    symlinkSync(join(dir, "user-repo"), join(work.cwd, "sub"));
    expect(() => manager.restoreDocument(doc.id)).toThrow(expect.objectContaining({ status: 409 }));
    expect(readdirSync(join(dir, "user-repo"))).toEqual([]);
  });

  // M-d
  it("treats a dangling .git link as a repository", () => {
    const { manager, work, artifact, dir } = setup();
    symlinkSync(join(dir, "nowhere"), join(work.cwd, ".git"));
    expect(actions(manager, artifact.id)).toEqual(["unlisted"]);
  });
});

describe("a waiting request leaves its queue only when it is in the conversation", () => {
  const queued = (id: string) => ({ id, text: `요청 ${id}`, refs: [], create: null, at: 1, held: true });

  // I-B / H1: the button and the API route both call sendQueued.
  it("refuses 지금 보내기 in a removed document's conversation without using the request up", async () => {
    const { manager, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    manager.sink.updateSession(agent.id, { queued: [queued("q1")] });
    unlist(manager, artifact.id);
    await expect(manager.sendQueued(agent.id, "q1")).rejects.toMatchObject({ status: 409 });
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.queued.map((entry) => entry.id)).toEqual(["q1"]);
    manager.restoreDocument(artifact.id);
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.queued.map((entry) => entry.id)).toEqual(["q1"]);
  });

  it("leaves a refused request exactly where it was", async () => {
    const { manager, work } = setup();
    const session = manager.createSession(work.id, { provider: "codex" });
    manager.sink.updateSession(session.id, { queued: [queued("q1"), queued("q2")] });
    vi.spyOn(manager, "send").mockRejectedValueOnce(Object.assign(new Error("거절"), { status: 409 }));
    await expect(manager.sendQueued(session.id, "q1")).rejects.toThrow("거절");
    expect(manager.snapshot().sessions.find((entry) => entry.id === session.id)?.queued.map((entry) => entry.id)).toEqual(["q1", "q2"]);
  });

  // The zombie of round 3: a failure once the send was under way (here, writing the user item) left
  // a request that the next 지금 보내기 took out of the queue as a "duplicate" without sending it.
  // Its user item was never written, so it still waits, and the next 지금 보내기 really sends it.
  it("keeps a request whose user item was never written, and sends it on the next 지금 보내기", async () => {
    const { manager, work, store } = setup();
    const session = manager.createSession(work.id, { provider: "codex" });
    manager.sink.updateSession(session.id, { queued: [queued("q1"), queued("q2")] });
    const upsert = manager.sink.upsertItem;
    const spy = vi.spyOn(manager.sink, "upsertItem").mockImplementation((id, item) => {
      if (item.kind === "user") throw new Error("내부 오류");
      return upsert(id, item);
    });
    await expect(manager.sendQueued(session.id, "q1")).rejects.toThrow("내부 오류");
    spy.mockRestore();
    const waiting = () => manager.snapshot().sessions.find((entry) => entry.id === session.id)?.queued;
    expect(store.findRequest("q1")).toBeNull();
    expect(waiting()).toEqual([queued("q1"), queued("q2")]);
    expect(manager.items(session.id).items).toEqual([]);
    expect(await manager.sendQueued(session.id, "q1")).toEqual({ duplicate: false, delivery: "turn" });
    expect(manager.items(session.id).items.flatMap((item) => (item.kind === "user" ? [item.text] : []))).toEqual(["요청 q1"]);
    expect(waiting()).toEqual([queued("q2")]);
    await expect(manager.sendQueued(session.id, "q1")).rejects.toMatchObject({ status: 404 });
  });

  // Paired devices and automation go through the task commands.
  it("refuses the task command for an archived conversation without using the request up", async () => {
    const { manager, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    manager.sink.updateSession(agent.id, { queued: [queued("q1")] });
    unlist(manager, artifact.id);
    const target = { hostId: "h", workspaceId: agent.workspaceId ?? null, sessionId: agent.id, nativeSessionId: null, runId: "q1", parentRunId: null, executorKind: "session" };
    await expect(manager.tasks.command({ commandId: "c1", kind: "send_queue", queuedId: "q1", target } as never)).rejects.toBeTruthy();
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.queued.map((entry) => entry.id)).toEqual(["q1"]);
  });
});
