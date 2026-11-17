import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, WorkbenchEvent } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { fileOps, renameLinks } from "./artifacts.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";
import { tempDir } from "./test-temp.ts";

// 이름 바꾸기 for a document (audit #141): the file is renamed inside its folder and everything that
// points at it follows. Renaming moves a person's file, so the failure cases come first: a name that
// exists, characters the OS refuses, an open editor with unsaved edits, an AI turn running, and a
// gateway that stops between the file's move and the record's update.

class IdleAdapter implements ProviderAdapter {
  readonly provider: "claude" | "codex";
  private readonly sink: () => AdapterSink;
  constructor(provider: "claude" | "codex", sink: () => AdapterSink) { this.provider = provider; this.sink = sink; }
  async init() {}
  status(): ProviderStatus { return emptyStatus(this.provider); }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }
  async send(session: Session) { this.sink().updateSession(session.id, { status: "running" }); }
  async interrupt(session: Session) { this.sink().updateSession(session.id, { status: "idle" }); }
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) { return false; }
  async shutdown() {}
}

function setup() {
  const dir = tempDir("wb-rename-");
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const events: WorkbenchEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const options = { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir };
  const manager = new SessionManager(store, bus, options);
  for (const provider of ["claude", "codex"] as const) manager.registerAdapter(new IdleAdapter(provider, () => manager.sink));
  const work = manager.createWork({ title: "강의" });
  mkdirSync(work.cwd, { recursive: true });
  const file = join(work.cwd, "강의안.md");
  writeFileSync(file, "# 강의안\n\n첫 판\n");
  const artifact = manager.openFile(work.id, file);
  const restart = () => new SessionManager(store, new EventBus(), options);
  return { dir, dataDir, store, events, manager, work, file, artifact, restart };
}

const realLink = fileOps.link;
const realOps = { ...fileOps };
afterEach(() => { Object.assign(fileOps, realOps); vi.restoreAllMocks(); });

