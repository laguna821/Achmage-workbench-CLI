import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, TranscriptItem, Work } from "@workbench/contracts";
import { Attachments, mentionFiles, sniff } from "./attachments.ts";
import { EventBus } from "./bus.ts";
import { claudeContent } from "./providers/claude.ts";
import { codexInput } from "./providers/codex.ts";
import { SessionManager } from "./sessions.ts";
import { imagesNamed, keepImage } from "./tool-images.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type AttachedFile, type ProviderAdapter } from "./providers/types.ts";

// Files pasted or dropped into the input: kept by content, carried with the request (sent, steered
// or waiting), and handed to each engine in the form it reads.

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const PDF = Buffer.from("%PDF-1.4\n%fake\n");

class FileEngine implements ProviderAdapter {
  readonly provider = "codex" as const;
  sent: { text: string; files: AttachedFile[] }[] = [];
  steered: { text: string; files: AttachedFile[] }[] = [];
  private readonly sink: () => AdapterSink;
  private current: { sessionId: string; key: string } | null = null;
  constructor(sink: () => AdapterSink) {
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus("codex");
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session, _work: Work, text: string, turnKey: string, files: AttachedFile[] = []) {
    this.sent.push({ text, files });
    this.current = { sessionId: session.id, key: turnKey };
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중" });
  }
  async steer(_session: Session, _work: Work, text: string, _turnKey: string, files: AttachedFile[] = []) {
    if (!this.current) return false;
    this.steered.push({ text, files });
    return true;
  }
  finish() {
    const turn = this.current!;
    this.current = null;
    this.sink().upsertItem(turn.sessionId, { kind: "turnEnd", id: `end:${turn.key}`, status: "completed", durationMs: 1, at: Date.now() });
    this.sink().updateSession(turn.sessionId, { status: "idle", activity: null });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-attach-"));
  dirs.push(dir);
  return dir;
};

function setup() {
  const dir = tempDir();
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const engine = new FileEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const work = manager.createWork({ title: "w" });
  const session = manager.createSession(work.id, { provider: "codex" });
  return { manager, engine, session, dir };
}

const tick = () => new Promise((done) => setTimeout(done, 5));
const userItems = (manager: SessionManager, id: string) =>
  manager.items(id).items.filter((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user");

describe("the attachment store", () => {
  it("keeps a file once by its content, private to the user", () => {
    const store = new Attachments(tempDir());
    const first = store.save(PNG, "화면.png", "image/png");
    const again = store.save(PNG, "다른 이름.png", "image/png");
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ name: "화면.png", mime: "image/png", size: PNG.length });
    expect(statSync(store.path(first.id)).mode & 0o777).toBe(0o600);
    expect(store.count()).toBe(1);
  });

  it("lets the bytes decide what a picture or PDF is", () => {
    const store = new Attachments(tempDir());
    expect(store.save(PNG, "clipboard", "").mime).toBe("image/png");
    expect(store.save(PDF, "자료", "application/octet-stream")).toMatchObject({ mime: "application/pdf" });
    // Named a picture, but not one: never handed to an engine as an image.
    expect(store.save(Buffer.from("hello"), "가짜.png", "image/png").mime).toBe("application/octet-stream");
    expect(store.save(Buffer.from("a,b\n1,2\n"), "표.csv", "text/csv").id).toMatch(/\.csv$/);
    expect(store.save(Buffer.from("x"), "이상한.확장자", "").id).toMatch(/\.bin$/);
    expect(sniff(Buffer.from("RIFF0000WEBPVP8 "))).toBe("image/webp");
  });

  it("refuses empty files and names that are not its own", () => {
    const store = new Attachments(tempDir());
    expect(() => store.save(Buffer.alloc(0), "빈.txt", "text/plain")).toThrow(/빈 파일/);
    expect(() => store.path("../state.sqlite")).toThrow(/올바르지/);
    expect(() => store.path(`${"a".repeat(64)}.png`)).toThrow(/없습니다/);
  });
});

describe("requests with files", () => {
  it("hands the files to the engine and shows them with the request", async () => {
    const { manager, engine, session } = setup();
    const picture = manager.attachments.save(PNG, "화면.png", "image/png");
    await manager.send(session.id, "r1", "이 화면 봐 줘", [], null, null, "auto", [picture]);
    expect(engine.sent[0]!.files).toEqual([expect.objectContaining({ id: picture.id, mime: "image/png", path: manager.attachments.path(picture.id) })]);
    expect(userItems(manager, session.id)[0]!.attachments).toEqual([picture]);
  });

  it("sends files without text, with a plain request in their place", async () => {
    const { manager, engine, session } = setup();
    const pdf = manager.attachments.save(PDF, "자료.pdf", "application/pdf");
    await manager.send(session.id, "r1", "  ", [], null, null, "auto", [pdf]);
    expect(engine.sent[0]!.text).toBe("첨부한 파일을 봐 주세요.");
  });

  it("sends nothing when a file is gone", async () => {
    const { manager, engine, session } = setup();
    await expect(manager.send(session.id, "r1", "봐 줘", [], null, null, "auto", [{ id: `${"b".repeat(64)}.png`, name: "x.png", mime: "image/png", size: 1 }])).rejects.toThrow(/없습니다/);
    expect(engine.sent).toHaveLength(0);
    expect(userItems(manager, session.id)).toHaveLength(0);
  });

  it("steers files into the running turn, and keeps them on a request that waits", async () => {
    const { manager, engine, session } = setup();
    const picture = manager.attachments.save(PNG, "화면.png", "image/png");
    await manager.send(session.id, "r1", "작업해 줘");
    await manager.send(session.id, "r2", "이것도", [], null, null, "auto", [picture]);
    expect(engine.steered[0]!.files.map((file) => file.path)).toEqual([manager.attachments.path(picture.id)]);
    expect(userItems(manager, session.id).find((item) => item.id.includes("r2"))?.attachments).toEqual([picture]);

    await manager.send(session.id, "r3", "끝나면 이거", [], null, null, "queue", [picture]);
    expect(manager.snapshot().sessions.find((entry) => entry.id === session.id)!.queued[0]!.attachments).toEqual([picture]);
    engine.finish();
    await tick();
    expect(engine.sent[1]).toMatchObject({ text: "끝나면 이거" });
    expect(engine.sent[1]!.files.map((file) => file.path)).toEqual([manager.attachments.path(picture.id)]);
  });
});

describe("what each engine gets", () => {
  const dir = () => {
    const store = new Attachments(tempDir());
    const png = store.save(PNG, "화면.png", "image/png");
    const pdf = store.save(PDF, "자료.pdf", "application/pdf");
    const csv = store.save(Buffer.from("a,b\n"), "표.csv", "text/csv");
    const file = (entry: typeof png) => ({ ...entry, path: store.path(entry.id) });
    return { png: file(png), pdf: file(pdf), csv: file(csv) };
  };

  it("Codex: pictures as local images, other files by path", () => {
    const { png, pdf, csv } = dir();
    const input = codexInput("봐 줘", [png, pdf, csv]);
    expect(input[0]).toMatchObject({ type: "text", text: mentionFiles("봐 줘", [pdf, csv]) });
    expect(input.slice(1)).toEqual([{ type: "localImage", path: png.path }]);
  });

  it("Claude: pictures and PDFs as content blocks, other files by path", () => {
    const { png, pdf, csv } = dir();
    const content = claudeContent("봐 줘", [png, pdf, csv]);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Exclude<typeof content, string>;
    expect(blocks.map((block) => block.type)).toEqual(["image", "document", "text"]);
    expect(blocks[0]).toMatchObject({ source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    expect(blocks[2]).toMatchObject({ text: `봐 줘\n\n첨부한 파일:\n- 표.csv: ${csv.path}` });
    expect(claudeContent("그냥 글", [])).toBe("그냥 글");
  });

  it("leaves a request without files as it is", () => {
    expect(mentionFiles("글", [])).toBe("글");
    expect(codexInput("글", [])).toEqual([{ type: "text", text: "글", text_elements: [] }]);
  });
});

describe("pictures from the engine's steps", () => {
  it("finds the pictures a command made this turn, however it names them", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".playwright-cli"));
    writeFileSync(join(cwd, ".playwright-cli", "page.png"), PNG);
    writeFileSync(join(cwd, "차트 결과.png"), PNG);
    writeFileSync(join(cwd, "old.png"), PNG);
    utimesSync(join(cwd, "old.png"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const output = `### Result\n- [Screenshot of viewport](.playwright-cli/page.png)\nsaved "${join(cwd, "차트 결과.png")}"\nold.png https://example.com/a.png missing.png`;
    expect(imagesNamed(output, cwd, Date.now() - 60_000)).toEqual([join(cwd, ".playwright-cli", "page.png"), join(cwd, "차트 결과.png")]);
  });

  it("keeps only real pictures", () => {
    const store = new Attachments(tempDir());
    expect(keepImage(store, { data: PNG.toString("base64") })?.mime).toBe("image/png");
    expect(keepImage(store, { data: Buffer.from("not a picture").toString("base64") })).toBeNull();
    expect(keepImage(store, { path: "/nonexistent/x.png" })).toBeNull();
  });

  it("shows them under the step, and the step keeps them when the engine reports it again", () => {
    const { manager, session } = setup();
    const step = { kind: "tool" as const, id: "t1", tool: "other" as const, title: "그림 보기", detail: null, output: null, status: "completed" as const, at: 1 };
    manager.sink.upsertItem(session.id, step);
    manager.sink.toolImages(session.id, "t1", [{ data: PNG.toString("base64") }, { data: PNG.toString("base64") }]);
    manager.sink.upsertItem(session.id, { ...step, title: "그림 보기 · 다시" });
    const item = manager.items(session.id).items.find((entry) => entry.id === "t1");
    expect(item?.kind === "tool" && item.images?.map((image) => image.mime)).toEqual(["image/png"]);
  });

  it("adds what a finished command saved during the turn", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "화면 찍어 줘");
    const work = manager.snapshot().works.find((entry) => entry.id === session.workId)!;
    mkdirSync(work.cwd, { recursive: true });
    writeFileSync(join(work.cwd, "shot.png"), PNG);
    manager.sink.upsertItem(session.id, { kind: "tool", id: "c1", tool: "command", title: "playwright-cli screenshot", detail: null, output: "- [Screenshot](shot.png)", status: "completed", at: 1 });
    const item = manager.items(session.id).items.find((entry) => entry.id === "c1");
    expect(item?.kind === "tool" && item.images?.length).toBe(1);
    engine.finish();
  });
});
