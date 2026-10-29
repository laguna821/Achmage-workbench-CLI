import { describe, expect, it } from "vitest";
import { cleanView, currentView, defaultViews, readHomeViews, resetView, VIEW_LIMITS, type HomeView } from "./home-views.ts";

describe("home views", () => {
  it("start with today's screens as the default views, plus 마감 × 중요도 and 폴더별 in 프로젝트", () => {
    const views = readHomeViews(undefined);
    expect(views.modes.projects.views.map((view) => [view.name, view.layout])).toEqual([
      ["카드", "cards"],
      ["표", "table"],
      ["단계", "board"],
      ["그래프", "graph"],
      ["마감 × 중요도", "board"],
      ["폴더별", "table"],
    ]);
    expect(views.modes.projects.current).toBe("d-cards");
    expect(currentView(views, "now")).toMatchObject({ name: "상태", group: { key: "status" } });
    expect(currentView(views, "flow")).toMatchObject({ layout: "calendar", colorBy: "engine" });
    expect(currentView(views, "docs")).toMatchObject({ layout: "cards", sort: { key: "modified", dir: "desc" } });
    const due = views.modes.projects.views.find((view) => view.id === "d-due")!;
    expect(due.group).toEqual({ key: "prop:마감일", dates: "period" });
    expect(due.subgroup).toEqual({ key: "prop:중요도" });
  });

  it("take the projects' layout and the cards' mind map kept before views, once", () => {
    expect(readHomeViews(null, { projectsLayout: "kanban" }).modes.projects.current).toBe("d-stage");
    expect(readHomeViews(null, { projectsLayout: "graph" }).modes.projects.current).toBe("d-graph");
    expect(readHomeViews(null, { projectsLayout: "table" }).modes.projects.current).toBe("d-table");
    expect(readHomeViews(null, { projectsLayout: "아무거나" }).modes.projects.current).toBe("d-cards");
    expect(readHomeViews(null, { homeMap: "mindmap" }).modes.projects.views[0]!.mindmap).toBe(true);
    // Once saved, what the device kept before no longer counts.
    const saved = readHomeViews(null, { projectsLayout: "table" });
    expect(readHomeViews(JSON.parse(JSON.stringify(saved)), { projectsLayout: "graph" }).modes.projects.current).toBe("d-table");
  });

  it("keep what can be trusted of saved views and drop the rest", () => {
    const raw = {
      v: 1,
      modes: {
        projects: {
          current: "mine",
          views: [
            {
              id: "mine",
              name: "  내 보기  ",
              layout: "board",
              filter: "#강의",
              sort: { key: "title", dir: "asc" },
              group: { key: "prop:DIKM_단계:", reverse: true, dates: "nope" },
              subgroup: { key: "stage", hideEmpty: true },
              fields: ["tags", "tags", "", 3],
              look: { colors: { "stage=완료": "#30A46C", bad: "red", "x=y": "#12345" }, border: true, tint: 55, heading: "yes" },
              collapsed: ["stage=완료", 4],
            },
            { id: "mine", name: "같은 id", layout: "table" },
            { name: "id 없음", layout: "table" },
            { id: "odd", layout: "calendar", group: null, subgroup: { key: "stage" } },
          ],
        },
        now: { views: "아님" },
      },
    };
    const views = readHomeViews(raw);
    const [mine, odd] = views.modes.projects.views as [HomeView, HomeView];
    expect(views.modes.projects.views).toHaveLength(2);
    expect(mine).toEqual({
      id: "mine",
      name: "내 보기",
      layout: "board",
      filter: "#강의",
      sort: { key: "title", dir: "asc" },
      group: { key: "prop:DIKM_단계:", reverse: true },
      subgroup: { key: "stage", hideEmpty: true },
      fields: ["tags"],
      look: { colors: { "stage=완료": "#30a46c" }, border: true, tint: 30, heading: false },
      collapsed: ["stage=완료"],
    });
    // A layout the mode does not have becomes its first; a subgroup without a group goes.
    expect(odd).toMatchObject({ layout: "board", name: "보드", group: null, subgroup: null });
    expect(views.modes.projects.current).toBe("mine");
    // A mode with nothing usable starts over with its defaults.
    expect(views.modes.now.views.map((view) => view.id)).toEqual(["d-now"]);
    expect(views.modes.flow.views[0]!.colorBy).toBe("engine");
  });

  it("stay small: views, colours and folded groups are capped", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `v${index}`, name: "보기".repeat(40), layout: "table", filter: "x".repeat(900), collapsed: Array.from({ length: 400 }, (_, at) => `k=${at}`) }));
    const views = readHomeViews({ v: 1, modes: { projects: { views: many, current: "v29" } } });
    expect(views.modes.projects.views).toHaveLength(VIEW_LIMITS.views);
    expect(views.modes.projects.current).toBe("v0");
    const first = views.modes.projects.views[0]!;
    expect(first.name.length).toBe(VIEW_LIMITS.name);
    expect(first.filter.length).toBe(VIEW_LIMITS.filter);
    expect(first.collapsed).toHaveLength(VIEW_LIMITS.collapsed);
    expect(first.collapsed.at(-1)).toBe("k=399");
    const colors = Object.fromEntries(Array.from({ length: 200 }, (_, at) => [`k=${at}`, "#000000"]));
    expect(Object.keys(cleanView("projects", { id: "c", layout: "board", look: { colors } })!.look.colors)).toHaveLength(VIEW_LIMITS.colors);
    expect(JSON.stringify(views).length).toBeLessThan(64_000);
  });

  it("go back to how they started", () => {
    const stage = defaultViews("projects").find((view) => view.id === "d-stage")!;
    expect(resetView("projects", { ...stage, name: "칸반", group: { key: "folder" }, look: { ...stage.look, tint: 20 } })).toEqual(stage);
    const mine = cleanView("projects", { id: "mine", name: "내 표", layout: "table", filter: "#강의", group: { key: "stage" } })!;
    expect(resetView("projects", mine)).toMatchObject({ id: "mine", name: "내 표", layout: "table", filter: "", group: null });
    expect(resetView("flow", cleanView("flow", { id: "f", name: "강의", layout: "calendar", colorBy: "stage" })!).colorBy).toBe("engine");
  });
});
