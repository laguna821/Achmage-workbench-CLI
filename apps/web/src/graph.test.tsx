import { describe, expect, it } from "vitest";
import { buildGraph, filterGraph, labelWidth, matchesSearch, neighbours, pointShape, shortLabel, type GraphInput } from "./graph.ts";

const projects: GraphInput = [
  { id: "a", title: "가을 특강", tags: ["강의"], related: [], sessions: 3 },
  { id: "b", title: "안녕", tags: ["강의", "2026"], related: ["[[가을 특강]]"], sessions: 7 },
  { id: "c", title: "논문", tags: ["연구"], related: ["[[없는 프로젝트]]"], sessions: 0 },
];

const all = { tags: true, archived: true, orphans: true, search: "" };

describe("the projects' graph", () => {
  it("joins projects by 관련 (by title) and, with tags on, through tag points", () => {
    expect(buildGraph(projects, false)).toEqual({
      nodes: [
        { id: "p:a", kind: "project", label: "가을 특강", weight: 4 },
        { id: "p:b", kind: "project", label: "안녕", weight: 8 },
        { id: "p:c", kind: "project", label: "논문", weight: 1 },
      ],
      edges: [{ from: "p:b", to: "p:a", kind: "related" }],
    });
    const tagged = buildGraph(projects, true);
    expect(tagged.nodes.filter((node) => node.kind === "tag").map((node) => node.label)).toEqual(["#강의", "#2026", "#연구"]);
    expect(tagged.edges.filter((edge) => edge.kind === "tag")).toHaveLength(4);
  });

  it("draws one line for a relation named from both notes, marked both ways", () => {
    const both = buildGraph([{ ...projects[0]!, related: ["[[안녕]]"] }, projects[1]!], false);
    expect(both.edges).toEqual([{ from: "p:a", to: "p:b", kind: "related", mutual: true }]);
    const twice = buildGraph([projects[0]!, { ...projects[1]!, related: ["[[가을 특강]]", "[[가을 특강|특강]]"] }], false);
    expect(twice.edges).toEqual([{ from: "p:b", to: "p:a", kind: "related" }]);
  });

  it("filters: archived projects, unlinked ones and the name filter", () => {
    const withArchived: GraphInput = [...projects, { id: "d", title: "지난 학기", tags: ["강의"], related: [], sessions: 1, archived: true }];
    const ids = (filter: typeof all) => filterGraph(withArchived, filter).nodes.map((node) => node.id);
    expect(ids(all)).toContain("p:d");
    expect(filterGraph(withArchived, all).nodes.find((node) => node.id === "p:d")?.archived).toBe(true);
    expect(ids({ ...all, archived: false })).not.toContain("p:d");
    // Without tag points, "논문" has no line at all: an orphan.
    expect(ids({ ...all, tags: false, orphans: false })).toEqual(["p:a", "p:b"]);
    expect(ids({ ...all, tags: true, orphans: false })).toContain("p:c");
    // Tag points come only from the projects shown.
    expect(ids({ ...all, search: "-#강의" })).toEqual(["p:c", "t:연구"]);
  });

  it("reads the name filter: words in the name, #tag, and - to leave out", () => {
    const project = projects[1]!;
    expect(matchesSearch(project, "")).toBe(true);
    expect(matchesSearch(project, "안")).toBe(true);
    expect(matchesSearch(project, "#강")).toBe(true);
    expect(matchesSearch(project, "#연구")).toBe(false);
    expect(matchesSearch(project, "-안녕")).toBe(false);
    expect(matchesSearch(project, "-#2026")).toBe(false);
    expect(matchesSearch(project, "안녕 -#연구")).toBe(true);
  });

  it("sizes a point and the room for its label", () => {
    expect(shortLabel("짧은 이름")).toBe("짧은 이름");
    expect(shortLabel("가나다라마바사아자차카타파하가나다라마")).toBe("가나다라마바사아자차카타파하가나다…");
    expect(labelWidth("가을", 12)).toBe(24);
    expect(labelWidth("ab", 10)).toBeCloseTo(10.4);
    const [project, tag] = buildGraph([projects[1]!], true).nodes;
    const shape = pointShape(project!, 1, 12);
    expect(shape.r).toBeCloseTo(12.2);
    expect(shape.rx).toBeGreaterThanOrEqual(shape.r);
    expect(pointShape(project!, 2, 12).r).toBeCloseTo(24.4);
    expect(pointShape(tag!, 1, 12).r).toBe(5.5);
  });

  it("lists a project's neighbours: related either way, then projects sharing a tag", () => {
    expect(neighbours(projects, "a")).toEqual([{ id: "b", by: "related", tags: [] }]);
    expect(neighbours(projects, "c")).toEqual([]);
    const withTag = [...projects, { id: "d", title: "강의 자료", tags: ["강의"], related: [], sessions: 1 }];
    expect(neighbours(withTag, "a")).toEqual([
      { id: "b", by: "related", tags: [] },
      { id: "d", by: "tag", tags: ["강의"] },
    ]);
  });
});
