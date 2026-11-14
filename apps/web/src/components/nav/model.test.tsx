import { describe, expect, it } from "vitest";
import type { Folder, NavSort, ProjectStage, ProjectSummary, Session, Work } from "@workbench/contracts";
import { initialState, type State } from "../../state.ts";
import { sidebarDocks } from "../right/RightSidebar.tsx";
import {
  addShortcuts,
  countText,
  dateGroup,
  dueGroup,
  folderCounts,
  layoutChoices,
  layoutFor,
  listFor,
  moveShortcut,
  projectsOf,
  readNavigator,
  readShortcuts,
  seedShortcuts,
  shortDate,
  sidebarWidthFor,
  sortFor,
  tagTree,
  type ListEntry,
  type ListOptions,
} from "./model.ts";

// Wednesday 2026-10-28 15:00 local time: Monday is the 26th, last week began on the 19th.
const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).getTime();

const folder = (id: string, parentId: string | null, sort: number, extra: Partial<Folder> = {}): Folder => ({ id, parentId, name: id, sort, archivedAt: null, ...extra });
const work = (id: string, folderId: string | null, updatedAt: number, extra: Partial<Work> = {}): Work => ({
  id,
  title: id,
  titleSource: "user",
  folderId,
  cwd: `/w/${id}`,
  cwdManaged: true,
  activeSessionId: null,
  pinned: false,
  sort: 0,
  archivedAt: null,
  createdAt: updatedAt - 1000,
  updatedAt,
  ...extra,
});
const session = (id: string, workId: string, extra: Partial<Session> = {}) =>
  ({ id, workId, provider: "claude", purpose: id, status: "idle", pinned: false, sort: 0, archivedAt: null, seenAt: null, unread: false, previewAt: null, preview: null, createdAt: 0, updatedAt: 0, queued: [], ...extra }) as unknown as Session;
