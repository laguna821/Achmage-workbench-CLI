import { describe, expect, it } from "vitest";
import type { Artifact, Folder, Session, Work } from "@workbench/contracts";
import { initialState, type State } from "../../state.ts";
import { docKind, folderPath, insideSections, levelOneRows, projectsOf, projectTone, readNavigator } from "./model.ts";

// N1: the navigation's data (no React): the stored preferences the old layouts left, level 1's rows,
// level 2's sections, and the words a row says.

const folder = (id: string, parentId: string | null = null, sort = 0): Folder => ({ id, parentId, name: id, sort, archivedAt: null }) as Folder;
const work = (id: string, folderId: string | null, sort = 0, updatedAt = 1) => ({ id, title: id, folderId, cwd: `/w/${id}`, pinned: false, sort, archivedAt: null, createdAt: 1, updatedAt }) as unknown as Work;
const session = (id: string, workId: string, extra: Partial<Session> = {}) => ({ id, workId, provider: "codex", purpose: id, status: "idle", archivedAt: null, sort: 0, createdAt: 1, updatedAt: 1, seenAt: null, previewAt: null, preview: null, ...extra }) as unknown as Session;
const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
const state = (): State => ({
  ...initialState,
  folders: byId([folder("강의"), folder("2026-2학기", "강의"), folder("연구", null, 1)]),
  works: byId([work("AI 글쓰기 수업", "2026-2학기"), work("4주차 토론", "2026-2학기", 1), work("논문 리뷰", "연구"), work("개인 메모", null)]),
  sessions: byId([session("강의안 다듬기", "AI 글쓰기 수업", { status: "running" }), session("사례 발굴", "AI 글쓰기 수업", { status: "awaitingApproval" }), session("참고 자료", "AI 글쓰기 수업", { pageAgent: { pageId: "p" } } as Partial<Session>)]),
  artifacts: byId([{ id: "d1", workId: "AI 글쓰기 수업", name: "3주차 강의안.md", path: "/x", format: "markdown", revision: 1, updatedAt: 3 }, { id: "d2", workId: "AI 글쓰기 수업", name: "슬라이드.pptx", path: "/y", format: "pptx", revision: 1, updatedAt: 2 }] as unknown as Artifact[]),
});
const options = { closedFolders: [] as string[], query: "", filter: { kind: "root" as const }, sortMode: "manual" as const, groupBy: "folder" as const, sort: { key: "activity" as const, desc: true }, stages: [], now: 10 };

describe("the old layouts' preferences (migration)", () => {
  it("read without an error into the one navigation, keeping folds, sorts, the selection and widths", () => {
    const old = { layout: "dual", navWidth: 230, listWidth: 340, navHeight: 0.5, selected: { kind: "tag", tag: "강의" }, sections: { now: true, tags: true }, sortByFolder: { root: { key: "name", desc: false } }, density: "standard", previewLines: 2, openTags: ["강의"] };
    const prefs = readNavigator(old);
    expect(prefs).toMatchObject({ rail: "projects", level: "projects", project: null, groupBy: "folder", tabsAll: false, layout: "dual", navWidth: 230, listWidth: 340, selected: { kind: "tag", tag: "강의" }, sections: { now: true, tags: true }, density: "standard", previewLines: 2, openTags: ["강의"] });
    expect(readNavigator({ layout: "tree" })).toMatchObject({ rail: "projects", level: "projects", density: "compact" });
    expect(readNavigator(null)).toMatchObject({ rail: "projects", level: "projects" });
    // Level 2 needs a project; a broken value goes back to level 1.
    expect(readNavigator({ level: "project" }).level).toBe("projects");
    expect(readNavigator({ level: "project", project: "A", rail: "docs", groupBy: "list", tabsAll: true })).toMatchObject({ level: "project", project: "A", rail: "docs", groupBy: "list", tabsAll: true });
    expect(readNavigator({ rail: "somewhere" }).rail).toBe("projects");
  });
});

describe("level 1's rows", () => {
  it("every folder with its projects under it, subfolders after, projects outside folders under 폴더 밖", () => {
    const s = state();
    const { rows, count } = levelOneRows(projectsOf(s, new Map()), s.folders, options);
    expect(rows.map((row) => `${row.type}:${row.id}:${"depth" in row ? row.depth : "-"}`)).toEqual(["folder:강의:0", "folder:2026-2학기:1", "project:AI 글쓰기 수업:2", "project:4주차 토론:2", "folder:연구:0", "project:논문 리뷰:1", "group:group:loose:-", "project:개인 메모:0"]);
    expect(count).toBe(4);
    const lecture = rows.find((row) => row.id === "강의");
    expect(lecture && lecture.type === "folder" ? lecture.count : -1).toBe(2);
  });
  it("a folded folder hides what is under it; a search opens the folders it matches in", () => {
    const s = state();
    expect(levelOneRows(projectsOf(s, new Map()), s.folders, { ...options, closedFolders: ["강의"] }).rows.map((row) => row.id)).toEqual(["강의", "연구", "논문 리뷰", "group:loose", "개인 메모"]);
    expect(levelOneRows(projectsOf(s, new Map()), s.folders, { ...options, closedFolders: ["강의"], query: "토론" }).rows.map((row) => row.id)).toEqual(["강의", "2026-2학기", "4주차 토론"]);
    expect(levelOneRows(projectsOf(s, new Map()), s.folders, { ...options, query: "연구" }).rows.map((row) => row.id)).toEqual(["연구", "논문 리뷰"]);
  });
  it("one status mark per project: 확인 필요 before 진행 중", () => {
    const s = state();
    const project = projectsOf(s, new Map()).find((entry) => entry.work.id === "AI 글쓰기 수업")!;
    expect(projectTone(project)?.word).toBe("확인 필요");
    expect(project.needs).toBeGreaterThan(0);
  });
});

describe("level 2", () => {
  it("대화 · 문서 · 웹 of one project, its documents with their kind", () => {
    const s = state();
    const sections = insideSections(s, s.works["AI 글쓰기 수업"]!);
    expect(sections.chats.map((row) => row.id)).toEqual(["강의안 다듬기", "사례 발굴"]);
    expect(sections.docs.map((row) => row.id)).toEqual(["d1", "d2"]);
    expect(sections.web.map((row) => row.id)).toEqual(["참고 자료"]);
    expect(sections.docs.map((row) => docKind(row.artifact.name, row.artifact.format))).toEqual(["MD", "PPTX"]);
    expect(docKind("실습 안내.hwpx", "hwpx")).toBe("HWPX");
    expect(folderPath(s.folders, "2026-2학기")).toBe("강의 / 2026-2학기");
  });
});
