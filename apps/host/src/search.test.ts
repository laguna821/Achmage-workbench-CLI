import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FoundHit, SearchPage, Session, TranscriptItem, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Pkm } from "./pkm.ts";
import { FIND_HEAD, FIND_LIMIT, findToolInstructions } from "./search.ts";
import { parseQuery, snippetOf, wordTokens } from "./search-text.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { put } from "./vault-fixture.ts";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-search-"));
  dirs.push(dir);
  const store = new Store(join(dir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  return { dir, store, bus, manager };
}

let clock = Date.now() - 3_600_000;
/** Messages straight into a session, the way engines' adapters report them. */
function say(manager: SessionManager, sessionId: string, ...items: (["user" | "assistant", string] | TranscriptItem)[]) {
  const ids: string[] = [];
  for (const entry of items) {
    clock += 1000;
    const item: TranscriptItem = Array.isArray(entry)
      ? entry[0] === "user"
        ? { kind: "user", id: `user:${clock}`, text: entry[1], at: clock }
        : { kind: "assistant", id: `a:${clock}`, text: entry[1], streaming: false, at: clock }
      : { ...entry, at: clock };
    manager.sink.upsertItem(sessionId, item);
    ids.push(item.id);
  }
  return ids;
}

const hits = (page: SearchPage) => page.groups.flatMap((group) => group.hits);
const keys = (page: SearchPage) => hits(page).map((hit) => hit.key);
const all = { limit: 100, per: 20 };

function work(manager: SessionManager, title: string, provider: "claude" | "codex" = "codex", purpose = "대화"): { work: Work; session: Session } {
  const created = manager.createWork({ title, titleSource: "user" });
  const session = manager.createSession(created.id, { provider, purpose });
  manager.updateSession(session.id, { purpose });
  return { work: created, session };
}

describe("query text", () => {
  it("pairs Korean syllables, keeps other words whole, and splits scripts", () => {
    expect(wordTokens("채점기준표")).toEqual(["채점", "점기", "기준", "준표"]);
    expect(wordTokens("표 AI교육 Playwright-cli 3주차")).toEqual(["표", "ai", "교육", "playwright", "cli", "3", "주차"]);
  });

  it("takes particles off, finds joined words spaced and spaced words joined, and leaves one syllable to LIKE", () => {
    const josa = parseQuery("기준을");
    expect(josa.parts.map((part) => part.term)).toEqual(["기준"]);
    expect(josa.parts[0]!.words).toEqual(['"기준"']);
    const joined = parseQuery("채점기준");
    expect(joined.parts[0]!.words).toContain('"채점 기준"');
    expect(joined.needles).toEqual(expect.arrayContaining(["채점기준", "채점", "기준"]));
    const spaced = parseQuery("채점 기준");
    expect(spaced.phrase).toEqual(['"채점 기준"', '"채점 점기 기준"']);
    expect(spaced.needles).toContain("채점기준");
    expect(parseQuery("wright").parts[0]!.text).toBe('"wright"');
    expect(parseQuery("AI").parts[0]!.words).toEqual(['"ai"']);
    expect(parseQuery("표").parts[0]!.like).toBe("표");
    expect(parseQuery('"근거 정리"').parts[0]).toMatchObject({ quoted: true, words: ['"근거 정리"'] });
  });

  it("marks overlapping matches once", () => {
    const { snippet, ranges } = snippetOf("채점기준을 정한 채점 기준", ["채점기준", "채점", "기준"]);
    expect(ranges.map(([from, to]) => snippet.slice(from, to))).toEqual(["채점기준", "채점", "기준"]);
  });
});

describe("one ranked index", () => {
  it("finds Korean two-syllable words, longer words, words with particles, spaced and joined", () => {
    const { manager } = setup();
    const { session } = work(manager, "강의", "codex", "과제 정리");
    const [request, reply] = say(manager, session.id, ["user", "채점 기준을 세 단계로 나눠 줘"], ["assistant", "채점기준표를 만들었습니다. 평가 항목은 셋입니다."]);
    const other = work(manager, "논문", "claude", "그림 손보기").session;
    const [table, cover] = say(manager, other.id, ["user", "기준 표를 붙여 줘"], ["assistant", "표지를 바꿨습니다."]);
    const key = (sessionId: string, itemId: string) => `item:${sessionId}:${itemId}`;

    const two = manager.search("기준", all);
    expect(keys(two)).toEqual(expect.arrayContaining([key(session.id, request!), key(session.id, reply!), key(other.id, table!)]));
    expect(keys(two)).not.toContain(key(other.id, cover!));
    const particle = manager.search("기준을", all);
    expect(particle.terms).toEqual(["기준"]);
    expect(keys(particle).sort()).toEqual(keys(two).sort());
    // Joined in the query, spaced in the request (and the other way round).
    expect(keys(manager.search("채점기준", all))).toEqual(expect.arrayContaining([key(session.id, request!), key(session.id, reply!)]));
    expect(keys(manager.search("채점 기준", all))).toEqual(expect.arrayContaining([key(session.id, request!), key(session.id, reply!)]));
    expect(keys(manager.search("채점기준표", all))).toEqual([key(session.id, reply!)]);
    // "기준표" is also "기준 표를".
    expect(keys(manager.search("기준표", all))).toEqual(expect.arrayContaining([key(session.id, reply!), key(other.id, table!)]));
    // One syllable: the last resort (LIKE) still finds it inside words.
    expect(keys(manager.search("표", all))).toEqual(expect.arrayContaining([key(session.id, reply!), key(other.id, table!), key(other.id, cover!)]));
    const marked = hits(manager.search("채점 기준", all)).find((hit) => hit.itemId === request)!;
    expect(marked.ranges.map(([from, to]) => marked.snippet.slice(from, to))).toEqual(["채점", "기준"]);
  });

  it("ranks a title above a body match, and the user's own words above the same words in a reply", () => {
    const { manager } = setup();
    const titled = work(manager, "루브릭 설계", "claude", "준비");
    const other = work(manager, "수업 운영", "codex", "메모");
    say(manager, other.session.id, ["assistant", "다음 주에는 루브릭 초안을 같이 보면서 항목별 점수 기준을 다듬고, 예시 답안도 두 개 붙이겠습니다."]);
    const first = hits(manager.search("루브릭", all))[0]!;
    expect(first).toMatchObject({ kind: "work", workId: titled.work.id });
    expect(first.titleRanges.length).toBe(1);
    const [mine, theirs] = say(manager, titled.session.id, ["user", "발표 일정 정리"], ["assistant", "발표 일정 정리"]);
    const order = hits(manager.search("발표 일정", all)).map((hit) => hit.itemId);
    expect(order.indexOf(mine!)).toBeLessThan(order.indexOf(theirs!));
  });

  it("shows a document and the reply that made it as one row, and leaves conversation records out", () => {
    const { manager } = setup();
    const { work: lecture, session } = work(manager, "보고", "claude", "보고서 쓰기");
    const [request] = say(manager, session.id, ["user", "보고서 초안을 써 줘"]);
    const file = join(lecture.cwd, "보고서.md");
    writeFileSync(file, "# 보고서\n\n예산 집행 계획을 정리했습니다.\n");
    const tracked = manager.documents.track(lecture.id, lecture.cwd, file, "engine", session.id, null)!;
    const [, reply] = say(
      manager,
      session.id,
      { kind: "artifact", id: "artifact:1", artifactId: tracked.artifact.id, revision: 1, change: "created", at: 0 },
      ["assistant", "보고서.md에 예산 집행 계획을 정리해 두었습니다."],
    );
    const joined = manager.search("예산 집행", all);
    expect(joined.total).toBe(1);
    expect(hits(joined)[0]).toMatchObject({ kind: "document", artifactId: tracked.artifact.id, revision: 1, provider: "claude", sessionTitle: "보고서 쓰기", answer: { sessionId: session.id, itemId: reply, matched: true } });
    // The request still has its own row; the reply does not.
    const named = manager.search("보고서", all);
    expect(keys(named)).toContain(`item:${session.id}:${request}`);
    expect(keys(named)).not.toContain(`item:${session.id}:${reply}`);
    // "마크다운으로 내보내기" makes a record of the conversation: found in the conversation, not twice.
    const exported = manager.exportMarkdown(session.id, { target: "work" });
    expect(exported.artifactId).toBeTruthy();
    expect(hits(manager.search("예산 집행", all)).some((hit) => hit.artifactId === exported.artifactId)).toBe(false);
  });

  it("finds plans waiting for the go-ahead and the names of attached files", () => {
    const { manager } = setup();
    const { session } = work(manager, "연구", "claude", "설문");
    const [claudePlan] = say(manager, session.id, { kind: "approval", id: "approval:t1", title: "이 계획대로 진행할까요?", detail: "1. 설문 문항을 고친다\n2. 표본을 늘린다", reason: null, decision: null, plan: true, at: 0 });
    expect(hits(manager.search("표본", all))).toMatchObject([{ kind: "plan", itemId: claudePlan }]);
    // Codex: the plan is the reply above the go-ahead.
    const [, plan] = say(manager, session.id, ["user", "실험 계획 세워 줘"], ["assistant", "## 계획\n1. 표집 방법 바꾸기"], { kind: "approval", id: "plan:r1", title: "이 계획대로 진행할까요?", detail: null, reason: null, decision: "accept", plan: true, at: 0 });
    expect(hits(manager.search("표집", all))).toMatchObject([{ kind: "plan", itemId: plan }]);
    const [request] = say(manager, session.id, { kind: "user", id: "user:files", text: "첨부 확인해 줘", attachments: [{ id: "a1.pdf", name: "강의계획서_2026.pdf", mime: "application/pdf", size: 10 }], at: 0 });
    const found = hits(manager.search("강의계획서", all));
    expect(found).toMatchObject([{ kind: "attachment", itemId: request }]);
    expect(found[0]!.snippet).toContain("강의계획서_2026.pdf");
  });

  it("groups by work with totals and pages, counts every scope, and leaves archived things out unless asked", () => {
    const { manager } = setup();
    const sessions: Session[] = [];
    for (let index = 0; index < 12; index += 1) {
      const { session } = work(manager, `작업 ${index + 1}`, index % 2 ? "claude" : "codex", `세션 ${index + 1}`);
      say(manager, session.id, ["user", `회의록 ${index + 1}번 정리`], ["assistant", `회의록을 정리했습니다 (${index + 1})`]);
      sessions.push(session);
    }
    const first = manager.search("회의록", { limit: 5, per: 1 });
    expect(first.groupsTotal).toBe(12);
    expect(first.groups).toHaveLength(5);
    expect(first.total).toBe(24);
    expect(first.counts).toMatchObject({ all: 24, session: 24, document: 0, vault: 0, project: 0, decision: 0 });
    expect(first.groups[0]!.total).toBe(2);
    expect(first.groups[0]!.hits).toHaveLength(1);
    const last = manager.search("회의록", { limit: 5, per: 1, offset: 10 });
    expect(last.groups).toHaveLength(2);
    const one = manager.search("회의록", { group: first.groups[0]!.key, limit: 1 });
    expect(one.groups).toHaveLength(1);
    expect(one.groups[0]!.total).toBe(2);
    expect(one.groups[0]!.hits).toHaveLength(1);
    expect(manager.search("회의록", { group: first.groups[0]!.key, limit: 1, offset: 1 }).groups[0]!.hits).toHaveLength(1);
    expect(manager.search("회의록", { scope: "document" }).groups).toEqual([]);
    expect(manager.search("회의록", { provider: "claude", ...all }).total).toBe(12);

    manager.updateSession(sessions[0]!.id, { archived: true });
    expect(manager.search("회의록", all).total).toBe(22);
    expect(manager.search("회의록", { ...all, archived: true }).total).toBe(24);
  });

  it("rebuilds an index written by an older version once", () => {
    const { dir, store, manager } = setup();
    const { session } = work(manager, "옛 작업", "codex", "오래된 대화");
    say(manager, session.id, ["user", "옛날 색인에 있던 핵심 문장"]);
    // As version 1 left it: its own tables and version mark.
    const raw = new DatabaseSync(join(dir, "state.sqlite"));
    raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS item_search USING fts5(text, tokenize = 'trigram'); DELETE FROM search_entries; DELETE FROM search_text; DELETE FROM search_words;");
    raw.prepare("UPDATE meta SET value = '1' WHERE key = 'search.version'").run();
    raw.close();
    store.close();
    const again = new Store(join(dir, "state.sqlite"));
    const reopened = new SessionManager(again, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    expect(reopened.search("핵심 문장").total).toBe(1);
    expect(again.getMeta("search.version")).toBe("2");
    const tables = new DatabaseSync(join(dir, "state.sqlite")).prepare("SELECT name FROM sqlite_master WHERE name = 'item_search'").all();
    expect(tables).toEqual([]);
    // Built once: what is put afterwards stays when the store opens again.
    again.search.put({ key: "decision:w:1", kind: "decision", scope: "decision", workId: null, at: Date.now(), title: "표지는 B안", body: "" });
    again.close();
    const third = new Store(join(dir, "state.sqlite"));
    expect(third.search.signature("decision:w:1")).not.toBeNull();
    third.close();
  });

  it("lets other modules add their own source of entries (decisions, open questions, events)", () => {
    const { store, manager } = setup();
    const { work: project } = work(manager, "안녕", "codex", "표지");
    const decisions = () => [{ key: `decision:${project.id}:1`, kind: "decision" as const, scope: "decision" as const, workId: project.id, at: Date.now(), title: "표지는 B안", body: "표지는 B안으로 정했다" }];
    expect(store.search.source("decision", "1", decisions)).toBe(true);
    expect(store.search.source("decision", "1", decisions)).toBe(false);
    const found = manager.search("표지", { scope: "decision" });
    expect(found.counts.decision).toBe(1);
    expect(hits(found)[0]).toMatchObject({ kind: "decision", workId: project.id, title: "표지는 B안" });
  });
});

describe("workbench-find", () => {
  it("prints records with where they come from, the calling session's work unless --all, at most 4 KB", () => {
    const { manager } = setup();
    const { session } = work(manager, "안녕", "codex", "과제 채점 기준표");
    const other = work(manager, "다른 일", "claude", "다른 세션").session;
    say(manager, session.id, ["user", "채점 기준을 세 단계로 나눠 줘"], ["assistant", "채점 기준은 이해·적용·설명 세 단계입니다."]);
    say(manager, other.id, ["user", "다른 작업의 채점 기준 메모"]);
    const out = manager.finder.find(["채점 기준"], { sessionId: session.id });
    const lines = out.stdout.trim().split("\n");
    expect(out.code).toBe(0);
    expect(lines[0]).toContain(FIND_HEAD);
    expect(lines[0]).toContain("작업 「안녕」");
    // The session's own name matches too ("세션"), then the request and the reply.
    expect(lines.slice(1).every((line) => /^\[안녕 · Codex · 과제 채점 기준표 · \d\d-\d\d \d\d:\d\d · (세션|요청|답)\] /.test(line))).toBe(true);
    expect(lines).toHaveLength(4);
    const everywhere = manager.finder.find(["--all", "채점 기준"], { sessionId: session.id }).stdout;
    expect(everywhere).toContain("[다른 일 · Claude · 다른 세션");
    // Archived only with --archived.
    manager.updateSession(other.id, { archived: true });
    expect(manager.finder.find(["--all", "다른 작업의"], { sessionId: session.id }).stdout).toContain("찾은 기록이 없습니다");
    expect(manager.finder.find(["--all", "--archived", "다른 작업의"], { sessionId: session.id }).stdout).toContain("[다른 일 · Claude");

    // Many hits: never more than 4 KB, and the rest is named, not dropped.
    for (let index = 0; index < 60; index += 1) say(manager, session.id, ["assistant", `채점 기준 ${index}: ${"긴 설명이 이어집니다. ".repeat(12)}`]);
    const many = manager.finder.find(["채점 기준"], { sessionId: session.id });
    expect(Buffer.byteLength(many.stdout)).toBeLessThanOrEqual(FIND_LIMIT);
    const tail = many.stdout.trim().split("\n").at(-1)!;
    expect(tail).toMatch(/^… 총 63건 중 1–\d+건을 보였습니다\. 나머지: workbench-find --offset=\d+ "채점 기준"$/);
    const next = Number(/--offset=(\d+)/.exec(tail)![1]);
    expect(manager.finder.find([`--offset=${next}`, "채점 기준"], { sessionId: session.id }).stdout.split("\n")[1]).toMatch(/^\[안녕 · Codex/);
    expect(findToolInstructions().split("\n")).toHaveLength(2);
    // Run by the engine during a turn: that turn's own request is not one of the records.
    say(manager, session.id, ["user", "찾아 줘: 채점 기준"]);
    expect(manager.finder.find(["찾아 줘"], { sessionId: session.id }).stdout).toContain("총 1건");
    manager.sink.updateSession(session.id, { status: "running" });
    expect(manager.finder.find(["찾아 줘"], { sessionId: session.id }).stdout).toContain("찾은 기록이 없습니다");
  });

});

describe("vault notes", () => {
  function vaultSetup() {
    const base = setup();
    const vault = join(base.dir, "vault");
    put(vault, ".obsidian/app.json", "{}");
    put(vault, ".obsidian/plugins/notebook-navigator/data.json", JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["/비밀*"], hiddenFileNames: ["숨긴 파일*"] }] }));
    put(vault, "수업/형성평가 메모.md", ["---", "title: 형성평가 메모", "aliases: [퀴즈 메모]", "tags: [평가]", '"DIKM_단계:": 🔵 I', "---", "형성평가는 수업 중간에 짧게 본다."].join("\n"));
    put(vault, "비밀/일기.md", "형성평가 이야기와 비밀단어 하나.");
    put(vault, "비밀/깊은 곳/메모.md", "비밀단어 둘");
    put(vault, "수업/숨긴 파일 하나.md", "비밀단어 셋");
    put(vault, "홈.md", "볼트 첫 화면");
    const pkm = new Pkm(base.store, base.bus, base.manager, { dataDir: base.dir, vaultDebounceMs: 30 });
    closers.push(() => pkm.close());
    pkm.attachVault(vault);
    return { ...base, vault, pkm };
  }
  const listing = (root: string) => {
    const out: string[] = [];
    const walk = (at: string) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(`${full}:${statSync(full).size}:${statSync(full).mtimeMs}`);
      }
    };
    walk(root);
    return out.sort();
  };

  it("indexes notes but never the folders and files hidden in Notebook Navigator, and follows the mirror", async () => {
    const { bus, manager, vault, pkm } = vaultSetup();
    const before = listing(vault);
    await manager.finder.useVault(pkm.vault, bus);
    const notes = manager.search("형성평가", { scope: "vault", ...all });
    expect(hits(notes).map((hit) => hit.path)).toEqual(["수업/형성평가 메모.md"]);
    expect(manager.search("퀴즈", all).counts.vault).toBe(1);
    expect(manager.search("비밀단어", all).total).toBe(0);
    const { session } = work(manager, "w", "claude", "s");
    expect(manager.finder.find(["--all", "비밀단어"], { sessionId: session.id }).stdout).toContain("찾은 기록이 없습니다");
    expect(manager.finder.find(["--all", "형성평가"], { sessionId: session.id }).stdout).toContain("[볼트 · ");
    // Without --all a session's search stays in its work.
    expect(manager.finder.find(["형성평가"], { sessionId: session.id }).stdout).toContain("찾은 기록이 없습니다");

    // A note added on disk is found once the mirror reports it.
    put(vault, "수업/새 노트.md", "루브릭 초안");
    pkm.vault.rescan();
    await manager.finder.vaultIndexed();
    expect(hits(manager.search("루브릭", all)).map((hit: FoundHit) => hit.path)).toEqual(["수업/새 노트.md"]);
    // Hiding a folder in Notebook Navigator takes its notes out.
    put(vault, ".obsidian/plugins/notebook-navigator/data.json", JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["/비밀*", "수업"] }] }));
    pkm.vault.rescan(true);
    await manager.finder.vaultIndexed();
    expect(manager.search("형성평가", all).counts.vault).toBe(0);
    expect(manager.search("루브릭", all).total).toBe(0);
    // Only read: the vault is as it was, apart from the files this test wrote.
    expect(listing(vault).filter((line) => !line.includes("새 노트") && !line.includes("notebook-navigator"))).toEqual(before.filter((line) => !line.includes("notebook-navigator")));
  });

  it("lets a saved view's plain words find what was said in a session", async () => {
    const { bus, manager, pkm } = vaultSetup();
    await manager.finder.useVault(pkm.vault, bus);
    const { session } = work(manager, "수업 준비", "codex", "첫 주");
    say(manager, session.id, ["assistant", "형성평가 문항 세 개를 만들었습니다."]);
    const cards = pkm.viewCards({ name: "t", query: "kind:session 형성평가", groupBy: null }).cards;
    expect(cards.map((card) => card.id)).toEqual([session.id]);
    const notes = pkm.viewCards({ name: "t", query: "kind:note 형성평가", groupBy: null }).cards;
    expect(notes.map((card) => card.id)).toEqual(["수업/형성평가 메모.md"]);
    expect(pkm.viewCards({ name: "t", query: "kind:note 비밀단어", groupBy: null }).cards).toEqual([]);
    expect(existsSync(join(pkm.vault.root!, "비밀/일기.md"))).toBe(true);
  });
});