describe("이름 바꾸기: the file and its record", () => {
  it("renames the file inside its folder, keeps the extension and the content, and the record follows", () => {
    const { manager, work, file, artifact, events } = setup();
    const result = manager.renameDocument(artifact.id, "3주차 강의안");
    const target = join(work.cwd, "3주차 강의안.md");
    expect(result.artifact).toMatchObject({ id: artifact.id, name: "3주차 강의안.md", path: target, revision: 1 });
    expect(result.artifact.renaming).toBeUndefined();
    // 활동 › 기록 lists the rename at its time.
    expect(result.artifact.renamed).toMatchObject({ to: target, at: expect.any(Number) });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("# 강의안\n\n첫 판\n");
    expect(manager.documents.revisions(artifact.id)).toHaveLength(1);
    expect(readFileSync(manager.documents.revisionPath(artifact.id, 1), "utf8")).toContain("첫 판");
    expect(manager.documents.check(artifact.id).diskState).toBe("same");
    expect(events.some((event) => event.type === "artifact.upserted" && event.artifact.id === artifact.id && event.artifact.name === "3주차 강의안.md")).toBe(true);
  });

  it("takes a typed name that already ends with the extension as it is", () => {
    const { manager, work, artifact } = setup();
    expect(manager.renameDocument(artifact.id, "새 이름.md").artifact.path).toBe(join(work.cwd, "새 이름.md"));
  });

  it("undo is renaming back: the same record, the same revisions", () => {
    const { manager, file, artifact } = setup();
    manager.renameDocument(artifact.id, "임시");
    const back = manager.renameDocument(artifact.id, "강의안").artifact;
    expect(back.path).toBe(file);
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(manager.documents.revisions(artifact.id)).toHaveLength(1);
  });

  it("refuses a name that exists, with a plain line, and touches neither file", () => {
    const { manager, work, file, artifact } = setup();
    const other = join(work.cwd, "기존.md");
    writeFileSync(other, "다른 사람 파일");
    expect(() => manager.renameDocument(artifact.id, "기존")).toThrow(expect.objectContaining({ status: 409, code: "rename_exists", message: "같은 폴더에 「기존.md」 파일이 이미 있습니다. 다른 이름을 골라 주세요." }));
    expect(readFileSync(other, "utf8")).toBe("다른 사람 파일");
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(manager.documents.get(artifact.id).path).toBe(file);
  });

  it("refuses when the name is taken between the check and the move (the move never replaces a file)", () => {
    const { manager, work, file, artifact } = setup();
    const target = join(work.cwd, "경합.md");
    fileOps.link = (from, to) => { writeFileSync(to, "그 사이 생긴 파일"); return realLink(from, to); };
    expect(() => manager.renameDocument(artifact.id, "경합")).toThrow(expect.objectContaining({ status: 409, code: "rename_exists" }));
    expect(readFileSync(target, "utf8")).toBe("그 사이 생긴 파일");
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(manager.documents.get(artifact.id)).toMatchObject({ path: file });
    expect(manager.documents.get(artifact.id).renaming).toBeUndefined();
  });

  it.each([
    ["", "rename_empty"],
    ["   ", "rename_empty"],
    ["a/b", "rename_chars"],
    ["a\\b", "rename_chars"],
    ["질문?", "rename_chars"],
    ["별*표", "rename_chars"],
    ["따옴\"표", "rename_chars"],
    ["<꺾쇠>", "rename_chars"],
    ["콜:론", "rename_chars"],
    ["파이|프", "rename_chars"],
    ["탭\t이름", "rename_chars"],
    ["..", "rename_reserved"],
    ["CON", "rename_reserved"],
    ["nul", "rename_reserved"],
    ["com1", "rename_reserved"],
    ["끝에 점.", "rename_trailing"],
    ["~$임시", "rename_lockname"],
    [".숨김", "rename_hidden"],
    ["COM¹", "rename_reserved"],
    ["lpt²", "rename_reserved"],
    ["com³.백업", "rename_reserved"],
    ["가".repeat(90), "rename_long"],
  ])("refuses %j before trying anything on disk (%s)", (name, code) => {
    const { manager, file, artifact } = setup();
    const link = vi.fn(realLink);
    fileOps.link = link;
    expect(() => manager.renameDocument(artifact.id, name)).toThrow(expect.objectContaining({ status: 400, code }));
    expect(link).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toContain("첫 판");
  });

  it("refuses another document extension instead of making 「이름.docx.md」", () => {
    const { manager, artifact } = setup();
    expect(() => manager.renameDocument(artifact.id, "보고서.docx")).toThrow(expect.objectContaining({ status: 400, code: "rename_extension", message: "확장자는 바꿀 수 없습니다(.md). 이름만 고쳐 주세요." }));
  });

  it("refuses while the document's AI turn runs, says so, and the AI keeps working", () => {
    const { manager, file, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    manager.sink.updateSession(agent.id, { status: "running" });
    expect(() => manager.renameDocument(artifact.id, "바뀐 이름")).toThrow(expect.objectContaining({ status: 409, code: "document_busy", message: "문서 AI가 이 문서로 일하는 중이라 이름을 바꿀 수 없습니다. 답이 끝나거나 멈춘 뒤 바꿔 주세요." }));
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(manager.snapshot().sessions.find((session) => session.id === agent.id)?.status).toBe("running");
  });

  it("refuses while an AI execution holds the file", () => {
    const { manager, artifact } = setup();
    const view = manager.documents.registry.open(artifact.id, { viewId: "v", windowId: "w", claim: true });
    manager.documents.registry.acquireExecution(artifact.id, "office", "s", { viewId: "v", writeToken: view.writeToken });
    expect(() => manager.renameDocument(artifact.id, "바뀐 이름")).toThrow(expect.objectContaining({ status: 409, code: "document_busy" }));
  });

  it("refuses a symlink (the link's target is not this file's to rename) and a missing file", () => {
    const { manager, work, dir, file, artifact } = setup();
    writeFileSync(join(dir, "바깥.md"), "바깥");
    symlinkSync(join(dir, "바깥.md"), join(work.cwd, "링크.md"));
    const linked = manager.openFile(work.id, join(work.cwd, "링크.md"));
    expect(() => manager.renameDocument(linked.id, "새 링크")).toThrow(expect.objectContaining({ status: 409, code: "rename_link" }));
    renameSync(file, join(dir, "치움.md"));
    expect(() => manager.renameDocument(artifact.id, "새 이름")).toThrow(expect.objectContaining({ status: 409, code: "file_missing" }));
  });

  it("refuses the project note (its name is the project's)", () => {
    const { manager, artifact } = setup();
    manager.documents.setRole(artifact.id, "project-note");
    expect(() => manager.renameDocument(artifact.id, "노트")).toThrow(expect.objectContaining({ status: 409, code: "rename_project_note" }));
  });
});

describe("이름 바꾸기: an open editor keeps its unsaved edits and saves under the new name", () => {
  it("keeps the editor's write lease (its heartbeat goes on) and its next save lands in the new file", async () => {
    const { manager, work, file, artifact } = setup();
    const opened = manager.documents.registry.open(artifact.id, { viewId: "v", windowId: "w", claim: true, dirty: true });
    const access = { viewId: "v", writeToken: opened.writeToken };
    manager.renameDocument(artifact.id, "새 이름");
    // The editor's next heartbeat: same view, still the writer, still dirty.
    const beat = manager.documents.registry.open(artifact.id, { viewId: "v", windowId: "w", dirty: true });
    expect(beat.view).toMatchObject({ mode: "write", dirty: true });
    const saved = await manager.documents.saveText(artifact.id, 1, "# 강의안\n\n고친 판\n", access);
    expect(saved.revision).toBe(2);
    expect(readFileSync(join(work.cwd, "새 이름.md"), "utf8")).toBe("# 강의안\n\n고친 판\n");
    expect(existsSync(file)).toBe(false);
  });

  it("a save already under way when the name changes still writes the new file, never the old name", async () => {
    const { manager, work, file, artifact } = setup();
    const opened = manager.documents.registry.open(artifact.id, { viewId: "v", windowId: "w", claim: true, dirty: true });
    const saving = manager.documents.saveText(artifact.id, 1, "# 강의안\n\n저장 중\n", { viewId: "v", writeToken: opened.writeToken });
    manager.renameDocument(artifact.id, "새 이름");
    await saving;
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(work.cwd, "새 이름.md"), "utf8")).toBe("# 강의안\n\n저장 중\n");
  });

  const zip = (text: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(text)]);
  it.each([
    ["docx", (m: SessionManager, id: string, data: Buffer, access: { viewId: string; writeToken: string | null }) => m.documents.saveBytes(id, 1, data, access), zip],
    ["pptx", (m: SessionManager, id: string, data: Buffer, access: { viewId: string; writeToken: string | null }) => m.documents.saveBytes(id, 1, data, access), zip],
    ["xlsx", (m: SessionManager, id: string, data: Buffer, access: { viewId: string; writeToken: string | null }) => m.documents.saveBytes(id, 1, data, access), zip],
    ["hwpx", (m: SessionManager, id: string, data: Buffer, access: { viewId: string; writeToken: string | null }) => m.documents.saveHwpBytes(id, 1, data, access), zip],
    ["pdf", (m: SessionManager, id: string, data: Buffer, access: { viewId: string; writeToken: string | null }) => m.documents.savePdfBytes(id, 1, data, access), (text: string) => Buffer.from(`%PDF-1.7\n${text}`)],
  ] as const)("%s: the editor's save after the rename goes to the new file", (ext, save, bytes) => {
    const { manager, work } = setup();
    const before = join(work.cwd, `보고서.${ext}`);
    writeFileSync(before, bytes("첫 판"));
    const doc = manager.openFile(work.id, before);
    const opened = manager.documents.registry.open(doc.id, { viewId: "v", windowId: "w", claim: true, dirty: true });
    manager.renameDocument(doc.id, "최종 보고서");
    const after = join(work.cwd, `최종 보고서.${ext}`);
    expect(readFileSync(after).equals(bytes("첫 판"))).toBe(true);
    expect(manager.documents.registry.open(doc.id, { viewId: "v", windowId: "w", dirty: true }).view.mode).toBe("write");
    const saved = save(manager, doc.id, bytes("고친 판"), { viewId: "v", writeToken: opened.writeToken });
    expect(saved.revision).toBe(2);
    expect(readFileSync(after).equals(bytes("고친 판"))).toBe(true);
    expect(existsSync(before)).toBe(false);
    // The editor still names the file it was opened with; the gateway knows it is this document.
    expect(manager.documents.isPathOf(doc.id, before)).toBe(true);
  });
});

