import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { formatOf } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { blankDesign, designAssetPath, designOutline, designProblem } from "./design.ts";
import { HttpError, SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

class ScriptedAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  prompts: string[] = [];
  action: (prompt: string) => void = () => {};
  private readonly sink: () => AdapterSink;
  constructor(sink: () => AdapterSink) {
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus(this.provider);
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session, _work: Work, text: string, turnKey: string) {
    this.prompts.push(text);
    this.sink().updateSession(session.id, { status: "running" });
    this.action(text);
    this.sink().upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 5, at: Date.now() });
    this.sink().updateSession(session.id, { status: "idle" });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-design-"));
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const codex = new ScriptedAdapter(() => manager.sink);
  manager.registerAdapter(codex);
  const work = manager.createWork({ title: "포스터", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  return { dir, manager, codex, work };
}

const workingPathIn = (prompt: string) => /작업 사본만 수정하세요: (.+)$/m.exec(prompt)?.[1];
/** The working copy is named relative to the work folder in the prompt. */
const workingFile = (prompt: string, cwd: string) => resolve(cwd, workingPathIn(prompt)!);

function withHeading(text: string, words: string, id = "11111111-1111-4111-8111-111111111111") {
  const document = JSON.parse(text) as { pages: { objects: unknown[] }[] };
  document.pages[0].objects.push({ id, type: "textbox", text: words, left: 540, top: 300, width: 800, fontSize: 80, fontFamily: '"Achmage SameTone", sans-serif', fill: "#111111" });
  return `${JSON.stringify(document, null, 2)}\n`;
}

describe("design documents", () => {
  it("recognises design files and checks their shape", () => {
    expect(formatOf("/x/포스터.design.json")).toBe("design");
    expect(formatOf("/x/data.json")).toBeNull();
    expect(designProblem(blankDesign("portrait"))).toBeNull();
    expect(designProblem("{")).toMatch(/JSON/);
    expect(designProblem(JSON.stringify({ schemaVersion: 2, width: 1, height: 1, pages: [] }))).toMatch(/schemaVersion/);
    const twice = JSON.parse(withHeading(withHeading(blankDesign(), "a"), "b")) as unknown;
    expect(designProblem(JSON.stringify(twice))).toMatch(/겹칩니다/);
    expect(designOutline(withHeading(blankDesign(), "봄 특강")).join("\n")).toContain('textbox id=11111111-1111-4111-8111-111111111111 @540,300 "봄 특강"');
  });

  it("creates a design without overwriting and refuses invalid saves", async () => {
    const { manager, work } = setup();
    const first = manager.createDesign(work.id, "포스터", "square");
    const second = manager.createDesign(work.id, "포스터", "square");
    expect(first.name).toBe("포스터.design.json");
    expect(second.name).toBe("포스터 2.design.json");
    await expect(manager.documents.saveText(first.id, 1, "{ not json")).rejects.toMatchObject({ status: 422, code: "invalid_design" });
    const saved = await manager.documents.saveText(first.id, 1, withHeading(blankDesign("square"), "제목"));
    expect(saved.revision).toBe(2);
    expect(() => manager.createDesign(work.id, "깨짐", "square", "[]")).toThrow(HttpError);
  });

  it("keeps images next to the design by content and never serves files outside its folder", () => {
    const { manager, work } = setup();
    const design = manager.createDesign(work.id, "포스터", "square");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const { src } = manager.documents.saveAsset(design.id, png, "image/png", "사진.png");
    expect(src).toMatch(/^포스터\.assets\/[0-9a-f]{16}\.png$/);
    expect(manager.documents.saveAsset(design.id, png, "image/png", "다른 이름.png").src).toBe(src);
    expect(readFileSync(manager.documents.assetPath(design.id, src))).toEqual(png);
    writeFileSync(join(work.cwd, "..", "secret.txt"), "x");
    expect(() => manager.documents.assetPath(design.id, "../secret.txt")).toThrow(/밖/);
    expect(() => manager.documents.assetPath(design.id, "/etc/passwd")).toThrow(HttpError);
    expect(() => manager.documents.assetPath(design.id, ".workbench/pinned/x.json")).toThrow(HttpError);
    expect(() => manager.documents.saveAsset(design.id, Buffer.from("x"), "text/html", "a.html")).toThrow(/이미지/);
    expect(() => designAssetPath(design.path, "https://example.com/a.png")).toThrow(HttpError);
  });

  it("puts design rules and the object list in the engine prompt, and applies only valid, current proposals", async () => {
    const { manager, codex, work } = setup();
    const design = manager.createDesign(work.id, "포스터", "square");
    await manager.documents.saveText(design.id, 1, withHeading(blankDesign("square"), "봄 특강"));
    const session = manager.createSession(work.id, { provider: "codex" });

    // The engine edits its working copy: the heading text changes.
    codex.action = (prompt) => {
      const working = workingFile(prompt, work.cwd);
      writeFileSync(working, readFileSync(working, "utf8").replace("봄 특강", "가을 특강"));
    };
    await manager.send(session.id, "q1", "제목을 가을 특강으로", [{ artifactId: design.id, revision: 2, mode: "edit" }]);
    const prompt = codex.prompts[0];
    expect(prompt).toContain("디자인 파일 규칙");
    expect(prompt).toContain('"봄 특강"');
    expect(workingPathIn(prompt)).toContain(`포스터.${design.id}.r2.`);
    expect(workingPathIn(prompt)).toMatch(/\.design\.json$/);
    const proposal = manager.documents.listProposals()[0];
    expect(proposal).toMatchObject({ status: "pending", problem: null });

    // The user changes the design first (r3): the proposal made on r2 is not applied.
    const current = (await manager.documents.text(design.id)).text;
    await manager.documents.saveText(design.id, 2, current.replace('"fill": "#111111"', '"fill": "#c2410c"'));
    await expect(manager.documents.applyProposal(proposal.id)).rejects.toMatchObject({ code: "stale_proposal" });
    expect(readFileSync(design.path, "utf8")).toContain("봄 특강");

    // Asked again on r3, it applies and keeps the user's colour.
    await manager.send(session.id, "q2", "제목을 가을 특강으로", [{ artifactId: design.id, revision: 3, mode: "edit" }]);
    const retry = manager.documents.listProposals().find((entry) => entry.baseRevision === 3)!;
    const applied = await manager.documents.applyProposal(retry.id);
    expect(applied.artifact.revision).toBe(4);
    const final = readFileSync(design.path, "utf8");
    expect(final).toContain("가을 특강");
    expect(final).toContain("#c2410c");

    // A working copy that is no longer a valid design is shown with its problem and never applied.
    codex.action = (prompt) => writeFileSync(workingFile(prompt, work.cwd), "{ broken");
    await manager.send(session.id, "q3", "망가뜨려 봐", [{ artifactId: design.id, revision: 4, mode: "edit" }]);
    const broken = manager.documents.listProposals().find((entry) => entry.baseRevision === 4)!;
    expect(broken.problem).toMatch(/JSON/);
    await expect(manager.documents.applyProposal(broken.id)).rejects.toMatchObject({ code: "invalid_design" });
    expect(existsSync(design.path)).toBe(true);
    expect(readFileSync(design.path, "utf8")).toBe(final);
  });

  it("tracks a design an engine wrote with a shell command (no file paths reported)", async () => {
    const { manager, codex, work } = setup();
    const session = manager.createSession(work.id, { provider: "codex" });
    mkdirSync(join(work.cwd, "카드"), { recursive: true });
    codex.action = () => {
      writeFileSync(join(work.cwd, "카드", "표지.design.json"), withHeading(blankDesign("square"), "표지"));
      writeFileSync(join(work.cwd, "notes.bin"), "not a document");
    };
    await manager.send(session.id, "s1", "표지 디자인을 새로 만들어 줘");
    const card = manager.documents.list().find((artifact) => artifact.name === "표지.design.json");
    expect(card).toMatchObject({ format: "design", revision: 1 });
    expect(manager.items(session.id).items.some((item) => item.kind === "artifact" && item.artifactId === card!.id)).toBe(true);
    expect(manager.documents.list().some((artifact) => artifact.name === "notes.bin")).toBe(false);
  });

  it("writes exports next to the design without overwriting, and tracks PDFs", () => {
    const { manager, work } = setup();
    const design = manager.createDesign(work.id, "포스터", "square");
    const first = manager.exportDesign(design.id, Buffer.from("png-bytes"), "포스터.png");
    const second = manager.exportDesign(design.id, Buffer.from("png-bytes-2"), "포스터.png");
    expect(first.name).toBe("포스터.png");
    expect(second.name).toBe("포스터 2.png");
    expect(first.artifactId).toBeNull();
    const pdf = manager.exportDesign(design.id, Buffer.from("%PDF-1.7\n"), "../../포스터.pdf");
    expect(pdf.path).toBe(join(work.cwd, "포스터.pdf"));
    expect(manager.documents.get(pdf.artifactId!).format).toBe("pdf");
  });
});
