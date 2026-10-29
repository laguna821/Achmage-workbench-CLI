import { describe, expect, it } from "vitest";
import { buildGraph, layout, neighbours, type GraphInput } from "./graph.ts";

const projects: GraphInput = [
  { id: "a", title: "가을 특강", tags: ["강의"], related: [], sessions: 3 },
  { id: "b", title: "안녕", tags: ["강의", "2026"], related: ["[[가을 특강]]"], sessions: 7 },
  { id: "c", title: "논문", tags: ["연구"], related: ["[[없는 프로젝트]]"], sessions: 0 },
];

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

  it("lays points out the same way every time, inside the frame, apart from each other", () => {
    const { nodes, edges } = buildGraph(projects, true);
    const first = layout(nodes, edges, { width: 600, height: 400 });
    expect(layout(nodes, edges, { width: 600, height: 400 })).toEqual(first);
    for (const node of first) {
      expect(node.x).toBeGreaterThanOrEqual(40);
      expect(node.x).toBeLessThanOrEqual(560);
      expect(node.y).toBeGreaterThanOrEqual(40);
      expect(node.y).toBeLessThanOrEqual(360);
    }
    const distances = first.flatMap((a, i) => first.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y)));
    expect(Math.min(...distances)).toBeGreaterThan(20);
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