describe("이름 바꾸기: a gateway stopped between the file's move and the record's update", () => {
  it("file moved, record not updated → at start the record follows the file", () => {
    const { store, manager, work, file, artifact, restart } = setup();
    const to = join(work.cwd, "새 이름.md");
    store.saveArtifact({ ...manager.documents.get(artifact.id), renaming: { from: file, to } });
    renameSync(file, to);
    const again = restart();
    expect(again.documents.get(artifact.id)).toMatchObject({ path: to, name: "새 이름.md" });
    expect(again.documents.get(artifact.id).renaming).toBeUndefined();
    expect(again.documents.check(artifact.id).diskState).toBe("same");
  });

  it("recorded, file not moved yet → at start the record stays on the file where it is", () => {
    const { store, manager, work, file, artifact, restart } = setup();
    store.saveArtifact({ ...manager.documents.get(artifact.id), renaming: { from: file, to: join(work.cwd, "새 이름.md") } });
    const again = restart();
    expect(again.documents.get(artifact.id)).toMatchObject({ path: file, name: "강의안.md" });
    expect(again.documents.get(artifact.id).renaming).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain("첫 판");
  });

  it("both names on the same file (linked, old name not removed yet) → the move is finished, the content intact", () => {
    const { store, manager, work, file, artifact, restart } = setup();
    const to = join(work.cwd, "새 이름.md");
    store.saveArtifact({ ...manager.documents.get(artifact.id), renaming: { from: file, to } });
    linkSync(file, to);
    const again = restart();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(to, "utf8")).toContain("첫 판");
    expect(again.documents.get(artifact.id).path).toBe(to);
  });

  it("two different files at both names → nothing is deleted, the record stays on its own file and it is reported", () => {
    const { store, manager, work, file, artifact, restart } = setup();
    const to = join(work.cwd, "새 이름.md");
    store.saveArtifact({ ...manager.documents.get(artifact.id), renaming: { from: file, to } });
    writeFileSync(to, "다른 파일");
    const again = restart();
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(readFileSync(to, "utf8")).toBe("다른 파일");
    expect(again.documents.get(artifact.id).path).toBe(file);
    expect(again.documents.trashReport.join("\n")).toContain("이름 바꾸기");
  });

  it("the record update failing after the move puts the file back under its old name", () => {
    const { store, manager, file, artifact } = setup();
    const save = store.saveArtifact.bind(store);
    let calls = 0;
    vi.spyOn(store, "saveArtifact").mockImplementation((value) => { calls += 1; if (calls === 2) throw new Error("disk full"); save(value); });
    expect(() => manager.renameDocument(artifact.id, "새 이름")).toThrow();
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    vi.restoreAllMocks();
    expect(manager.documents.get(artifact.id).path).toBe(file);
  });
});

