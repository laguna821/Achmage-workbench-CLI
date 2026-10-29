import { describe, expect, it } from "vitest";
import { folderPath, projectMatcher, type QueryProject } from "./project-query.ts";

const project = (patch: Partial<QueryProject> = {}): QueryProject => ({
  title: "가을 특강 준비",
  stage: "진행중",
  tags: ["강의/2026-2", "글쓰기"],
  properties: [
    { key: "마감일", values: ["2026-11-02"] },
    { key: "종류:", values: ["인사이트", "자기반성"] },
    { key: "중요도", values: ["높음"] },
    { key: "목표", values: [] },
  ],
  folder: "강의/2026-2",
  ...patch,
});

const passes = (query: string, patch?: Partial<QueryProject>) => projectMatcher(query)(project(patch));

describe("project queries", () => {
  it("match words in the name, tags (and those under them), the stage and the folder", () => {
    expect(passes("")).toBe(true);
    expect(passes("특강")).toBe(true);
    expect(passes("특강 봄")).toBe(false);
    expect(passes("#강의")).toBe(true);
    expect(passes("#강의/2026-2")).toBe(true);
    expect(passes("#수학")).toBe(false);
    expect(passes("단계:진행중")).toBe(true);
    expect(passes("단계:완료")).toBe(false);
    expect(passes("단계:", { stage: null })).toBe(false);
    expect(passes("폴더:강의")).toBe(true);
    expect(passes("폴더:2026-2")).toBe(true);
    expect(passes("폴더:연구")).toBe(false);
  });

  it("match any property by part of a value, a key with its own colon, and negate with -", () => {
    expect(passes("마감일:2026-11")).toBe(true);
    expect(passes("중요도:높음")).toBe(true);
    expect(passes("종류:인사이트")).toBe(true);
    expect(passes('"종류:":자기반성')).toBe(true);
    expect(passes('"종류":자기반성')).toBe(false);
    expect(passes("목표:")).toBe(false);
    expect(passes("-중요도:낮음")).toBe(true);
    expect(passes("-#글쓰기")).toBe(false);
    expect(passes('"가을 특강"')).toBe(true);
  });
});

describe("folder paths", () => {
  it("read the names from the top, and stop at a folder that is gone or a loop", () => {
    const folders = { a: { name: "강의", parentId: null }, b: { name: "2026-2", parentId: "a" }, c: { name: "고리", parentId: "d" }, d: { name: "고리2", parentId: "c" } };
    expect(folderPath(folders, "b")).toBe("강의/2026-2");
    expect(folderPath(folders, null)).toBeNull();
    expect(folderPath(folders, "없음")).toBeNull();
    expect(folderPath(folders, "c")).toBe("고리2/고리");
  });
});
