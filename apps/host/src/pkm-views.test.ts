import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dateRange, parseViewQuery, type Artifact, type PkmRule, type Session, type Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Pkm } from "./pkm.ts";
import { diskFolder, placementFor, underFolder } from "./pkm-rules.ts";
import { filterItems, groupItems, type ViewItem } from "./pkm-views.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { makeFixtureVault, put } from "./vault-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-views-"));
  dirs.push(dir);
  const vault = makeFixtureVault(join(dir, "vault"));
  put(vault, "20. Information (I)/수업.md", ["---", '"DIKM_단계:":', "  - 🔵 I", "tags: [AI_교육/수업]", "---", "본문"].join("\n"));
  put(vault, "20. Information (I)/단계없음.md", ["---", "tags: [AI_교육]", "---", "본문"].join("\n"));
  const store = new Store(join(dir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
  const pkm = new Pkm(store, bus, manager, { dataDir: dir });
  pkm.attachVault(vault);
  return { dir, manager, pkm };
}

const tick = () => new Promise((done) => setTimeout(done, 10));

describe("view queries", () => {
  it("reads Notebook Navigator's syntax plus engine: and status:", () => {
    const { terms, problems } = parseViewQuery('#AI_교육 ."DIKM_단계:"="🔵 I" ."저자:" ."source"="" @last7d engine:codex status:running -kind:work 수업 "두 단어" @sometime engine:gpt');
    expect(terms).toEqual([
      { not: false, kind: "tag", tag: "AI_교육" },
      { not: false, kind: "prop", key: "DIKM_단계:", value: "🔵 I" },
      { not: false, kind: "prop", key: "저자:", value: null },
      { not: false, kind: "prop", key: "source", value: "" },
      { not: false, kind: "date", spec: "last7d" },
      { not: false, kind: "engine", engine: "codex" },
      { not: false, kind: "status", status: "running" },
      { not: true, kind: "type", type: "work" },
      { not: false, kind: "text", text: "수업" },
      { not: false, kind: "text", text: "두 단어" },
    ]);
    expect(problems).toEqual(["@sometime", "engine:gpt"]);
    const now = new Date(2026, 9, 28, 15).getTime();
    expect(dateRange("today", now)[0]).toBe(new Date(2026, 9, 28).getTime());
    expect(dateRange("yesterday", now)).toEqual([new Date(2026, 9, 27).getTime(), new Date(2026, 9, 28).getTime()]);
    expect(dateRange("thisweek", now)[0]).toBe(new Date(2026, 9, 26).getTime());
  });

  it("matches only what a term means for each kind, and groups missing values under '값 없음'", () => {
    const item = (id: string, extra: Partial<ViewItem>): ViewItem => ({
      card: { kind: "note", id, title: id, excerpt: "", tags: [], date: Date.now(), dateKind: "modified", thumb: null, pinned: false, stage: null },
      tags: [],
      properties: [],
      engines: [],
      statuses: [],
      ...extra,
    });
    const items = [
      item("i", { tags: ["AI_교육/수업"], properties: [["DIKM_단계:", ["🔵 I"]]] }),
      item("none", { tags: ["AI_교육"], properties: [["DIKM_단계:", null]] }),
      item("s", { card: { ...item("s", {}).card, kind: "session" }, engines: ["codex"], statuses: ["running"] }),
    ];
    const ids = (query: string) => filterItems(items, parseViewQuery(query).terms).map((entry) => entry.card.id);
    expect(ids("#AI_교육")).toEqual(["i", "none"]);
    expect(ids('."DIKM_단계"="🔵 i"')).toEqual(["i"]);
    expect(ids('."DIKM_단계:"=""')).toEqual(["none", "s"]);
    expect(ids("engine:codex")).toEqual(["s"]);
    expect(ids("-engine:codex")).toEqual(["i", "none"]);
    expect(groupItems(items, "DIKM_단계:").map((group) => [group.label, group.ids.length])).toEqual([["🔵 I", 1], ["값 없음", 2]]);
    const stages = ["⬜ 보류", "🟣 K", "🟢 D"].map((stage) => item(stage, { properties: [["DIKM_단계:", [stage]]] }));
    expect(groupItems(stages, "DIKM_단계:").map((group) => group.label)).toEqual(["🟢 D", "🟣 K", "⬜ 보류"]);
  });
});

describe("saved views over the vault, pages and sessions", () => {
  it("shows matching notes and sessions, newest first, grouped when asked", () => {
    const { pkm, manager } = setup();
    const work = manager.createWork({ title: "실험" });
    manager.createSession(work.id, { provider: "codex", purpose: "코덱스" });
    manager.createSession(work.id, { provider: "claude", purpose: "클로드" });
    expect(pkm.viewCards({ name: "t", query: '."DIKM_단계:"="🔵 I"', groupBy: null }).cards.map((card) => card.id)).toEqual(["20. Information (I)/수업.md"]);
    expect(pkm.viewCards({ name: "t", query: "engine:codex kind:session", groupBy: null }).cards.map((card) => card.title)).toEqual(["코덱스"]);
    const grouped = pkm.viewCards({ name: "t", query: "kind:note #AI_교육", groupBy: "DIKM_단계:" });
    expect(grouped.groups).toEqual([
      { label: "🔵 I", ids: ["note:20. Information (I)/수업.md"] },
      { label: "값 없음", ids: ["note:20. Information (I)/단계없음.md"] },
    ]);
    expect(pkm.state().views.map((view) => view.name)).toEqual(["이번 주 노트", "진행 중인 세션"]);
    const saved = pkm.saveView({ name: "AI 교육", query: "#AI_교육", groupBy: null });
    expect(pkm.state().views.find((view) => view.id === saved.id)?.count).toBe(2);
    pkm.deleteView(saved.id);
    expect(pkm.views().some((view) => view.id === saved.id)).toBe(false);
  });
});

describe("rules", () => {
  const rule = (name: string, when: Partial<PkmRule["when"]>, then: Partial<PkmRule["then"]>): PkmRule => ({
    id: name,
    name,
    enabled: true,
    when: { cwdPrefix: null, engine: null, format: null, ...when },
    then: { folder: null, tag: null, pin: false, ...then },
  });
  const work = (cwd: string, cwdManaged = false) => ({ id: "w", cwd, cwdManaged, folderId: null, tags: [] }) as unknown as Work;
  const session = (provider: "claude" | "codex") => ({ provider }) as Session;
  const doc = (format: Artifact["format"]) => ({ format }) as Artifact;

  it("places by the first rule that matches (folder, engine, document format) and by disk location", () => {
    const rules = [rule("강의", { cwdPrefix: "/home/u/강의" }, { folder: "강의/2026", tag: "수업" }), rule("코덱스", { engine: "codex" }, { folder: "코딩", pin: true }), rule("한글", { format: "hwpx" }, { folder: "문서" }), rule("디스크", {}, { folder: "{disk}" })];
    expect(placementFor(rules, work("/home/u/강의/1주차"), [session("codex")], [])).toMatchObject({ folder: "강의/2026", tag: "수업", rule: { id: "강의" } });
    expect(placementFor(rules, work("/home/u/강의자료/x"), [session("codex")], [])).toMatchObject({ folder: "코딩", pin: true });
    expect(placementFor(rules, work("/srv/a/b"), [session("claude")], [doc("hwpx")])).toMatchObject({ folder: "문서" });
    expect(placementFor(rules, work("/srv/a/b"), [session("claude")], [])).toMatchObject({ folder: "a" });
    // The app's own folders say nothing about where a work is on disk.
    expect(placementFor([rules[3]!], work("/data/works/123", true), [], [])).toBeNull();
    expect(underFolder("/home/u/강의", "/home/u/강의")).toBe(true);
    expect(diskFolder({ cwd: join(tmpdir(), "x"), cwdManaged: false })).toBe(tmpdir().split("/").pop());
  });

  it("places new works by the saved rules (once), and old ones only through preview and apply", async () => {
    const { pkm, manager, dir } = setup();
    const old = manager.createWork({ title: "예전 작업", cwd: join(dir, "projects", "old") });
    mkdirSync(join(dir, "projects", "old"), { recursive: true });
    await tick();
    pkm.saveRules([rule("코덱스", { engine: "codex" }, { folder: "코딩/실험", tag: "codex", pin: true }), rule("디스크 위치대로", {}, { folder: "{disk}" })]);
    await tick();
    const fresh = manager.createWork({ title: "새 작업", cwd: join(dir, "projects", "new") });
    manager.createSession(fresh.id, { provider: "codex" });
    await tick();
    const placed = manager.view.works.get(fresh.id)!;
    const folders = manager.view.folders;
    expect([folders.get(placed.folderId!)?.name, folders.get(folders.get(placed.folderId!)!.parentId!)?.name]).toEqual(["실험", "코딩"]);
    expect(placed).toMatchObject({ pinned: true, tags: ["codex"] });
    expect(pkm.placements()[fresh.id]).toMatchObject({ ruleName: "코덱스" });
    // Moved out by hand afterwards: rules do not move it back.
    manager.updateWork(fresh.id, { folderId: null });
    manager.createSession(fresh.id, { provider: "claude" });
    await tick();
    expect(manager.view.works.get(fresh.id)!.folderId).toBeNull();
    // The work from before the rules: only in the preview, then by "적용".
    expect(manager.view.works.get(old.id)!.folderId).toBeNull();
    const preview = pkm.previewRules();
    expect(preview.find((change) => change.workId === old.id)).toMatchObject({ ruleName: "디스크 위치대로", from: null, to: "projects", suggested: true });
    expect(pkm.applyRules([old.id])).toEqual({ applied: 1 });
    expect(folders.get(manager.view.works.get(old.id)!.folderId!)?.name).toBe("projects");
  });
});