describe("이름 바꾸기: what points at the document follows", () => {
  it("its 문서 AI conversations' labels follow; a name the person typed stays", () => {
    const { manager, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    expect(agent.purpose).toBe("강의안.md · 문서 AI");
    const other = manager.documentSession(artifact.id, null, true, "codex");
    manager.updateSession(other.id, { purpose: "내가 붙인 이름" });
    manager.renameDocument(artifact.id, "3주차");
    const sessions = manager.snapshot().sessions;
    expect(sessions.find((session) => session.id === agent.id)?.purpose).toBe("3주차.md · 문서 AI");
    expect(sessions.find((session) => session.id === other.id)?.purpose).toBe("내가 붙인 이름");
  });

  it("the project note's links follow (wikilinks with or without the extension, Markdown links), as a new revision", async () => {
    const { manager, work, artifact } = setup();
    const notePath = join(work.cwd, "프로젝트.md");
    writeFileSync(notePath, "---\n관련:\n  - \"[[강의안]]\"\n---\n# 노트\n\n[[강의안.md|지난 판]] · [강의안](강의안.md) · [[강의안 부록]] · [다른](%EA%B0%95%EC%9D%98%EC%95%88.md)\n");
    const note = manager.openFile(work.id, notePath);
    manager.documents.setRole(note.id, "project-note");
    const result = manager.renameDocument(artifact.id, "3주차 강의안");
    expect(result.noteLinks).toBe(4);
    expect(readFileSync(notePath, "utf8")).toBe(`---\n관련:\n  - "[[3주차 강의안]]"\n---\n# 노트\n\n[[3주차 강의안.md|지난 판]] · [강의안](<3주차 강의안.md>) · [[강의안 부록]] · [다른](${encodeURIComponent("3주차 강의안.md")})\n`);
    expect(manager.documents.revisions(note.id)).toHaveLength(2);
  });

  it("leaves the project note alone while it is being edited with unsaved edits, and says so", () => {
    const { manager, work, artifact } = setup();
    const notePath = join(work.cwd, "프로젝트.md");
    writeFileSync(notePath, "[[강의안]]\n");
    const note = manager.openFile(work.id, notePath);
    manager.documents.setRole(note.id, "project-note");
    manager.documents.registry.open(note.id, { viewId: "n", windowId: "w", claim: true, dirty: true });
    const result = manager.renameDocument(artifact.id, "새 이름");
    expect(result.noteLinks).toBe(0);
    expect(result.notice).toBe("프로젝트 노트를 편집 중이라 노트 안의 링크는 그대로 두었습니다.");
    expect(readFileSync(notePath, "utf8")).toBe("[[강의안]]\n");
  });
});

// ---- Review fixes (ux/reports/document-rename-review.md) ----

const errno = (code: string) => Object.assign(new Error(`${code}: test`), { code });
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * A file system where names differing only in letter case or NFC/NFD are one directory entry (macOS
 * APFS, Windows NTFS defaults), laid over the real folder: a name finds the entry stored under any of
 * its forms; the listing shows the stored name only. This machine is Linux, so that is simulated.
 */
function foldingFs() {
  const fold = (name: string) => name.normalize("NFC").toLowerCase();
  const entry = (path: string) => {
    const hit = readdirSync(dirname(path)).find((name) => fold(name) === fold(basename(path)));
    return hit === undefined ? path : join(dirname(path), hit);
  };
  const taken = (path: string) => entry(path) !== path || existsSync(path);
  fileOps.lstat = (path) => realOps.lstat(entry(path));
  fileOps.read = (path) => realOps.read(entry(path));
  fileOps.unlink = (path) => realOps.unlink(entry(path));
  fileOps.rename = (from, to) => realOps.rename(entry(from), to);
  fileOps.link = (from, to) => { if (taken(to)) throw errno("EEXIST"); realLink(entry(from), to); };
  fileOps.copy = (from, to) => { if (taken(to)) throw errno("EEXIST"); realOps.copy(entry(from), to); };
}

describe("H1: the extension keeps its original bytes", () => {
  it("typing B.MD for 강의안.md gives B.md; every revision stays readable; undo gives 강의안.md back", async () => {
    const { manager, work, artifact } = setup();
    const renamed = manager.renameDocument(artifact.id, "B.MD").artifact;
    expect(renamed).toMatchObject({ name: "B.md", path: join(work.cwd, "B.md") });
    expect(readFileSync(manager.documents.revisionPath(artifact.id, 1), "utf8")).toContain("첫 판");
    await expect(manager.documents.text(artifact.id)).resolves.toBeTruthy();
    expect(manager.renameDocument(artifact.id, "강의안").artifact.name).toBe("강의안.md");
    expect(readFileSync(manager.documents.revisionPath(artifact.id, 1), "utf8")).toContain("첫 판");
  });

  it("Report.DOCX typed 새.docx stays .DOCX; another extension is still refused", () => {
    const { manager, work } = setup();
    const before = join(work.cwd, "Report.DOCX");
    writeFileSync(before, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("판")]));
    const doc = manager.openFile(work.id, before);
    expect(manager.renameDocument(doc.id, "새.docx").artifact.name).toBe("새.DOCX");
    expect(() => manager.renameDocument(doc.id, "새.hwp")).toThrow(expect.objectContaining({ code: "rename_extension" }));
  });
});

