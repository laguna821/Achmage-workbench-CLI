import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DRAW_MARK, type ApprovalDecision, type ImageItem, type Provider, type ProviderStatus, type Session, type Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { cleanTemplates, engineImageBytes, imageSize, parseDrawRequest, reserveImagePath, sniffImage } from "./imagegen.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

/** A real PNG of the given size (one gray pixel row repeated). */
function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + body.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y += 1) rows[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

class Engine implements ProviderAdapter {
  readonly provider: Provider;
  sent: { sessionId: string; text: string; turnKey: string }[] = [];
  private readonly sink: () => AdapterSink;
  constructor(provider: Provider, sink: () => AdapterSink) {
    this.provider = provider;
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
    this.sent.push({ sessionId: session.id, text, turnKey });
    this.sink().updateSession(session.id, { nativeSessionId: `native-${session.id}`, status: "running" });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
  /** The turn ends (as the engine reports it). */
  end(sessionId: string, status: "completed" | "interrupted" | "failed" = "completed") {
    this.sink().upsertItem(sessionId, { kind: "turnEnd", id: `end:${Math.random()}`, status, durationMs: 10, at: Date.now() });
    this.sink().updateSession(sessionId, { status: "idle" });
  }
}

function setup(dir = mkdtempSync(join(tmpdir(), "wb-imagegen-"))) {
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const claude = new Engine("claude", () => manager.sink);
  const codex = new Engine("codex", () => manager.sink);
  manager.registerAdapter(claude);
  manager.registerAdapter(codex);
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const work = manager.createWork({ title: "강의", cwd });
  return { dir, store, manager, claude, codex, work, cwd };
}

const images = (manager: SessionManager, sessionId: string) =>
  manager.items(sessionId).items.filter((item): item is ImageItem => item.kind === "image");

describe("picture bytes", () => {
  it("takes the file Codex saved, else the base64 data, and only real images", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-imagegen-bytes-"));
    const data = png(30, 20);
    const saved = join(dir, "ig_1.png");
    writeFileSync(saved, data);
    expect(engineImageBytes({ savedPath: saved, result: null })).toMatchObject({ kind: "png", source: "savedPath" });
    expect(engineImageBytes({ savedPath: join(dir, "gone.png"), result: data.toString("base64") })).toMatchObject({ kind: "png", source: "result" });
    expect(engineImageBytes({ savedPath: null, result: `data:image/png;base64,${data.toString("base64")}` })?.data.equals(data)).toBe(true);
    writeFileSync(join(dir, "fake.png"), "not an image");
    expect(engineImageBytes({ savedPath: join(dir, "fake.png"), result: Buffer.from("hello").toString("base64") })).toBeNull();
    expect(engineImageBytes({ savedPath: "relative.png", result: "" })).toBeNull();
  });

  it("reads the size from the header", () => {
    const data = png(30, 20);
    expect(sniffImage(data)).toBe("png");
    expect(imageSize(data, "png")).toEqual({ width: 30, height: 20 });
    // A JPEG with a start-of-frame segment after an APP0 segment.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(jpeg)).toBe("jpg");
    expect(imageSize(jpeg, "jpg")).toEqual({ width: 800, height: 512 });
  });

  it("never overwrites a picture: the next free name gets a number", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wb-imagegen-names-"));
    const at = new Date(2026, 9, 28).getTime();
    const first = reserveImagePath(cwd, "파란 원", at, "png");
    expect(first).toBe(join(cwd, "images", "2026-10-28-파란-원.png"));
    mkdirSync(join(cwd, "images"));
    writeFileSync(first, "x");
    expect(reserveImagePath(cwd, "파란 원", at, "png")).toBe(join(cwd, "images", "2026-10-28-파란-원-2.png"));
  });

  it("reads a drawing request field by field", () => {
    expect(parseDrawRequest({ requestId: " r1 ", brief: "원", templateId: "", aspect: "wide", transparent: "yes", via: "new", insertInto: 3 })).toEqual({
      requestId: "r1",
      brief: "원",
      templateId: null,
      aspect: "auto",
      transparent: false,
      via: "new",
      insertInto: null,
    });
  });
});

describe("templates", () => {
  it("keeps the user's templates apart from the built-in ones, which cannot be overwritten", () => {
    const { manager, dir } = setup();
    expect(manager.images.templates().templates.map((template) => template.id).slice(0, 2)).toEqual(["cmds-illustration", "infographic"]);
    const saved = manager.images.saveTemplates({
      templates: [
        { name: "  수업 슬라이드  ", prompt: "16:9 slide illustration, calm colors" },
        { id: "infographic", name: "가짜", prompt: "x" },
        { id: "mine", name: "내 것", prompt: "y", builtIn: false },
      ],
      rules: "No text inside the image.",
    });
    const mine = saved.templates.filter((template) => !template.builtIn);
    expect(mine.map((template) => template.name)).toEqual(["수업 슬라이드", "내 것"]);
    expect(mine[0]!.id).toMatch(/^tpl-/);
    expect(saved.templates.find((template) => template.id === "infographic")?.name).toBe("인포그래픽");
    expect(saved.rules).toBe("No text inside the image.");
    expect(JSON.parse(readFileSync(join(dir, "image-templates.json"), "utf8")).templates).toHaveLength(2);
    expect(() => manager.images.saveTemplates({ templates: [{ name: "", prompt: "x" }] })).toThrow(/이름과 내용/);
    expect(cleanTemplates({ templates: [{ name: "", prompt: "x" }, { name: "a", prompt: "b" }] }, false).templates).toHaveLength(1);
  });
});

