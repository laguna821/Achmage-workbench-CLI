import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEFAULT_STAGES, type ProjectSummary, type PropertyField, type Work } from "@workbench/contracts";
import { aheadPeriod, boardOf, byLabel, colorOf, dayOf, emojiColor, groupItems, hintOptions, idsOf, moveOf, nestGroups, pastPeriod, sortItems, type KeyDef } from "./groups.ts";
import { projectKeys, projectRows, projectSorts, propertyKeys, topicParticle, type ProjectRow } from "./components/views/keys.ts";
import { initialState, type State } from "./state.ts";

const day = (text: string) => dayOf(text)!;
const THURSDAY = day("2026-10-29");

describe("date periods", () => {
  it("ahead: 지남 · 오늘 · 내일 · 이번 주 · 다음 주 · 이번 달 · 다음 달 · 나중, weeks from Monday", () => {
    const at = (text: string, today = THURSDAY) => aheadPeriod(day(text), today);
    expect(["2026-10-01", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-08", "2026-11-09", "2026-11-30", "2026-12-01"].map((text) => at(text))).toEqual([
      "overdue",
      "overdue",
      "today",
      "tomorrow",
      "thisWeek",
      "thisWeek",
      "nextWeek",
      "nextWeek",
      "nextMonth",
      "nextMonth",
      "later",
    ]);
    // On a Sunday, tomorrow (a Monday) is "내일", not "다음 주"; the week after is "다음 주".
    const sunday = day("2026-11-01");
    expect([at("2026-11-02", sunday), at("2026-11-03", sunday), at("2026-11-08", sunday), at("2026-11-09", sunday), at("2026-11-20", sunday)]).toEqual(["tomorrow", "nextWeek", "nextWeek", "thisMonth", "thisMonth"]);
    // Early in a month: the rest of it is "이번 달"; across the year, January is "다음 달".
    expect(at("2026-10-25", day("2026-10-05"))).toBe("thisMonth");
    expect([at("2027-01-15", day("2026-12-20")), at("2027-02-01", day("2026-12-20"))]).toEqual(["nextMonth", "later"]);
  });

  it("behind: 오늘 · 어제 · 이번 주 · 지난 주 · 이번 달 · 더 이전 (a later day counts as today)", () => {
    const at = (text: string, today = THURSDAY) => pastPeriod(day(text), today);
    expect(["2026-10-30", "2026-10-29", "2026-10-28", "2026-10-26", "2026-10-25", "2026-10-19", "2026-10-18", "2026-10-01", "2026-09-30"].map((text) => at(text))).toEqual([
      "today",
      "today",
      "yesterday",
      "thisWeek",
      "lastWeek",
      "lastWeek",
      "thisMonth",
      "thisMonth",
      "earlier",
    ]);
    // On a Monday yesterday is "어제" (not last week); on the 1st, last week is before this month.
    expect([at("2026-10-25", day("2026-10-26")), at("2026-10-24", day("2026-10-26"))]).toEqual(["yesterday", "lastWeek"]);
    expect([at("2026-10-26", day("2026-11-01")), at("2026-10-20", day("2026-11-01")), at("2026-10-18", day("2026-11-01"))]).toEqual(["thisWeek", "lastWeek", "earlier"]);
  });

  it("read dates, dates with a time and times in ms; anything else is no date", () => {
    expect(dayOf("2026-10-29")).toEqual({ y: 2026, m: 10, d: 29 });
    expect(dayOf(" 2026-10-29T14:30")).toEqual({ y: 2026, m: 10, d: 29 });
    expect(dayOf("2026-10-29 14:30")).toEqual({ y: 2026, m: 10, d: 29 });
    expect(dayOf(new Date(2026, 9, 29, 23, 59).getTime())).toEqual({ y: 2026, m: 10, d: 29 });
    expect([dayOf("언젠가"), dayOf("2026-02-30"), dayOf(0), dayOf(Number.NaN)]).toEqual([null, null, null, null]);
  });

  // 03:30 UTC on 29 October is the evening before in New York and midday in Seoul; 02:00 UTC on
  // 26 October is a Sunday night in New York (last week) and a Monday in Seoul (this week).
  it("follow the local time zone", () => {
    const script = `
      const { idsOf, localDay } = await import(${JSON.stringify(new URL("./groups.ts", import.meta.url).href)});
      const today = localDay(Date.UTC(2026, 9, 29, 14, 0));
      const def = { key: "activity", label: "최근 활동", kind: "past", values: (at) => [at], fixed: null };
      const ahead = { key: "due", label: "마감", kind: "date", values: (at) => [at], fixed: null };
      console.log(JSON.stringify({
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        today,
        evening: idsOf(def, Date.UTC(2026, 9, 29, 3, 30), "period", today)[0],
        sunday: idsOf(def, Date.UTC(2026, 9, 26, 2, 0), "period", today)[0],
        week: idsOf(def, Date.UTC(2026, 9, 26, 2, 0), "week", today)[0],
        month: idsOf(def, Date.UTC(2026, 9, 1, 2, 0), "month", today)[0],
        due: idsOf(ahead, "2026-11-02", "period", today)[0],
      }));
    `;
    const run = (zone: string) => {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
      expect(child.stderr.replace(/\(node:\d+\) ExperimentalWarning.*\n?/g, "").replace(/\(Use `node --trace-warnings.*\n?/g, "")).toBe("");
      return JSON.parse(child.stdout);
    };
    expect(run("America/New_York")).toEqual({ zone: "America/New_York", today: { y: 2026, m: 10, d: 29 }, evening: "yesterday", sunday: "lastWeek", week: "2026-10-19", month: "2026-09", due: "nextWeek" });
    expect(run("Asia/Seoul")).toEqual({ zone: "Asia/Seoul", today: { y: 2026, m: 10, d: 29 }, evening: "today", sunday: "thisWeek", week: "2026-10-26", month: "2026-10", due: "nextWeek" });
  });
});

type Item = { name: string; stage?: string; tags?: string[]; due?: string; n?: string; done?: string; dikm?: string };
const key = (patch: Partial<KeyDef<Item>> & Pick<KeyDef<Item>, "key" | "kind" | "values">): KeyDef<Item> => ({ label: patch.key, fixed: null, ...patch });
const names = (items: Item[]) => items.map((item) => item.name);
const ITEMS: Item[] = [
  { name: "가", stage: "진행중", tags: ["강의", "연구"], due: "2026-10-28", n: "10", done: "true", dikm: "🔵 I" },
  { name: "나", stage: "완료", tags: ["강의"], due: "2026-10-29T09:00", n: "9", done: "false", dikm: "🟢 D" },
  { name: "다", stage: "옛 단계", tags: [], due: "2026-11-30", dikm: "⬜ 보류" },
  { name: "라", tags: ["강의", "강의"], n: "", dikm: "🟠 M" },
  { name: "마", stage: "진행중", due: "언젠가", dikm: "🟣 K" },
];
const STAGE = key({ key: "stage", kind: "choice", values: (item) => (item.stage ? [item.stage] : []), known: DEFAULT_STAGES.map((stage) => ({ id: stage.name, label: stage.name, color: stage.color })) });

describe("groups", () => {
  it("keep a key's known values in order (empty ones too), others after, 값 없음 last", () => {
    const groups = groupItems(ITEMS, STAGE, null, THURSDAY);
    expect(groups.map((group) => [group.id, group.label, names(group.items)])).toEqual([
      ["할일", "할일", []],
      ["진행중", "진행중", ["가", "마"]],
      ["완료", "완료", ["나"]],
      ["보류", "보류", []],
      ["아카이브", "아카이브", []],
      ["옛 단계", "옛 단계", ["다"]],
      ["", "값 없음", ["라"]],
    ]);
    expect(groups[1]!.color).toBe("#3e63dd");
    expect(groupItems(ITEMS, STAGE, { hideEmpty: true }, THURSDAY).map((group) => group.id)).toEqual(["진행중", "완료", "옛 단계", ""]);
    expect(groupItems(ITEMS, STAGE, { reverse: true, hideEmpty: true }, THURSDAY).map((group) => group.id)).toEqual(["옛 단계", "완료", "진행중", ""]);
  });

  it("put an item with several values in each of its groups (Notion's multi-select), once each", () => {
    const tags = key({ key: "tags", kind: "list", values: (item) => item.tags ?? [], show: (tag) => `#${tag}` });
    expect(groupItems(ITEMS, tags, null, THURSDAY).map((group) => [group.label, names(group.items)])).toEqual([
      ["#강의", ["가", "나", "라"]],
      ["#연구", ["가"]],
      ["값 없음", ["다", "마"]],
    ]);
    expect(idsOf(tags, ITEMS[3]!, "period", THURSDAY)).toEqual(["강의"]);
  });

  it("group dates by period (지남 first, 값 없음 last), month or week; a date it cannot read has none", () => {
    const due = key({ key: "due", kind: "date", values: (item) => (item.due ? [item.due] : []) });
    const periods = groupItems(ITEMS, due, { hideEmpty: true }, THURSDAY);
    expect(periods.map((group) => [group.label, names(group.items)])).toEqual([
      ["지남", ["가"]],
      ["오늘", ["나"]],
      ["다음 달", ["다"]],
      ["값 없음", ["라", "마"]],
    ]);
    expect(groupItems(ITEMS, due, null, THURSDAY).map((group) => group.label)).toEqual(["지남", "오늘", "내일", "이번 주", "다음 주", "이번 달", "다음 달", "나중", "값 없음"]);
    expect(groupItems(ITEMS, due, { dates: "month" }, THURSDAY).map((group) => [group.id, group.label])).toEqual([
      ["2026-10", "10월"],
      ["2026-11", "11월"],
      ["", "값 없음"],
    ]);
    expect(groupItems(ITEMS, due, { dates: "week" }, day("2027-01-05")).map((group) => [group.id, group.label])).toEqual([
      ["2026-10-26", "2026년 10월 26일 주"],
      ["2026-11-30", "2026년 11월 30일 주"],
      ["", "값 없음"],
    ]);
  });

  it("go back in time for activity: 오늘 first, and months and weeks newest first", () => {
    const at = (text: string) => new Date(`${text}T12:00:00`).getTime();
    const items = [{ name: "a", when: at("2026-10-29") }, { name: "b", when: at("2026-09-02") }, { name: "c", when: at("2026-10-27") }];
    const activity: KeyDef<{ name: string; when: number }> = { key: "activity", label: "최근 활동", kind: "past", values: (item) => [item.when], fixed: "x" };
    expect(groupItems(items, activity, { hideEmpty: true }, THURSDAY).map((group) => [group.label, group.items.map((item) => item.name)])).toEqual([
      ["오늘", ["a"]],
      ["이번 주", ["c"]],
      ["더 이전", ["b"]],
    ]);
    expect(groupItems(items, activity, { dates: "month" }, THURSDAY).map((group) => group.label)).toEqual(["10월", "9월"]);
  });

  it("read the colour of a leading emoji, so the vault's DIKM values colour and order themselves", () => {
    expect(["🟢 D", "🔵 I", "🟣 K", "🟠 M", "🔴 위험", "🟡 주의", "⬜ 보류", "⚪ 기타", "D", ""].map(emojiColor)).toEqual(["#30a46c", "#3e63dd", "#8e4ec6", "#f76b15", "#e5484d", "#e2a400", "#8b8d98", "#8b8d98", null, null]);
    const dikm = key({ key: "prop:DIKM_단계:", kind: "list", values: (item) => (item.dikm ? [item.dikm] : []) });
    const groups = groupItems(ITEMS, dikm, null, THURSDAY);
    expect(groups.map((group) => [group.label, group.color])).toEqual([
      ["🟢 D", "#30a46c"],
      ["🔵 I", "#3e63dd"],
      ["🟣 K", "#8e4ec6"],
      ["🟠 M", "#f76b15"],
      ["⬜ 보류", "#8b8d98"],
    ]);
    expect(["기타", "🟠 M", "가나", "🟢 D"].sort(byLabel)).toEqual(["🟢 D", "🟠 M", "가나", "기타"]);
    // The person's pick wins over the emoji's.
    expect(colorOf({ colors: { "prop:DIKM_단계:=🟢 D": "#000000" }, border: true, tint: 10, heading: true }, "prop:DIKM_단계:", groups[0]!)).toBe("#000000");
    expect(colorOf({ colors: {}, border: true, tint: 10, heading: true }, "prop:DIKM_단계:", groups[1]!)).toBe("#3e63dd");
  });

  it("order numbers by size and checkboxes as 예 · 아니오; a template hint lists a text key's options", () => {
    const n = key({ key: "n", kind: "number", values: (item) => (item.n ? [item.n] : []) });
    expect(groupItems(ITEMS, n, null, THURSDAY).map((group) => group.label)).toEqual(["9", "10", "값 없음"]);
    const done = key({ key: "done", kind: "checkbox", values: (item) => (item.done ? [item.done] : []) });
    expect(groupItems(ITEMS, done, null, THURSDAY).map((group) => [group.label, names(group.items)])).toEqual([
      ["예", ["가"]],
      ["아니오", ["나"]],
      ["값 없음", ["다", "라", "마"]],
    ]);
    expect(hintOptions("높음 · 보통 · 낮음")).toEqual(["높음", "보통", "낮음"]);
    expect(hintOptions("예: 강의, 연구, 개발, 행정, 글쓰기")).toEqual(["강의", "연구", "개발", "행정", "글쓰기"]);
    expect([hintOptions("이 프로젝트로 얻으려는 것 한 줄"), hintOptions(undefined), hintOptions("예: 2026-2")]).toEqual([[], [], []]);
  });

  it("nest groups (only inner groups that hold something) and lay a board out in columns × rows", () => {
    const tags = key({ key: "tags", kind: "list", values: (item) => item.tags ?? [] });
    const nested = nestGroups(groupItems(ITEMS, STAGE, { hideEmpty: true }, THURSDAY), tags, { key: "tags" }, THURSDAY);
    expect(nested[0]!.sub!.map((group) => [group.label, names(group.items)])).toEqual([
      ["강의", ["가"]],
      ["연구", ["가"]],
      ["값 없음", ["마"]],
    ]);
    const board = boardOf(ITEMS, STAGE, null, tags, { key: "tags" }, THURSDAY);
    expect(board.lanes!.map((lane) => lane.label)).toEqual(["강의", "연구", "값 없음"]);
    expect(names(board.cell("진행중", "강의"))).toEqual(["가"]);
    expect(names(board.cell("진행중", ""))).toEqual(["마"]);
    expect(names(board.cell("", "강의"))).toEqual(["라"]);
    expect(names(boardOf(ITEMS, STAGE, null, null, null, THURSDAY).cell("진행중", null))).toEqual(["가", "마"]);
  });

  it("sort by a name, a number or a date, empty values last both ways, ties by name", () => {
    const due = { key: "due", label: "마감", value: (item: Item) => item.due ?? null };
    expect(names(sortItems(ITEMS, due, "asc", (item) => item.name))).toEqual(["가", "나", "다", "마", "라"]);
    expect(names(sortItems(ITEMS, due, "desc", (item) => item.name))).toEqual(["마", "다", "나", "가", "라"]);
    const size = { key: "n", label: "n", value: (item: Item) => (item.n ? Number(item.n) : null) };
    expect(names(sortItems(ITEMS, size, "asc", (item) => item.name))).toEqual(["나", "가", "다", "라", "마"]);
    expect(names(sortItems(ITEMS, null, "asc", (item) => item.name))).toEqual(names(ITEMS));
  });

  it("say what a drag writes, or why it cannot", () => {
    expect(moveOf(STAGE, ITEMS[0]!, "완료")).toEqual({ ok: true, value: "완료" });
    expect(moveOf(STAGE, ITEMS[0]!, "")).toEqual({ ok: true, value: null });
    const kinds = key({ key: "prop:종류", label: "종류", kind: "list", values: (item) => item.tags ?? [] });
    expect(moveOf(kinds, ITEMS[1]!, "연구")).toEqual({ ok: true, value: "연구" });
    expect(moveOf(kinds, ITEMS[0]!, "연구")).toMatchObject({ ok: false, reason: expect.stringContaining("값이 여럿") });
    expect(moveOf(key({ key: "due", kind: "date", values: () => [], fixed: "날짜는 끌 수 없습니다." }), ITEMS[0]!, "today")).toEqual({ ok: false, reason: "날짜는 끌 수 없습니다." });
  });
});

describe("project keys", () => {
  const work = (id: string, patch: Partial<Work> = {}): Work => ({ id, title: id, titleSource: "user", folderId: null, cwd: `/tmp/${id}`, cwdManaged: false, activeSessionId: null, pinned: false, sort: 0, archivedAt: null, createdAt: 1, updatedAt: 2, ...patch });
  const summary = (workId: string, properties: ProjectSummary["properties"], stage: string | null = null): ProjectSummary => ({ workId, stage, tags: [], related: [], decisions: 0, questions: 0, noteExists: true, properties, noteUpdatedAt: 1, preview: null });
  const template: PropertyField[] = [
    { key: "단계", type: "stage" },
    { key: "tags", type: "tags" },
    { key: "마감일", type: "date" },
    { key: "중요도", type: "text", hint: "높음 · 보통 · 낮음" },
  ];
  const state: State = {
    ...initialState,
    folders: { f1: { id: "f1", name: "강의", parentId: null, sort: 0, archivedAt: null }, f2: { id: "f2", name: "2026-2", parentId: "f1", sort: 0, archivedAt: null }, f3: { id: "f3", name: "보관한", parentId: null, sort: 1, archivedAt: 5 } },
    works: { a: work("a", { folderId: "f2" }), b: work("b", { folderId: "f3" }), c: work("c", { archivedAt: 9 }) },
  };
  const summaries = new Map([
    ["a", summary("a", [{ key: "DIKM_단계:", type: "list", values: ["🟢 D"] }, { key: "중요도", type: "text", values: ["보통"] }, { key: "관련", type: "links", values: ["[[가을 특강]]"] }])],
    ["b", summary("b", [{ key: "중요도", type: "text", values: ["높음"] }], "진행중")],
  ]);
  const rows = projectRows(state, summaries);
  const keys = projectKeys({ state, summaries, stages: DEFAULT_STAGES, template, engineColor: () => "#000000" });
  const byKey = (name: string) => keys.find((entry) => entry.key === name)!;
  const row = (id: string) => rows.find((entry) => entry.work.id === id)!;

  it("offer the stage, folders, tags, the template's and the notes' properties, activity, created and engine", () => {
    expect(keys.map((entry) => entry.key)).toEqual(["stage", "folder", "tags", "prop:마감일", "prop:중요도", "prop:DIKM_단계:", "prop:관련", "activity", "created", "engine"]);
    expect(byKey("prop:DIKM_단계:").label).toBe("DIKM_단계");
    expect(propertyKeys(summaries.values(), template).find((entry) => entry.key === "중요도")).toEqual({ key: "중요도", type: "text", label: "중요도", hint: "높음 · 보통 · 낮음" });
    // A vault key with its colon reads without it, unless the same name without one is there too.
    const both = propertyKeys([summary("x", [{ key: "종류:", type: "list", values: ["강의"] }, { key: "DIKM_단계:", type: "list", values: ["🟢 D"] }])], [{ key: "종류", type: "list" }]);
    expect(both.map((entry) => [entry.key, entry.label])).toEqual([
      ["종류", "종류"],
      ["종류:", "종류:"],
      ["DIKM_단계:", "DIKM_단계"],
    ]);
  });

  it("group folders in the tree's order by path (hidden ones as outside), the archive stage for archived works, options from the hint", () => {
    expect(groupItems(rows, byKey("folder"), null, THURSDAY).map((group) => [group.label, group.depth, group.items.map((entry) => entry.work.id)])).toEqual([
      ["강의", 0, []],
      ["강의 / 2026-2", 1, ["a"]],
      ["폴더 밖", 0, ["b", "c"]],
    ]);
    expect(idsOf(byKey("stage"), row("c"), "period", THURSDAY)).toEqual(["아카이브"]);
    expect(groupItems(rows, byKey("prop:중요도"), null, THURSDAY).map((group) => [group.label, group.items.map((entry) => entry.work.id)])).toEqual([
      ["높음", ["b"]],
      ["보통", ["a"]],
      ["낮음", []],
      ["값 없음", ["c"]],
    ]);
    expect(groupItems(rows, byKey("prop:관련"), { hideEmpty: true }, THURSDAY).map((group) => group.label)).toEqual(["가을 특강", "값 없음"]);
  });

  it("let a drag write the stage, the folder or a one-value text, and refuse dates, tags, links and the engine", () => {
    expect(moveOf(byKey("stage"), row("a"), "완료")).toEqual({ ok: true, value: "완료" });
    expect(moveOf(byKey("folder"), row("a"), "")).toEqual({ ok: true, value: null });
    expect(moveOf(byKey("prop:중요도"), row("a"), "높음")).toEqual({ ok: true, value: "높음" });
    for (const name of ["prop:마감일", "tags", "prop:관련", "engine", "activity", "created"]) expect(moveOf(byKey(name), row("a"), "x")).toMatchObject({ ok: false });
    expect((moveOf(byKey("prop:마감일"), row("a"), "today") as { reason: string }).reason).toBe("'마감일'은 기간으로 묶여 있어 끌어서 정할 수 없습니다. 날짜는 프로젝트 속성에서 고칩니다.");
    expect([topicParticle("마감일"), topicParticle("시작 날짜"), topicParticle("due")]).toEqual(["은", "는", "은(는)"]);
  });

  it("sort by a property, in its kind (a hint's options in their order, not by name)", () => {
    const sorts = projectSorts({ stages: DEFAULT_STAGES, summaries, template });
    const importance = sorts.find((entry) => entry.key === "prop:중요도")!;
    const low = projectRows({ ...state, works: { ...state.works, d: work("d") } }, new Map([...summaries, ["d", summary("d", [{ key: "중요도", type: "text", values: ["낮음"] }])]]));
    expect(sortItems(low, importance, "asc", (entry: ProjectRow) => entry.work.title).map((entry) => entry.work.id)).toEqual(["b", "a", "d", "c"]);
    expect(sortItems(low, importance, "desc", (entry: ProjectRow) => entry.work.title).map((entry) => entry.work.id)).toEqual(["d", "a", "b", "c"]);
  });
});