describe("H2: two names that are one directory entry (letter case, NFC/NFD) — simulated", () => {
  it("a case-only rename is a plain rename, never link + unlink, and the one file keeps its content", () => {
    const { manager, work } = setup();
    const before = join(work.cwd, "Report.md");
    writeFileSync(before, "보고서 내용");
    const doc = manager.openFile(work.id, before);
    foldingFs();
    const link = vi.fn(fileOps.link), unlink = vi.fn(fileOps.unlink);
    fileOps.link = link; fileOps.unlink = unlink;
    const renamed = manager.renameDocument(doc.id, "report").artifact;
    expect(link).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(renamed.path).toBe(join(work.cwd, "report.md"));
    expect(readdirSync(work.cwd).filter((name) => name.toLowerCase() === "report.md")).toEqual(["report.md"]);
    expect(readFileSync(renamed.path, "utf8")).toBe("보고서 내용");
  });

  it("an NFD name retyped in NFC is the same entry: renamed in place, nothing unlinked", () => {
    const { manager, work } = setup();
    const nfd = "보고서.md".normalize("NFD");
    writeFileSync(join(work.cwd, nfd), "보고서 내용");
    const doc = manager.openFile(work.id, join(work.cwd, nfd));
    foldingFs();
    const unlink = vi.fn(fileOps.unlink), link = vi.fn(fileOps.link);
    fileOps.unlink = unlink; fileOps.link = link;
    manager.renameDocument(doc.id, "보고서");
    expect(link).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(readdirSync(work.cwd).filter((name) => name.normalize("NFC") === "보고서.md")).toHaveLength(1);
  });

  it.each([
    ["an older journal (from/to only)", {}],
    ["a same-entry journal", { mode: "same-entry" as const }],
  ])("start-up after a stopped case-only rename (%s) never unlinks: the only file stays", (_label, extra) => {
    const { store, manager, work, restart } = setup();
    const before = join(work.cwd, "Report.md");
    writeFileSync(before, "보고서 내용");
    const doc = manager.openFile(work.id, before);
    store.saveArtifact({ ...manager.documents.get(doc.id), renaming: { from: before, to: join(work.cwd, "report.md"), ...extra } });
    foldingFs();
    const unlink = vi.fn(fileOps.unlink);
    fileOps.unlink = unlink;
    const again = restart();
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(before, "utf8")).toBe("보고서 내용");
    expect(again.documents.get(doc.id)).toMatchObject({ path: before });
    expect(again.documents.get(doc.id).renaming).toBeUndefined();
  });
});

describe("H3: another record on the same file", () => {
  it("refuses when another project's record uses the file; that record and its editor are untouched", () => {
    const { manager, file, artifact } = setup();
    const other = manager.createWork({ title: "다른 강의" });
    mkdirSync(other.cwd, { recursive: true });
    const twin = manager.openFile(other.id, file);
    expect(twin.id).not.toBe(artifact.id);
    manager.documents.registry.open(twin.id, { viewId: "vb", windowId: "w", claim: true, dirty: true });
    expect(() => manager.renameDocument(artifact.id, "새이름")).toThrow(expect.objectContaining({ status: 409, code: "rename_shared", message: "다른 문서도 이 파일을 쓰고 있어 이름을 바꾸지 않습니다. 다른 프로젝트나 링크(바로 가기)로 연 같은 파일을 목록에서 뺀 뒤 바꿔 주세요." }));
    expect(manager.documents.get(twin.id).path).toBe(file);
    expect(manager.documents.check(twin.id).diskState).toBe("same");
    expect(manager.documents.registry.open(twin.id, { viewId: "vb", windowId: "w" }).view.mode).toBe("write");
  });

  it("refuses when a symlink alias is tracked as its own document", () => {
    const { manager, work } = setup();
    const original = join(work.cwd, "원본.md");
    writeFileSync(original, "x\n");
    symlinkSync(original, join(work.cwd, "별칭.md"));
    const doc = manager.openFile(work.id, original);
    const alias = manager.openFile(work.id, join(work.cwd, "별칭.md"));
    expect(() => manager.renameDocument(doc.id, "원본2")).toThrow(expect.objectContaining({ code: "rename_shared" }));
    expect(manager.documents.check(alias.id).diskState).toBe("same");
  });
});

