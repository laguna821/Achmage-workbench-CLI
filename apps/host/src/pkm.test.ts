import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Pkm } from "./pkm.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";
import { makeFixtureVault, put } from "./vault-fixture.ts";

// The PKM layer on a fixture vault in a temporary folder (the user's vault is never touched).

/** An engine that keeps what it was sent and answers at once. */
class Engine implements ProviderAdapter {
  readonly provider: "claude" | "codex";
  readonly texts: string[] = [];
  private readonly sink: () => AdapterSink;
  constructor(provider: "claude" | "codex", sink: () => AdapterSink) {
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
    this.texts.push(text);
    const sink = this.sink();
    sink.upsertItem(session.id, { kind: "assistant", id: `a:${turnKey}`, text: "답", streaming: false, at: Date.now() });
    sink.upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 1, at: Date.now() });
    sink.updateSession(session.id, { status: "idle" });
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

function files(root: string) {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${full}:${statSync(full).mtimeMs}:${statSync(full).size}`);
    }
  };
  walk(root);
  return out.sort();
}

export function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-pkm-"));
  dirs.push(dir);
  const vault = makeFixtureVault(join(dir, "vault"));
  put(
    vault,
    "20. Information (I)/수업 설계.md",
    ["---", "title: 수업 설계", '"DIKM_단계:":', "  - 🔵 I", "tags: [AI_교육]", "date created: 2026-10-01", "---", "", "![[pic.png]]", "첫 문단은 [[a|에이 노트]]와 [[없는 노트]]를 잇는다.", ""].join("\n"),
  );
  const store = new Store(join(dir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
  const claude = new Engine("claude", () => manager.sink);
  const codex = new Engine("codex", () => manager.sink);
  manager.registerAdapter(claude);
  manager.registerAdapter(codex);
  const pkm = new Pkm(store, bus, manager, { vaultDebounceMs: 30, dataDir: dir });
  pkm.attachVault(vault);
  return { dir, vault, store, bus, manager, pkm, engines: { claude, codex } };
}

describe("card lists", () => {
  it("lists a vault folder's notes (and its subfolders') with title, excerpt, tags, date, picture; pinned first", () => {
    const { pkm } = setup();
    const list = pkm.cards({ kind: "vault", path: "20. Information (I)", descendants: true });
    // Newest first: the two notes written just now, then the one created on 2026-10-01.
    expect(list.cards.map((card) => card.id).sort()).toEqual(["20. Information (I)/201. Topics/t1.md", "20. Information (I)/x.md", "20. Information (I)/수업 설계.md"]);
    expect(list.cards.at(-1)!.id).toBe("20. Information (I)/수업 설계.md");
    const card = list.cards.find((entry) => entry.id.endsWith("수업 설계.md"))!;
    expect(card).toMatchObject({ title: "수업 설계", stage: "🔵 I", tags: ["AI_교육"], dateKind: "created", thumb: { vault: "attachments/pic.png" } });
    expect(card.excerpt).toBe("첫 문단은 에이 노트와 없는 노트를 잇는다.");
    expect(pkm.cards({ kind: "vault", path: "20. Information (I)", descendants: false }).cards).toHaveLength(2);
    const inbox = pkm.cards({ kind: "vault", path: "01. Inbox", descendants: false });
    expect(inbox.cards[0]!.pinned).toBe(true);
    expect(() => pkm.cards({ kind: "vault", path: "90. Settings", descendants: true })).toThrow();
  });

  it("lists a work's sessions and pages, and an app folder's works", () => {
    const { pkm, manager } = setup();
    const folder = manager.createFolder("강의", null);
    const work = manager.createWork({ title: "1주차", folderId: folder.id });
    manager.createSession(work.id, { provider: "claude", purpose: "수업 계획" });
    manager.createPage(work.id, "읽을거리");
    const cards = pkm.cards({ kind: "work", id: work.id }).cards;
    expect(cards.map((card) => card.kind).sort()).toEqual(["page", "session"]);
    expect(pkm.cards({ kind: "folder", id: folder.id }).cards.map((card) => card.title)).toEqual(["1주차"]);
  });
});

describe("vault notes", () => {
  it("opens a note read-only with its properties as spelled and its links and pictures resolved", () => {
    const { pkm } = setup();
    const note = pkm.note("20. Information (I)/수업 설계.md");
    expect(note.properties.map(([key]) => key)).toEqual(["title", "DIKM_단계:", "tags", "date created"]);
    expect(note.links).toEqual({ a: "01. Inbox/a.md", "없는 노트": null });
    expect(note.embeds).toEqual({ "pic.png": "attachments/pic.png" });
    expect(() => pkm.note("90. Settings/91. Templates/tpl.md")).toThrow();
    expect(() => pkm.vaultImage("../state.sqlite")).toThrow();
    expect(() => pkm.vaultImage("01. Inbox/a.md")).toThrow();
  });

  it("resolves notes put into a note and HTML pictures, and shows a web picture as the card's picture", () => {
    const { pkm, vault } = setup();
    put(vault, "20. Information (I)/모음.md", ["![표지](https://pub-x.r2.dev/1-cover.png)", "![[a]] ![[a#제목|별칭]] ![[없는 노트]] ![[pic.png|300]]", '<img src="../attachments/pic.png" width="300">', ""].join("\n"));
    pkm.vault.rescan(true);
    const note = pkm.note("20. Information (I)/모음.md");
    expect(note.links).toEqual({ a: "01. Inbox/a.md", "없는 노트": null });
    expect(note.embeds).toEqual({ "pic.png": "attachments/pic.png", "../attachments/pic.png": "attachments/pic.png" });
    const card = pkm.cards({ kind: "vault", path: "20. Information (I)", descendants: false }).cards.find((entry) => entry.id.endsWith("모음.md"))!;
    expect(card.thumb).toEqual({ url: "https://pub-x.r2.dev/1-cover.png" });
  });

  it("gives attached notes to the engine as read-only copies in the work folder (both engines), never writing the vault", async () => {
    const { pkm, manager, vault, engines } = setup();
    const before = files(vault);
    for (const provider of ["claude", "codex"] as const) {
      const work = manager.createWork({ title: provider });
      const session = manager.createSession(work.id, { provider });
      await manager.send(session.id, `r-${provider}`, "이 노트를 정리해 줘", [], null, null, "auto", { notes: ["20. Information (I)/수업 설계.md"] });
      const text = engines[provider].texts.at(-1)!;
      expect(text).toContain("[볼트 노트 · 읽기 전용]");
      expect(text).toContain("「수업 설계」 (20. Information (I)/수업 설계.md)");
      const copy = /읽기 전용 사본: ([^\n]+)/.exec(text)![1]!.trim();
      const full = join(work.cwd, copy);
      expect(readFileSync(full)).toEqual(readFileSync(join(vault, "20. Information (I)/수업 설계.md")));
      expect(statSync(full).mode & 0o222).toBe(0);
      const request = manager.items(session.id).items.find((item) => item.kind === "user");
      expect(request?.kind === "user" && request.notes).toEqual([{ path: "20. Information (I)/수업 설계.md", title: "수업 설계" }]);
    }
    expect(pkm.note("20. Information (I)/수업 설계.md").sessions).toBe(2);
    expect(files(vault)).toEqual(before);
    const work = manager.createWork({ title: "없음" });
    const session = manager.createSession(work.id, { provider: "claude" });
    await expect(manager.send(session.id, "r-missing", "x", [], null, null, "auto", { notes: ["../outside.md"] })).rejects.toThrow();
    expect(existsSync(join(vault, "..", "outside.md"))).toBe(false);
  });
});

describe("pages phase 2", () => {
  const TEMPLATE = ["---", "title: ", '"DIKM_단계:":', "  - 🟢 D", "  - 🔵 I", '"종류:":', "  - 노트", "  - 논문", "tags: ", "date created: ", "source:", "---", "", "> <% tp.file.title %>", ""].join("\n");

  it("offers templates of the app, the work and the vault, and makes pages from them in the work folder only", () => {
    const { pkm, manager, vault, dir } = setup();
    const work = manager.createWork({ title: "강의" });
    put(dir, "templates/앱 메모.md", "# 앱 메모\n");
    put(work.cwd, ".workbench/templates/작업 노트.md", TEMPLATE);
    put(vault, "90. Settings/91. Templates/DIKM.md", TEMPLATE);
    const before = files(vault);
    const templates = pkm.templates(work.id);
    expect(templates.map((template) => template.id).sort()).toEqual(["global:앱 메모.md", "vault:DIKM.md", "vault:tpl.md", "work:작업 노트.md"].sort());
    const dikm = templates.find((template) => template.id === "vault:DIKM.md")!;
    expect(dikm).toMatchObject({ source: "vault", templater: true, choices: [{ key: "DIKM_단계:", options: ["🟢 D", "🔵 I"] }, { key: "종류:", options: ["노트", "논문"] }] });
    const page = pkm.pageFromTemplate(work.id, "vault:DIKM.md", "1주차: 오리엔테이션", { "DIKM_단계:": ["🔵 I", "꾸며낸 값"], "종류:": [] }, null);
    expect(page.path.startsWith(work.cwd)).toBe(true);
    const text = readFileSync(page.path, "utf8");
    expect(text).toMatch(/^---\ntitle: "1주차: 오리엔테이션"\n"DIKM_단계:":\n  - 🔵 I\n"종류:":\ntags: \ndate created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\nsource:\n---\n\n> <% tp.file.title %>\n$/);
    expect(files(vault)).toEqual(before);
    expect(() => pkm.pageFromTemplate(work.id, "vault:../../x.md", "x", {}, null)).toThrow();
  });

  it("makes subpages beside their page, and pages from a session and from a message", async () => {
    const { pkm, manager } = setup();
    const work = manager.createWork({ title: "강의" });
    const other = manager.createWork({ title: "기록함" });
    const parent = manager.createPage(work.id, "개요");
    const child = pkm.subpage(parent.id, "1주차");
    expect(child.path).toBe(join(work.cwd, "개요", "1주차.md"));
    expect(readFileSync(parent.path, "utf8")).toBe("# 개요\n\n");
    const session = manager.createSession(work.id, { provider: "claude", purpose: "수업 설계" });
    await manager.send(session.id, "r1", "수업 계획을 세워 줘");
    const page = pkm.sessionPage(session.id, other.id);
    expect(page.workId).toBe(other.id);
    expect(page.path.startsWith(join(other.cwd, "세션 기록"))).toBe(true);
    expect(readFileSync(page.path, "utf8")).toContain(`session: ${session.id}`);
    const own = pkm.sessionPage(session.id, work.id);
    expect(own.path.startsWith(join(work.cwd, "세션 기록"))).toBe(true);
    const reply = manager.items(session.id).items.find((item) => item.kind === "assistant")!;
    const fromMessage = pkm.messagePage(session.id, reply.id, null);
    const text = readFileSync(fromMessage.path, "utf8");
    expect(text).toContain(`source: workbench://session/${session.id}#${encodeURIComponent(reply.id)}`);
    expect(text).toContain("\n답\n");
    expect(() => pkm.subpage(child.id.replace(/./g, "x"), "x")).toThrow();
  });
});

