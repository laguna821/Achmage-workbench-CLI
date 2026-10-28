import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { formatOf } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { IeumOffice } from "./ieumoffice.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// Word/PowerPoint/Excel through the real IeumOffice command line tool. Runs only where it is
// installed (or WORKBENCH_IEUM_CLI points at one).

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

const ieum = new IeumOffice();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-"));
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir, ieum });
  const codex = new ScriptedAdapter(() => manager.sink);
  manager.registerAdapter(codex);
  const work = manager.createWork({ title: "특강", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  return { dir, manager, codex, work };
}

/** A Word file made by the tool itself from Markdown. */
function makeDocx(folder: string, name: string, markdown: string) {
  const md = join(folder, `${name}.md`);
  writeFileSync(md, markdown);
  execFileSync(ieum.cli!, ["convert", md, "--to", "docx", "--force", "--json"], { env: { ...process.env, GENOFFICE_AUDIT_LOG: "off" } });
  return join(folder, `${name}.docx`);
}

describe("office formats", () => {
  it("recognises Word, PowerPoint and Excel files", () => {
    expect(formatOf("/a/보고서.docx")).toBe("docx");
    expect(formatOf("/a/발표.pptx")).toBe("pptx");
    expect(formatOf("/a/예산.xlsx")).toBe("xlsx");
    expect(formatOf("/a/예산.xlsm")).toBe("xlsx");
  });

  it.runIf(ieum.available)("shows pages and text of a Word revision and applies only a document that still opens", async () => {
    const { dir, manager, codex, work } = setup();
    const file = makeDocx(work.cwd, "강의", "# 가을 특강\n\n질문에서 시작하는 글쓰기\n");
    const artifact = manager.openFile(work.id, file);
    expect(artifact.format).toBe("docx");

    const pages = await manager.documents.officePages(artifact.id);
    expect(pages.pages.length).toBe(1);
    expect(readFileSync(await manager.documents.officePagePath(artifact.id, 1, 1)).subarray(1, 4).toString()).toBe("PNG");
    const view = await manager.documents.text(artifact.id);
    expect(view.text).toContain("가을 특강");
    expect(view).toMatchObject({ editable: false, view: true });

    // The engine edits its working copy (here: a new Word file made with the tool).
    const session = manager.createSession(work.id, { provider: "codex" });
    const other = mkdtempSync(join(dir, "draft-"));
    const changed = makeDocx(other, "강의", "# 겨울 특강\n\n질문에서 시작하는 글쓰기\n");
    codex.action = (prompt) => {
      const working = /고칠 때는 이 작업 사본만 수정하세요: (.+)$/m.exec(prompt)![1];
      copyFileSync(changed, resolve(work.cwd, working));
    };
    await manager.send(session.id, "o1", "제목을 겨울 특강으로", [{ artifactId: artifact.id, revision: 1, mode: "edit" }]);
    expect(codex.prompts[0]).toContain("이음오피스 명령줄 도구");
    expect(codex.prompts[0]).toContain("docs apply");
    const proposal = manager.documents.listProposals()[0];
    expect(proposal.status).toBe("pending");
    const texts = await manager.documents.proposalTexts(proposal.id);
    expect(texts.base).toContain("가을 특강");
    expect(texts.proposed).toContain("겨울 특강");
    expect((await manager.documents.proposalPages(proposal.id, "proposed")).length).toBe(1);
    const applied = await manager.documents.applyProposal(proposal.id);
    expect(applied.artifact.revision).toBe(2);
    expect(readFileSync(file)).toEqual(readFileSync(changed));

    // A working copy that is no longer a Word file is never applied.
    codex.action = (prompt) => {
      const working = /고칠 때는 이 작업 사본만 수정하세요: (.+)$/m.exec(prompt)![1];
      writeFileSync(resolve(work.cwd, working), "not a zip");
    };
    await manager.send(session.id, "o2", "망가뜨려 봐", [{ artifactId: artifact.id, revision: 2, mode: "edit" }]);
    const broken = manager.documents.listProposals().find((entry) => entry.baseRevision === 2)!;
    await expect(manager.documents.applyProposal(broken.id)).rejects.toMatchObject({ code: "invalid_document" });
    expect(readFileSync(file)).toEqual(readFileSync(changed));
  }, 120_000);

  it.runIf(ieum.available)("reads every sheet of a workbook as tables", async () => {
    const { manager, work } = setup();
    const csv = join(work.cwd, "비품.csv");
    writeFileSync(csv, "항목,수량\n노트,3\n펜,10\n");
    execFileSync(ieum.cli!, ["convert", csv, "--to", "xlsx", "--json"], { env: { ...process.env, GENOFFICE_AUDIT_LOG: "off" } });
    const artifact = manager.openFile(work.id, join(work.cwd, "비품.xlsx"));
    const view = await manager.documents.text(artifact.id);
    expect(view.text).toContain("| 항목 | 수량 |");
    expect(view.text).toContain("| 펜 | 10 |");
  }, 60_000);
});