describe("M1: the old name cannot be removed (another program holds the file)", () => {
  it("takes the new name back and says so plainly; one name in the folder, no journal", () => {
    const { manager, work, file, artifact } = setup();
    fileOps.unlink = (path) => { if (path === file) throw errno("EBUSY"); realOps.unlink(path); };
    expect(() => manager.renameDocument(artifact.id, "새이름")).toThrow(expect.objectContaining({ status: 409, code: "rename_in_use", message: "다른 프로그램이 이 파일을 열고 있어 이름을 바꾸지 못했습니다. 문서 이름은 「강의안.md」 그대로입니다. 그 프로그램에서 파일을 닫은 뒤 다시 해 주세요." }));
    expect(existsSync(join(work.cwd, "새이름.md"))).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(manager.documents.get(artifact.id)).toMatchObject({ path: file });
    expect(manager.documents.get(artifact.id).renaming).toBeUndefined();
  });

  it("when the new name cannot be taken back either: the journal stays, the truth is told, and the next start finishes it", () => {
    const { manager, work, file, artifact, restart } = setup();
    const to = join(work.cwd, "새이름.md");
    fileOps.unlink = () => { throw errno("EPERM"); };
    expect(() => manager.renameDocument(artifact.id, "새이름")).toThrow(expect.objectContaining({ status: 409, code: "rename_two_names", message: "다른 프로그램이 이 파일을 열고 있어 이름을 끝까지 바꾸지 못했습니다. 지금 폴더에 「강의안.md」, 「새이름.md」 두 이름이 있습니다. 문서는 「강의안.md」 이름으로 그대로 쓰입니다. 그 프로그램을 닫고 앱을 다시 시작하면 앱이 두 이름을 확인해 정리합니다." }));
    expect(manager.documents.get(artifact.id)).toMatchObject({ path: file, renaming: { from: file, to, held: true } });
    expect(() => manager.renameDocument(artifact.id, "또다른")).toThrow(expect.objectContaining({ code: "rename_unfinished" }));
    fileOps.unlink = realOps.unlink;
    const again = restart();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(to, "utf8")).toContain("첫 판");
    expect(again.documents.get(artifact.id)).toMatchObject({ path: to, name: "새이름.md" });
    expect(again.documents.get(artifact.id).renaming).toBeUndefined();
  });
});