describe("context card and write guard", () => {
  it("gives new sessions the work, the vault and its pinned notes, and guards the vault for both engines", () => {
    const { pkm, manager, vault } = setup();
    const work = manager.createWork({ title: "1주차" });
    pkm.setPin(work.id, "20. Information (I)/수업 설계.md", true);
    expect(() => pkm.setPin(work.id, "없는 노트.md", true)).toThrow();
    const session = { ...manager.createSession(work.id, { provider: "claude" }), access: "full" as const };
    const claude = pkm.claudeLaunch(session, manager.view.works.get(work.id)!);
    expect(claude.append).toContain("작업: 1주차");
    expect(claude.append).toContain(`- ${join(vault, "20. Information (I)/수업 설계.md")}`);
    expect(claude.hooks?.PreToolUse?.[0]?.matcher).toContain("Write");
    const codex = pkm.codexLaunch({ ...session, provider: "codex", access: "auto" }, manager.view.works.get(work.id)!);
    expect(codex).toMatchObject({ readOnly: false, excludeTmp: true });
    expect(codex.instructions).toBe(claude.append);
    expect(pkm.cards({ kind: "work", id: work.id }).cards.some((card) => card.kind === "note" && card.pinned)).toBe(true);
    pkm.setPin(work.id, "20. Information (I)/수업 설계.md", false);
    expect(pkm.claudeLaunch(session, work).append).not.toContain("고정한 노트");
    pkm.attachVault(null);
    expect(pkm.claudeLaunch(session, work).hooks).toBeNull();
  });
});