const summary = (workId: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({ workId, stage: null, tags: [], related: [], decisions: 0, questions: 0, noteExists: true, properties: [], noteUpdatedAt: null, preview: null, ...extra });

function stateOf(folders: Folder[], works: Work[], sessions: Session[] = []): State {
  const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
  return { ...initialState, ready: true, folders: byId(folders), works: byId(works), sessions: byId(sessions) };
}

const STAGES: ProjectStage[] = [
  { name: "할일", color: "#e5484d" },
  { name: "진행중", color: "#3e63dd" },
  { name: "완료", color: "#30a46c" },
];

const folders = [folder("강의", null, 0), folder("2026-2", "강의", 0), folder("연구", null, 1), folder("보관됨", null, 2, { archivedAt: 1 })];
const works = [
  work("특강", "강의", at(10, 28, 9), { pinned: true }),
  work("7주차", "2026-2", at(10, 27)),
  work("8주차", "2026-2", at(10, 21)),
  work("논문", "연구", at(10, 2)),
  work("메모", null, at(9, 1)),
  work("숨은", "보관됨", at(10, 28)),
  work("지난", null, at(10, 28), { archivedAt: 5 }),
];
const summaries = new Map<string, ProjectSummary>([
  ["특강", summary("특강", { stage: "진행중", tags: ["강의/2026-2", "글쓰기"], preview: "루브릭을 특강에 맞게" })],
  ["7주차", summary("7주차", { stage: "할일", tags: ["강의"], properties: [{ key: "마감일", type: "date", values: ["2026-10-30"] }] })],
  ["8주차", summary("8주차", { stage: "완료", properties: [{ key: "마감일", type: "date", values: ["2026-10-20"] }] })],
  ["논문", summary("논문", { tags: ["연구/인용"], properties: [{ key: "마감일", type: "date", values: ["2026-11-20"] }] })],
]);
const state = stateOf(folders, works, [
  session("s1", "메모", { preview: "초안 목차입니다", previewAt: at(9, 1) }),
  // A newer session that has not answered yet does not hide the reply above.
  session("s0", "메모", { updatedAt: at(9, 2) }),
  session("s2", "7주차", { status: "awaitingApproval" }),
]);
const projects = projectsOf(state, summaries);
const options = (patch: Partial<ListOptions> = {}): ListOptions => ({ includeSub: false, query: "", sort: { key: "activity", desc: true }, groupSub: "date", stages: STAGES, folders: state.folders, now: NOW, ...patch });
/** The list as text: group heads in brackets, rows with their folder label. */
const lines = (entries: ListEntry[]) => entries.map((entry) => (entry.type === "group" ? `[${entry.label}]` : `${entry.project.work.id}${entry.folder ? ` (${entry.folder})` : ""}`));

describe("navigator preferences", () => {
  it("fill the defaults and keep only what makes sense", () => {
    const prefs = readNavigator({ layout: "sideways", navWidth: 9999, listWidth: "wide", previewLines: 7, sortByFolder: { 강의: { key: "name", desc: false }, bad: { key: "size" } }, sections: { tags: true, vault: true } });
    expect(prefs).toMatchObject({ layout: null, navWidth: 360, listWidth: 300, previewLines: 1, includeSub: true, density: "standard", groupSub: "date", selected: { kind: "root" } });
    expect(prefs.sortByFolder).toEqual({ 강의: { key: "name", desc: false } });
    expect(prefs.sections).toEqual({ tags: true });
    expect(sortFor(prefs, { kind: "folder", id: "강의" })).toEqual({ key: "name", desc: false });
    expect(sortFor(prefs, { kind: "root" })).toEqual({ key: "activity", desc: true });
  });

  // 0.3.3's rule, measured against today's panes: two panes wherever two work panes (360 + 8 + 360)
  // would still fit beside the navigator (216 + 1 + 300) and the frame's 8px.
  it("choose two panes on a wide window and stacked on a narrow one, unless the person chose", () => {
    const auto = readNavigator(undefined);
    for (const width of [1280, 1440, 1920, 2560]) expect(layoutFor(auto, width)).toBe("dual");
    for (const width of [390, 744, 1000, 1200]) expect(layoutFor(auto, width)).toBe("stacked");
    // The edge: 517 + 8 + 728.
    expect(layoutFor(auto, 1253)).toBe("dual");
    expect(layoutFor(auto, 1252)).toBe("stacked");
    // Only a width is stored (the list was dragged once): still the automatic choice.
    expect(layoutFor(readNavigator({ listWidth: 320 }), 1440)).toBe("dual");
  });

  // The window's edge dragged across the threshold must not swap a 288px sidebar for a 517px one
  // and back on every pixel: two panes hold on for 24px below it; stacked needs the threshold itself.
  describe("the automatic choice at its edge (1253px with the default widths)", () => {
    const auto = readNavigator(undefined);
    it.each([
      // window, what was drawn before, what is drawn now
      [1253, null, "dual"],
      [1252, null, "stacked"],
      [1253, "stacked", "dual"],
      [1252, "stacked", "stacked"],
      [1240, "stacked", "stacked"],
      [1252, "dual", "dual"],
      [1240, "dual", "dual"],
      [1229, "dual", "dual"],
      [1228, "dual", "stacked"],
      [1100, "dual", "stacked"],
      [1300, "tree", "dual"],
      [1252, "tree", "stacked"],
    ] as const)("%ipx, drawn %s before → %s", (width, was, now) => {
      expect(layoutFor(auto, width, 360, was)).toBe(now);
    });

    /** The layouts drawn while the window's width goes from one value to another, a pixel at a time. */
    const drag = (from: number, to: number, start: ReturnType<typeof layoutFor> | null = null) => {
      const seen: string[] = [];
      let was = start;
      for (let width = from; width !== to + Math.sign(to - from); width += Math.sign(to - from)) {
        was = layoutFor(auto, width, 360, was);
        if (seen.at(-1)?.split("@")[0] !== was) seen.push(`${was}@${width}`);
      }
      return seen;
    };

    it("flips once on the way down and once on the way up, 24px apart", () => {
      expect(drag(1300, 1200)).toEqual(["dual@1300", "stacked@1228"]);
      expect(drag(1200, 1300)).toEqual(["stacked@1200", "dual@1253"]);
    });

    it("does not flip while the edge is jiggled across the threshold", () => {
      expect(drag(1252, 1253, "dual")).toEqual(["dual@1252"]);
      expect(drag(1253, 1230, "dual")).toEqual(["dual@1253"]);
      expect(drag(1230, 1252, "stacked")).toEqual(["stacked@1230"]);
    });

    it("never holds two panes below the work panes' least width, nor a stored choice by what was drawn", () => {
      // Three work panes need 1096px: the edge is 517 + 8 + 1096 = 1621, with no slack below it.
      expect(layoutFor(auto, 1621, 1096, "dual")).toBe("dual");
      expect(layoutFor(auto, 1620, 1096, "dual")).toBe("stacked");
      // Chosen two panes give way exactly where a pane would lose its 360px; chosen stacked and tree never move.
      expect(layoutFor(readNavigator({ layout: "dual" }), 517 + 8 + 360, 360, "stacked")).toBe("stacked");
      expect(layoutFor(readNavigator({ layout: "dual" }), 901, 360, "stacked")).toBe("dual");
      expect(layoutFor(readNavigator({ layout: "stacked" }), 1440, 360, "dual")).toBe("stacked");
      expect(layoutFor(readNavigator({ layout: "tree" }), 1440, 360, "dual")).toBe("tree");
      // Where the sidebar lies over the work, never two panes, whatever was drawn.
      expect(layoutFor(readNavigator({ navWidth: 168, listWidth: 240 }), 900, 360, "dual")).toBe("stacked");
    });
  });

  it("respect a stored layout at every width", () => {
    for (const width of [744, 1000, 1440, 2560]) {
      expect(layoutFor(readNavigator({ layout: "tree" }), width)).toBe("tree");
      expect(layoutFor(readNavigator({ layout: "stacked" }), width)).toBe("stacked");
    }
    expect(layoutFor(readNavigator({ layout: "dual" }), 1440)).toBe("dual");
    // Chosen two panes stay on a window the automatic choice would stack, while a pane keeps 360px…
    expect(layoutFor(readNavigator({ layout: "dual" }), 1000)).toBe("dual");
    // …and are drawn stacked where it could not (the choice itself is kept).
    expect(layoutFor(readNavigator({ layout: "dual" }), 884)).toBe("stacked");
  });

  it("count the navigator's own width and the pane layout's least width", () => {
    const auto = readNavigator(undefined);
    // Three work panes side by side need 1096px: not beside two navigator panes on a 1440px window.
    expect(layoutFor(auto, 1440, 1096)).toBe("stacked");
    expect(layoutFor(auto, 1920, 1096)).toBe("dual");
    expect(layoutFor(readNavigator({ layout: "dual" }), 1440, 1096)).toBe("stacked");
    // Both navigator panes dragged to their widest (360 + 520): a 1440px window no longer has the room.
    const wide = readNavigator({ navWidth: 360, listWidth: 520 });
    expect(layoutFor(wide, 1440)).toBe("stacked");
    expect(layoutFor(wide, 1920)).toBe("dual");
  });

  it("never use two panes where the sidebar lies over the work (a window of 900px or less)", () => {
    expect(layoutFor(readNavigator({ layout: "dual", navWidth: 168, listWidth: 240 }), 900)).toBe("stacked");
    expect(layoutFor(readNavigator({ layout: "dual", navWidth: 168, listWidth: 240 }), 901)).toBe("dual");
  });

  it("give the sidebar the width of its layout", () => {
    const prefs = readNavigator({ navWidth: 256, listWidth: 320 });
    expect(sidebarWidthFor("dual", prefs, 288)).toBe(577);
    expect(sidebarWidthFor("stacked", prefs, 288)).toBe(288);
    expect(sidebarWidthFor("tree", prefs, 300)).toBe(300);
  });

  it("offer the layouts by their plain names, the stored one checked", () => {
    const names = (stored: Parameters<typeof layoutChoices>[0], drawn: Parameters<typeof layoutChoices>[1]) => layoutChoices(stored, drawn).map((choice) => `${choice.checked ? "●" : "○"} ${choice.label}${choice.hint ? ` (${choice.hint})` : ""}`);
    expect(names(null, "dual")).toEqual(["○ 두 칸", "○ 위아래", "○ 한 칸 (트리)", "● 창 너비에 맞추기 (지금 두 칸)"]);
    expect(names(null, "stacked")).toEqual(["○ 두 칸", "○ 위아래", "○ 한 칸 (트리)", "● 창 너비에 맞추기 (지금 위아래)"]);
    expect(names("tree", "tree")).toEqual(["○ 두 칸", "○ 위아래", "● 한 칸 (트리)", "○ 창 너비에 맞추기"]);
    // Chosen two panes on a window too narrow for them: the choice stands, and says how it is drawn.
    expect(names("dual", "stacked")).toEqual(["● 두 칸 (지금은 위아래)", "○ 위아래", "○ 한 칸 (트리)", "○ 창 너비에 맞추기"]);
    expect(layoutChoices(null, "dual").map((choice) => choice.label).join()).not.toContain("고급");
  });
});

// The left navigator, the work panes and the right sidebar (RightSidebar.tsx) in one window: at
// every width each pane keeps its least width — the navigator stacks or the right sidebar lies
// over the work; nothing is squeezed.
describe("with the right sidebar open", () => {
  const RIGHT = 280;
  const GAP = 8;
  const least = (panes: number) => panes * 360 + (panes - 1) * 8;
  /** The window as App lays it out: navigator | panes | right sidebar (docked or over). */
  const frame = (windowWidth: number, panes: number, prefs = readNavigator(undefined), single = 288, was: ReturnType<typeof layoutFor> | null = null) => {
    const layout = layoutFor(prefs, windowWidth, least(panes), was);
    const area = windowWidth - sidebarWidthFor(layout, prefs, single) - GAP;
    const docked = sidebarDocks(area, least(panes), RIGHT, true);
    return { layout, docked, panes: area - (docked ? RIGHT + GAP : 0) };
  };

  it("keeps every pane's least width at every window width", () => {
    for (const panes of [1, 2, 3]) {
      for (const prefs of [readNavigator(undefined), readNavigator({ layout: "dual" }), readNavigator({ navWidth: 360, listWidth: 520 }), readNavigator({ layout: "stacked" }), readNavigator({ layout: "tree" })]) {
        // From the narrowest window where the panes fit beside a one-column sidebar at all.
        for (let width = Math.max(901, 288 + GAP + least(panes)); width <= 2600; width += 7) {
          // Also when two panes were drawn a moment ago (they hold on a little below the threshold).
          for (const was of [null, "dual"] as const) {
            const now = frame(width, panes, prefs, 288, was);
            expect(now.panes, `${width}px · ${panes} pane(s) · ${prefs.layout ?? "auto"} · was ${was} → ${now.layout}${now.docked ? " + docked" : ""}`).toBeGreaterThanOrEqual(least(panes));
          }
        }
      }
    }
  });

  it("1920px: two navigator panes, the work and the docked right sidebar all fit", () => {
    expect(frame(1920, 1)).toMatchObject({ layout: "dual", docked: true });
    expect(frame(1920, 2)).toMatchObject({ layout: "dual", docked: true });
  });

  it("1440px with two work panes: the navigator stays in two panes and the right sidebar lies over", () => {
    expect(frame(1440, 2)).toMatchObject({ layout: "dual", docked: false });
    expect(frame(1440, 1)).toMatchObject({ layout: "dual", docked: true });
  });

  it("about 1000px: the navigator is stacked, and the right sidebar still docks beside one pane", () => {
    expect(frame(1000, 1)).toMatchObject({ layout: "stacked", docked: true });
  });
});

describe("the projects a selection lists", () => {
  it("reads each project once: archived ones and those under archived folders stay out", () => {
    expect(projects.map((project) => project.work.id).sort()).toEqual(["7주차", "8주차", "논문", "메모", "특강"].sort());
    const memo = projects.find((project) => project.work.id === "메모")!;
    expect(memo.preview).toBe("초안 목차입니다");
    expect(projects.find((project) => project.work.id === "7주차")).toMatchObject({ attention: true, stage: "할일", due: new Date(2026, 9, 30).getTime() });
  });

  it("lists the root's own projects, or every project with 하위 포함 (pinned first, then date groups)", () => {
    expect(lines(listFor(projects, { kind: "root" }, options()).entries)).toEqual(["[더 이전]", "메모"]);
    expect(lines(listFor(projects, { kind: "root" }, options({ includeSub: true })).entries)).toEqual([
      "[고정]",
      "특강 (강의)",
      "[어제]",
      "7주차 (강의/2026-2)",
      "[지난 주]",
      "8주차 (강의/2026-2)",
      "[이번 달]",
      "논문 (연구)",
      "[더 이전]",
      "메모",
    ]);
  });

  it("lists a folder's own projects, or those below it too, naming folders relative to it", () => {
    expect(lines(listFor(projects, { kind: "folder", id: "강의" }, options()).entries)).toEqual(["[고정]", "특강"]);
    expect(lines(listFor(projects, { kind: "folder", id: "강의" }, options({ includeSub: true, sort: { key: "name", desc: false } })).entries)).toEqual(["[고정]", "특강", "[프로젝트]", "7주차 (2026-2)", "8주차 (2026-2)"]);
    // Without pins a name sort has no heads at all.
    expect(lines(listFor(projects, { kind: "folder", id: "2026-2" }, options({ sort: { key: "name", desc: true } })).entries)).toEqual(["8주차", "7주차"]);
  });

  it("groups by folder in tree order when asked (with 하위 포함)", () => {
    const listed = listFor(projects, { kind: "root" }, options({ includeSub: true, groupSub: "folder" }));
    expect(lines(listed.entries)).toEqual(["[고정]", "특강 (강의)", "[폴더 밖]", "메모", "[2026-2]", "7주차", "8주차", "[연구]", "논문"].map((line) => (line === "[2026-2]" ? "[강의/2026-2]" : line)));
    expect(listed.count).toBe(5);
    const inLecture = listFor(projects, { kind: "folder", id: "강의" }, options({ includeSub: true, groupSub: "folder" }));
    expect(lines(inLecture.entries)).toEqual(["[고정]", "특강", "[2026-2]", "7주차", "8주차"]);
  });

  it("lists a tag with the tags under it, and 태그 없음; the filter box narrows any list", () => {
    expect(lines(listFor(projects, { kind: "tag", tag: "강의" }, options()).entries)).toEqual(["[고정]", "특강 (강의)", "[어제]", "7주차 (강의/2026-2)"]);
    expect(lines(listFor(projects, { kind: "untagged" }, options()).entries)).toEqual(["[지난 주]", "8주차 (강의/2026-2)", "[더 이전]", "메모"]);
    expect(lines(listFor(projects, { kind: "root" }, options({ includeSub: true, query: "단계:할일" })).entries)).toEqual(["[어제]", "7주차 (강의/2026-2)"]);
    expect(listFor(projects, { kind: "root" }, options({ includeSub: true, query: "-#강의 주차" })).count).toBe(1);
  });

  it("sorts by stage (in the stages' order, none last) and by deadline with its own groups", () => {
    const byStage = listFor(projects, { kind: "root" }, options({ includeSub: true, sort: { key: "stage", desc: false } }));
    expect(lines(byStage.entries)).toEqual(["[고정]", "특강 (강의)", "[할일]", "7주차 (강의/2026-2)", "[완료]", "8주차 (강의/2026-2)", "[단계 없음]", "논문 (연구)", "메모"]);
    const reversed = listFor(projects, { kind: "root" }, options({ includeSub: true, sort: { key: "stage", desc: true } }));
    expect(lines(reversed.entries).slice(2)).toEqual(["[완료]", "8주차 (강의/2026-2)", "[할일]", "7주차 (강의/2026-2)", "[단계 없음]", "논문 (연구)", "메모"]);
    const byDue = listFor(projects, { kind: "root" }, options({ includeSub: true, sort: { key: "due", desc: false } }));
    expect(lines(byDue.entries).slice(2)).toEqual(["[지남]", "8주차 (강의/2026-2)", "[이번 주]", "7주차 (강의/2026-2)", "[나중]", "논문 (연구)", "[마감일 없음]", "메모"]);
  });
});

describe("dates as groups", () => {
  it("start the week on Monday and keep today and yesterday apart", () => {
    const group = (time: number) => dateGroup(time, NOW).label;
    expect([at(10, 28, 1), at(10, 27, 23), at(10, 26, 1), at(10, 25), at(10, 19, 0), at(10, 18), at(10, 1), at(9, 30)].map(group)).toEqual(["오늘", "어제", "이번 주", "지난 주", "지난 주", "이번 달", "이번 달", "더 이전"]);
    const due = (month: number, day: number) => dueGroup(new Date(2026, month - 1, day).getTime(), NOW).label;
    expect([due(10, 27), due(10, 28), due(11, 1), due(11, 2), due(11, 8), due(11, 9), due(11, 30)]).toEqual(["지남", "오늘", "이번 주", "다음 주", "다음 주", "나중", "나중"]);
    expect(dueGroup(new Date(2026, 9, 31).getTime(), new Date(2026, 9, 7, 9).getTime()).label).toBe("이번 달");
    expect(shortDate(at(10, 28, 9), NOW)).toBe("09:00");
    expect(shortDate(at(10, 27), NOW)).toBe("어제");
    expect(shortDate(at(3, 2), NOW)).toBe("3월 2일");
    expect(shortDate(new Date(2025, 2, 2).getTime(), NOW)).toBe("2025. 3. 2.");
  });
});

describe("folder counts and the tag tree", () => {
  it("count this folder · below, and the root as outside folders · in folders", () => {
    const counts = folderCounts(projects, state.folders);
    expect(counts.folders.get("강의")).toEqual({ own: 1, below: 2 });
    expect(counts.folders.get("2026-2")).toEqual({ own: 2, below: 0 });
    expect(counts.root).toEqual({ own: 1, below: 4 });
    expect(countText(counts.folders.get("강의"))).toBe("1 · 2");
    expect(countText(counts.folders.get("2026-2"))).toBe("2");
    expect(countText({ own: 0, below: 0 })).toBe("");
  });

  it("split tags on / and count each project once per tag, with 태그 없음", () => {
    const { nodes, untagged } = tagTree(projects);
    expect(untagged).toBe(2);
    expect(nodes.map((node) => [node.name, node.count, node.children.map((child) => `${child.tag}:${child.count}`)])).toEqual([
      ["강의", 2, ["강의/2026-2:1"]],
      ["글쓰기", 1, []],
      ["연구", 1, ["연구/인용:1"]],
    ]);
  });
});

describe("shortcuts", () => {
  it("are seeded once from what was pinned (works, then sessions), skipping archived ones", () => {
    const pinned = stateOf([], [work("b", null, 1, { pinned: true }), work("a", null, 1, { pinned: true }), work("c", null, 1, { pinned: true, archivedAt: 3 }), work("d", null, 1)], [session("s", "d", { pinned: true }), session("t", "c", { pinned: true })]);
    expect(seedShortcuts(pinned)).toEqual([
      { kind: "work", id: "a" },
      { kind: "work", id: "b" },
      { kind: "session", id: "s" },
    ]);
    expect(readShortcuts(undefined)).toBeNull();
    expect(readShortcuts([{ kind: "work", id: "a", label: " 강의 " }, { kind: "note", id: "x" }, { kind: "work", id: "a" }])).toEqual([{ kind: "work", id: "a", label: "강의" }]);
  });

  it("take new entries where dropped (moving those already there), and move one at a time", () => {
    const list = [
      { kind: "work" as const, id: "a" },
      { kind: "folder" as const, id: "f", label: "내 강의" },
      { kind: "tag" as const, id: "강의" },
    ];
    expect(addShortcuts(list, [{ kind: "work", id: "z" }], 1).map((entry) => entry.id)).toEqual(["a", "z", "f", "강의"]);
    expect(addShortcuts(list, [{ kind: "folder", id: "f" }, { kind: "work", id: "y" }], 0)).toEqual([{ kind: "folder", id: "f", label: "내 강의" }, { kind: "work", id: "y" }, { kind: "work", id: "a" }, { kind: "tag", id: "강의" }]);
    expect(moveShortcut(list, 0, 3).map((entry) => entry.id)).toEqual(["f", "강의", "a"]);
    expect(moveShortcut(list, 2, 0).map((entry) => entry.id)).toEqual(["강의", "a", "f"]);
    expect(moveShortcut(list, 1, 2)).toBe(list);
  });
});

it("sorts the same way for a sort written down per folder (NavSort round trip)", () => {
  const sort: NavSort = { key: "created", desc: false };
  expect(readNavigator({ sortDefault: sort }).sortDefault).toEqual(sort);
});