describe("M2: the journal and the folder survive a power cut", () => {
  it("the journal is committed with synchronous=FULL; the database goes back to NORMAL", () => {
    const { store, manager, artifact } = setup();
    const db = (store as unknown as { db: { prepare(sql: string): { get(): unknown } } }).db;
    const level = () => (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
    const seen: number[] = [];
    const save = store.saveArtifact.bind(store);
    vi.spyOn(store, "saveArtifact").mockImplementation((value) => { if (value.renaming) seen.push(level()); save(value); });
    manager.renameDocument(artifact.id, "새 이름");
    expect(seen).toEqual([2]);
    expect(level()).toBe(1);
  });

  it("the folder is synced after the link and after the unlink", () => {
    const { manager, artifact } = setup();
    const steps: string[] = [];
    fileOps.link = (from, to) => { steps.push("link"); realLink(from, to); };
    fileOps.unlink = (path) => { steps.push(`unlink ${basename(path)}`); realOps.unlink(path); };
    fileOps.syncDir = (dir) => { steps.push("sync"); realOps.syncDir(dir); };
    manager.renameDocument(artifact.id, "새 이름");
    expect(steps).toEqual(["link", "sync", "unlink 강의안.md", "sync"]);
  });

  it("start-up: the record on a missing name finds the file under the last rename's other name when it is that file", () => {
    const { manager, work, file, artifact, restart } = setup();
    manager.renameDocument(artifact.id, "새 이름");
    renameSync(join(work.cwd, "새 이름.md"), file); // the folder lost the move; the database kept the record
    const again = restart();
    expect(again.documents.get(artifact.id)).toMatchObject({ path: file, name: "강의안.md" });
    expect(again.documents.trashReport.join("\n")).toContain("다시 찾았습니다");
  });

  it("start-up: another file at the other name is not taken for it", () => {
    const { manager, work, file, artifact, restart } = setup();
    manager.renameDocument(artifact.id, "새 이름");
    renameSync(join(work.cwd, "새 이름.md"), join(work.cwd, "치움.md"));
    writeFileSync(file, "남의 파일");
    const again = restart();
    expect(again.documents.get(artifact.id).path).toBe(join(work.cwd, "새 이름.md"));
  });
});

describe("M3: work outside the document that could write its old name", () => {
  it("(a) refuses while a conversation of the project runs in the document's folder", () => {
    const { manager, work, artifact } = setup();
    const chat = manager.createSession(work.id, { provider: "claude" });
    manager.sink.updateSession(chat.id, { status: "running" });
    expect(() => manager.renameDocument(artifact.id, "새 이름")).toThrow(expect.objectContaining({ status: 409, code: "document_busy", message: "이 프로젝트의 대화가 이 문서가 있는 폴더에서 일하는 중이라 이름을 바꿀 수 없습니다. 답이 끝나거나 멈춘 뒤 바꿔 주세요." }));
    manager.sink.updateSession(chat.id, { status: "idle" });
    expect(manager.renameDocument(artifact.id, "새 이름").artifact.name).toBe("새 이름.md");
  });

  it("(L3) an archived 문서 AI conversation whose run still goes counts as running", () => {
    const { manager, artifact } = setup();
    const agent = manager.documentSession(artifact.id, null);
    manager.updateSession(agent.id, { archived: true });
    vi.spyOn(manager.office, "busy").mockImplementation((id: string) => id === agent.id);
    expect(() => manager.renameDocument(artifact.id, "새 이름")).toThrow(expect.objectContaining({ code: "document_busy" }));
  });

  it("(b) refuses while the document handed to another app from here is still open there (its lock file)", async () => {
    const { manager, work, file, artifact } = setup();
    vi.spyOn(manager.ieumDesktop, "open").mockResolvedValue({ app: "이음오피스", path: file });
    await manager.openExternal(artifact.id);
    writeFileSync(join(work.cwd, ".~lock.강의안.md#"), "lock");
    expect(() => manager.renameDocument(artifact.id, "새 이름")).toThrow(expect.objectContaining({ status: 409, code: "document_open_elsewhere", message: "다른 앱에서 이 문서를 열어 두었습니다. 그 앱에서 문서를 닫은 뒤 이름을 바꿔 주세요." }));
    renameSync(join(work.cwd, ".~lock.강의안.md#"), join(work.cwd, "..", "lock-gone"));
    expect(manager.renameDocument(artifact.id, "새 이름").artifact.name).toBe("새 이름.md");
  });

  it("(c) refuses a copy the app keeps for Google Drive (its link and clean-up go by this path)", () => {
    const { manager, dataDir } = setup();
    const cache = join(dataDir, "office", "drive", "files");
    mkdirSync(join(cache, "abc"), { recursive: true });
    writeFileSync(join(cache, "abc", "공유 문서.md"), "드라이브");
    const drive = manager.createWork({ title: "Google Drive", cwd: cache });
    const doc = manager.openFile(drive.id, join(cache, "abc", "공유 문서.md"));
    expect(() => manager.renameDocument(doc.id, "새 이름")).toThrow(expect.objectContaining({ status: 409, code: "rename_app_copy", message: "앱이 보관하는 사본(Google Drive에서 연 문서 등)이라 이름을 바꾸지 않습니다. 원본이 있는 곳(Drive 등)에서 바꿔 주세요." }));
    expect(existsSync(join(cache, "abc", "공유 문서.md"))).toBe(true);
  });
});

describe("M4: storage without hard links (FAT/exFAT, cloud placeholders, some shares) — simulated", () => {
  it("falls back to an exclusive, checked copy under a journal that says so; the old name goes", () => {
    const { store, manager, work, file, artifact } = setup();
    fileOps.link = () => { throw errno("EPERM"); };
    const durable = vi.spyOn(store, "saveArtifactDurably");
    const renamed = manager.renameDocument(artifact.id, "새 이름").artifact;
    expect(durable.mock.calls.map(([value]) => value.renaming?.mode)).toEqual(["link", "copy"]);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(work.cwd, "새 이름.md"), "utf8")).toBe("# 강의안\n\n첫 판\n");
    expect(renamed).toMatchObject({ path: join(work.cwd, "새 이름.md") });
    expect(manager.documents.check(artifact.id).diskState).toBe("same");
  });

  it("where even a copy is refused: a plain Korean line, nothing changed", () => {
    const { manager, work, file, artifact } = setup();
    fileOps.link = () => { throw errno("EPERM"); };
    fileOps.copy = () => { throw errno("EPERM"); };
    expect(() => manager.renameDocument(artifact.id, "새 이름")).toThrow(expect.objectContaining({ status: 409, code: "rename_unsupported", message: "이 저장 장치(USB 메모리, 클라우드·네트워크 폴더 등)에서는 앱이 이름을 바꿀 수 없습니다. 문서 이름은 「강의안.md」 그대로입니다." }));
    expect(readFileSync(file, "utf8")).toContain("첫 판");
    expect(existsSync(join(work.cwd, "새 이름.md"))).toBe(false);
    expect(manager.documents.get(artifact.id).renaming).toBeUndefined();
  });

  it("a copy that differs from the file is removed and the rename refused", () => {
    const { manager, work, file, artifact } = setup();
    fileOps.link = () => { throw errno("ENOTSUP"); };
    fileOps.copy = (_from, to) => writeFileSync(to, "덜 복사됨", { flag: "wx" });
    expect(() => manager.renameDocument(artifact.id, "새 이름")).toThrow(expect.objectContaining({ code: "rename_failed" }));
    expect(existsSync(join(work.cwd, "새 이름.md"))).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("첫 판");
  });

  it("start-up after a stopped copy: byte-identical → finished; different → both kept and reported", () => {
    for (const same of [true, false]) {
      const { store, manager, work, file, artifact, restart } = setup();
      const to = join(work.cwd, "새 이름.md"), data = readFileSync(file);
      writeFileSync(to, same ? data : "덜 복사됨");
      store.saveArtifact({ ...manager.documents.get(artifact.id), renaming: { from: file, to, mode: "copy", size: data.length, sha256: hash(data), fileId: "0:0" } });
      const again = restart();
      expect(existsSync(file)).toBe(!same);
      expect(again.documents.get(artifact.id).path).toBe(same ? to : file);
      if (!same) expect(again.documents.trashReport.join("\n")).toContain("둘 다 두었습니다");
    }
  });
});