describe("notes the engines read by themselves", () => {
  it("counts the sessions whose engine read a vault note (apart from notes attached), never hidden ones, once per session", () => {
    const { pkm, manager, vault, dir } = setup();
    mkdirSync(join(dir, "w"), { recursive: true });
    const work = manager.createWork({ title: "w", cwd: join(dir, "w") });
    const session = manager.createSession(work.id, { provider: "codex" });
    const read = (id: string, files: string[]) =>
      manager.sink.upsertItem(session.id, { kind: "tool", id, tool: "command", title: "cat", detail: null, output: null, status: "completed", at: 1, reads: files });
    read("t1", [join(vault, "20. Information (I)/수업 설계.md"), join(vault, "90. Settings/91. Templates/tpl.md"), "/etc/hosts", join(dir, "w/a.md")]);
    read("t2", [join(vault, "20. Information (I)/수업 설계.md"), join(vault, "01. Inbox/a.md")]);
    expect(pkm.note("20. Information (I)/수업 설계.md")).toMatchObject({ sessions: 0, engineReads: 1 });
    // Equal counts: by title in Korean order (Hangul before Latin).
    expect(pkm.notesReadBy(new Set([session.id]))).toEqual([
      { path: "20. Information (I)/수업 설계.md", title: "수업 설계", sessions: 1 },
      { path: "01. Inbox/a.md", title: "A", sessions: 1 },
    ]);
    expect(pkm.notesReadBy(new Set(["another"]))).toEqual([]);
    const card = pkm.cards({ kind: "vault", path: "20. Information (I)", descendants: false }).cards.find((entry) => entry.title === "수업 설계");
    expect(card).toMatchObject({ engineReads: 1 });
  });
});