describe("drawing", () => {
  it("a Codex conversation draws itself: the engine gets the drawing instructions, the conversation shows the request", async () => {
    const { manager, codex, work, cwd } = setup();
    const session = manager.createSession(work.id, { provider: "codex" });
    const result = await manager.images.draw(session.id, { requestId: "d1", brief: "파란 원 하나", templateId: "infographic", aspect: "landscape" });
    expect(result.image).toMatchObject({ status: "drawing", drawSessionId: session.id, originSessionId: session.id, template: "인포그래픽", templateId: "infographic" });
    const sent = codex.sent.at(-1)!;
    expect(sent.text.startsWith(DRAW_MARK)).toBe(true);
    expect(sent.text).toContain("Flat infographic");
    expect(sent.text).toContain("파란 원 하나\n\nLandscape composition");
    const request = manager.items(session.id).items.find((item) => item.kind === "user");
    expect(request).toMatchObject({ kind: "user", text: "파란 원 하나", draw: { template: "인포그래픽", aspect: "landscape" } });
    expect(images(manager, session.id)[0]?.image.status).toBe("drawing");

    // Codex saved the picture under its own home; the gateway copies it into the work folder.
    const home = mkdtempSync(join(tmpdir(), "wb-codex-home-"));
    writeFileSync(join(home, "ig_1.png"), png(120, 80));
    manager.sink.image?.(session.id, { id: "ig_1", status: "completed", result: null, savedPath: join(home, "ig_1.png"), revisedPrompt: "A blue circle", failure: null });
    codex.end(session.id);
    const [card] = images(manager, session.id);
    expect(card?.image).toMatchObject({ status: "done", width: 120, height: 80, revisedPrompt: "A blue circle" });
    expect(card?.image.relPath).toMatch(/^images\/\d{4}-\d{2}-\d{2}-파란-원-하나\.png$/);
    expect(readFileSync(join(cwd, card!.image.relPath!)).equals(png(120, 80))).toBe(true);
    // The same request id never draws twice.
    expect((await manager.images.draw(session.id, { requestId: "d1", brief: "파란 원 하나" })).duplicate).toBe(true);
    expect(codex.sent).toHaveLength(1);
  });

  it("a Claude conversation draws through the work's drawing session and keeps showing itself", async () => {
    const { manager, claude, codex, work } = setup();
    const chat = manager.createSession(work.id, { provider: "claude" });
    const result = await manager.images.draw(chat.id, { requestId: "d2", brief: "수업 표지", transparent: true });
    const helper = manager.snapshot().sessions.find((session) => session.provider === "codex")!;
    expect(helper.purpose).toBe("그림");
    expect(result.image).toMatchObject({ originSessionId: chat.id, drawSessionId: helper.id, transparent: true });
    // The work still shows the Claude conversation; Claude itself got nothing.
    expect(manager.snapshot().works.find((entry) => entry.id === work.id)?.activeSessionId).toBe(chat.id);
    expect(claude.sent).toHaveLength(0);
    expect(codex.sent[0]?.sessionId).toBe(helper.id);
    expect(codex.sent[0]?.text).toContain("transparent_background=true");
    const request = manager.items(helper.id).items.find((item) => item.kind === "user");
    expect(request).toMatchObject({ from: { sessionId: chat.id }, draw: { template: null } });
    expect(images(manager, chat.id)[0]?.image.status).toBe("drawing");

    // Codex sent the picture as data only.
    manager.sink.image?.(helper.id, { id: "ig_2", status: "completed", result: png(64, 96).toString("base64"), savedPath: null, revisedPrompt: null, failure: null });
    codex.end(helper.id);
    expect(images(manager, chat.id)[0]?.image).toMatchObject({ status: "done", width: 64, height: 96 });
    expect(images(manager, helper.id)[0]?.image.status).toBe("done");
    // Its reply is the picture already shown in the Claude conversation: not another "새 답".
    const seen = manager.snapshot().sessions.find((session) => session.id === helper.id)!;
    expect(seen.seenAt).not.toBeNull();
    expect(seen.unread).toBe(false);

    // The next drawing reuses the drawing session.
    await manager.images.draw(chat.id, { requestId: "d3", brief: "두 번째" });
    expect(codex.sent[1]?.sessionId).toBe(helper.id);
    expect(manager.snapshot().sessions.filter((session) => session.provider === "codex")).toHaveLength(1);
    // While it draws, another drawing waits for it (unless a new session is asked for).
    await expect(manager.images.draw(chat.id, { requestId: "d4", brief: "세 번째" })).rejects.toThrow(/앞선 그림/);
    const parallel = await manager.images.draw(chat.id, { requestId: "d5", brief: "세 번째", via: "new" });
    expect(parallel.image.drawSessionId).not.toBe(helper.id);
    // The new session is the work's drawing session from now on; a busy Codex conversation can
    // draw through it too.
    codex.end(parallel.image.drawSessionId);
    const coding = manager.createSession(work.id, { provider: "codex", purpose: "코딩" });
    await manager.send(coding.id, "busy", "일하는 중");
    expect((await manager.images.draw(coding.id, { requestId: "d6", brief: "네 번째", via: "helper" })).image.drawSessionId).toBe(parallel.image.drawSessionId);
  });

  it("a turn that ends without a picture, a usage limit and a restart all say why", async () => {
    const { manager, codex, work, dir, store } = setup();
    const session = manager.createSession(work.id, { provider: "codex" });
    await manager.images.draw(session.id, { requestId: "e1", brief: "그림 없이 끝남" });
    codex.end(session.id);
    expect(images(manager, session.id)[0]?.image).toMatchObject({ status: "failed", error: expect.stringContaining("그림 없이") });

    await manager.images.draw(session.id, { requestId: "e2", brief: "한도" });
    manager.sink.image?.(session.id, { id: "ig_9", status: "failed", result: null, savedPath: null, revisedPrompt: null, failure: { type: "usageLimitExceeded", resetsAt: 1_900_000_000 } });
    codex.end(session.id);
    expect(manager.images.get("e2")).toMatchObject({ status: "failed", error: expect.stringContaining("한도") });

    await manager.images.draw(session.id, { requestId: "e3", brief: "다시 시작" });
    store.close();
    const again = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    expect(again.images.get("e3")).toMatchObject({ status: "failed", error: expect.stringContaining("다시 시작") });
    expect(again.items(session.id).items.find((item): item is ImageItem => item.kind === "image" && item.image.id === "e3")?.image.status).toBe("failed");
  });

  it("a busy Codex conversation does not take a drawing, and nothing is steered in", async () => {
    const { manager, work } = setup();
    const session = manager.createSession(work.id, { provider: "codex" });
    await manager.send(session.id, "busy", "일하는 중");
    await expect(manager.images.draw(session.id, { requestId: "b1", brief: "원" })).rejects.toThrow(/일하는 중/);
    await expect(manager.send(session.id, "b2", "원", [], null, null, "auto", { engineText: "x" })).rejects.toThrow(/일하는 중/);
  });

  it("serves picture files only from inside the work folder", () => {
    const { manager, work, cwd, dir } = setup();
    mkdirSync(join(cwd, "images"));
    writeFileSync(join(cwd, "images", "a.png"), png(4, 4));
    writeFileSync(join(dir, "outside.png"), png(4, 4));
    symlinkSync(join(dir, "outside.png"), join(cwd, "images", "link.png"));
    writeFileSync(join(cwd, "notes.md"), "# x");
    expect(manager.images.file(work.id, "images/a.png")).toMatchObject({ type: "image/png" });
    expect(manager.images.file(work.id, join(cwd, "images", "a.png")).path).toBe(join(cwd, "images", "a.png"));
    expect(() => manager.images.file(work.id, "../outside.png")).toThrow(/밖/);
    expect(() => manager.images.file(work.id, "images/link.png")).toThrow(/밖/);
    expect(() => manager.images.file(work.id, "notes.md")).toThrow(/그림 파일/);
    expect(() => manager.images.file(work.id, "images/none.png")).toThrow(/없습니다/);
    expect(existsSync(join(cwd, "images"))).toBe(true);
    expect(readdirSync(join(cwd, "images")).sort()).toEqual(["a.png", "link.png"]);
  });

  it("a picture Codex draws on its own (asked in words) also lands in the work folder", () => {
    const { manager, work, cwd } = setup();
    const session = manager.createSession(work.id, { provider: "codex" });
    manager.sink.image?.(session.id, { id: "ig_own", status: "completed", result: png(10, 10).toString("base64"), savedPath: null, revisedPrompt: "A small cat icon\nflat", failure: null });
    const [card] = images(manager, session.id);
    expect(card?.image).toMatchObject({ id: "codex:ig_own", status: "done", brief: "A small cat icon" });
    expect(existsSync(join(cwd, card!.image.relPath!))).toBe(true);
    // The same item reported twice makes one card.
    manager.sink.image?.(session.id, { id: "ig_own", status: "completed", result: png(10, 10).toString("base64"), savedPath: null, revisedPrompt: null, failure: null });
    expect(images(manager, session.id)).toHaveLength(1);
  });
});