describe("Lows", () => {
  it("L1: start-up follows the journalled file, never a stranger's file at the old name", () => {
    const { store, manager, work, file, artifact, restart } = setup();
    const to = join(work.cwd, "새 이름.md"), data = readFileSync(file), entry = fileOps.lstat(file);
    store.saveArtifact({ ...manager.documents.get(artifact.id), renaming: { from: file, to, mode: "link", size: data.length, sha256: hash(data), fileId: `${entry.dev}:${entry.ino}` } });
    renameSync(file, to);
    writeFileSync(file, "남이 만든 같은 이름 파일");
    const again = restart();
    expect(again.documents.get(artifact.id).path).toBe(to);
    expect(readFileSync(file, "utf8")).toBe("남이 만든 같은 이름 파일");
    expect(again.documents.trashReport.join("\n")).toContain("다른 파일");
  });

  it("L4: a destination that is a second hard link or a symlink of the same file is a taken name", () => {
    const { manager, work, file, artifact } = setup();
    linkSync(file, join(work.cwd, "둘째.md"));
    symlinkSync(file, join(work.cwd, "별칭.md"));
    expect(() => manager.renameDocument(artifact.id, "둘째")).toThrow(expect.objectContaining({ code: "rename_exists" }));
    expect(() => manager.renameDocument(artifact.id, "별칭")).toThrow(expect.objectContaining({ code: "rename_exists" }));
    expect(existsSync(file) && existsSync(join(work.cwd, "둘째.md"))).toBe(true);
    expect(manager.documents.get(artifact.id).path).toBe(file);
  });

  it("L6: a presentation's style file follows its rename", () => {
    const { manager, work } = setup();
    const deck = join(work.cwd, "발표.pptx");
    writeFileSync(deck, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("판")]));
    writeFileSync(join(work.cwd, "발표.styleskill.json"), "{}");
    const doc = manager.openFile(work.id, deck);
    manager.renameDocument(doc.id, "새 발표");
    expect(existsSync(join(work.cwd, "발표.styleskill.json"))).toBe(false);
    expect(readFileSync(join(work.cwd, "새 발표.styleskill.json"), "utf8")).toBe("{}");
  });

  it("L2: only links that resolve to this file; code untouched; #section kept", () => {
    const hwpx = renameLinks("[[계획]] · [[계획.hwpx]] · [표](계획.hwpx#2쪽)", "계획.hwpx", "새계획.hwpx", ".hwpx");
    expect(hwpx).toEqual({ text: "[[계획]] · [[새계획.hwpx]] · [표](새계획.hwpx#2쪽)", count: 2 });
    const md = renameLinks("[[계획]] `[[계획]]` [절](계획.md#목표)\n```\n[[계획]] [x](계획.md)\n```\n", "계획.md", "새계획.md", ".md");
    expect(md).toEqual({ text: "[[새계획]] `[[계획]]` [절](새계획.md#목표)\n```\n[[계획]] [x](계획.md)\n```\n", count: 2 });
    expect(renameLinks("[a](<계획.md#목표>)", "계획.md", "새 계획.md", ".md").text).toBe("[a](<새 계획.md#목표>)");
  });
});
