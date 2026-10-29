// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STAGES, type Work } from "@workbench/contracts";
import { GRAPH_SETTINGS_KEY } from "../../graph-settings.ts";
import { ProjectsGraph, type GraphItem } from "./ProjectsGraph.tsx";

// The graph view in a DOM (reduced motion, so it is drawn at rest at once): points per project and
// tag, a click opens or lights, Enter too, a drag moves a point without opening it, and the
// settings panel changes what is drawn and is kept on this device.

const work = (id: string, title: string) => ({ id, title, cwd: `/tmp/${id}`, folderId: null, tags: [], archivedAt: null, createdAt: 0, updatedAt: 0 }) as unknown as Work;
const items: GraphItem[] = [
  { work: work("a", "가을 특강"), stage: "진행중", tags: ["강의"], related: [], sessions: 3 },
  { work: work("b", "안녕"), stage: null, tags: ["강의", "2026"], related: ["[[가을 특강]]"], sessions: 1 },
  { work: work("c", "논문"), stage: "완료", tags: ["연구"], related: [], sessions: 0 },
  { work: work("d", "지난 학기"), stage: "아카이브", tags: [], related: [], sessions: 0, archived: true },
];

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const node = (id: string) => document.querySelector<SVGGElement>(`g[data-node="${id}"]`)!;
const position = (id: string) => node(id).getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!.slice(1).map(Number) as [number, number];
const pointer = (type: string, target: EventTarget, x: number, y: number) =>
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
  });

describe("ProjectsGraph", () => {
  it("draws a point per project and tag, at rest at once under reduced motion; archived ones only when asked", () => {
    render(<ProjectsGraph items={items} stages={DEFAULT_STAGES} openProject={() => undefined} />);
    expect(document.querySelectorAll(".graph-node.project")).toHaveLength(3);
    expect(document.querySelectorAll(".graph-node.tag")).toHaveLength(3);
    expect(document.querySelector(".graph-canvas")!.getAttribute("data-state")).toBe("rest");
    expect(node("p:a").getAttribute("transform")).toMatch(/^translate\(/);
    expect(node("p:a").querySelector<SVGCircleElement>(".graph-dot")!.style.fill).toBe("rgb(62, 99, 221)");
    expect(document.querySelector(".graph-edges.related")!.getAttribute("d")).toMatch(/^M[-\d.]+ [-\d.]+L/);
    expect(screen.getByText(/프로젝트 3 · 선 5/)).toBeTruthy();
  });

  it("opens a project on click or Enter, and lights a tag's projects until let go", () => {
    const openProject = vi.fn();
    render(<ProjectsGraph items={items} stages={DEFAULT_STAGES} openProject={openProject} />);
    fireEvent.click(node("p:a").querySelector("circle")!);
    expect(openProject).toHaveBeenCalledWith(items[0]!.work);
    fireEvent.keyDown(node("p:c"), { key: "Enter" });
    expect(openProject).toHaveBeenLastCalledWith(items[2]!.work);
    fireEvent.click(node("t:강의"));
    expect(document.querySelector(".graph-canvas")!.classList.contains("has-lit")).toBe(true);
    expect(node("p:b").hasAttribute("data-lit")).toBe(true);
    expect(node("p:c").hasAttribute("data-lit")).toBe(false);
    fireEvent.click(screen.getByText("#강의 강조 풀기"));
    expect(document.querySelector(".graph-canvas")!.classList.contains("has-lit")).toBe(false);
    expect(openProject).toHaveBeenCalledTimes(2);
  });

  it("moves a dragged point with the pointer and does not open it; with pinning on it stays held", () => {
    const openProject = vi.fn();
    render(<ProjectsGraph items={items} stages={DEFAULT_STAGES} openProject={openProject} />);
    const svg = document.querySelector(".graph-canvas")!;
    const k = Number(document.querySelector(".graph-world")!.getAttribute("transform")!.match(/scale\(([\d.]+)\)/)![1]);
    const [x0, y0] = position("p:c");
    pointer("pointerdown", node("p:c").querySelector("circle")!, 100, 100);
    pointer("pointermove", window, 102, 101);
    expect(position("p:c")).toEqual([x0, y0]);
    pointer("pointermove", window, 160, 140);
    expect(svg.classList.contains("dragging")).toBe(true);
    const [x1, y1] = position("p:c");
    expect(x1 - x0).toBeCloseTo(60 / k, 0);
    expect(y1 - y0).toBeCloseTo(40 / k, 0);
    pointer("pointerup", window, 160, 140);
    fireEvent.click(node("p:c"));
    expect(openProject).not.toHaveBeenCalled();
    expect(screen.queryByText(/고정 .개 풀기/)).toBeNull();

    // "끌어 놓은 점 고정": the dropped point is held; "고정 1개 풀기" lets it go.
    fireEvent.click(screen.getByRole("button", { name: "그래프 설정" }));
    fireEvent.click(screen.getByRole("button", { name: "힘" }));
    fireEvent.click(screen.getByLabelText("끌어 놓은 점 고정"));
    pointer("pointerdown", node("p:a").querySelector("circle")!, 200, 200);
    pointer("pointermove", window, 240, 200);
    pointer("pointerup", window, 240, 200);
    expect(screen.getByText("고정 1개 풀기")).toBeTruthy();
    expect(screen.getByRole("button", { name: "고정 모두 풀기 (1)" })).toBeTruthy();
    fireEvent.click(screen.getByText("고정 1개 풀기"));
    expect(screen.queryByText("고정 1개 풀기")).toBeNull();
  });

  it("changes what is drawn from the settings panel and keeps the settings on this device", () => {
    const { unmount } = render(<ProjectsGraph items={items} stages={DEFAULT_STAGES} openProject={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "그래프 설정" }));
    expect(screen.getByRole("complementary", { name: "그래프 설정" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("태그 점 보이기"));
    expect(document.querySelectorAll(".graph-node.tag")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("보관한 프로젝트 보이기"));
    expect(document.querySelectorAll(".graph-node.project")).toHaveLength(4);
    expect(node("p:d").classList.contains("archived")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "색" }));
    fireEvent.click(screen.getByRole("radiogroup", { name: "관련 선 색" }).querySelector('[aria-label="#e5484d"]')!);
    const stage = document.querySelector<HTMLElement>(".graph-stage")!;
    expect(stage.style.getPropertyValue("--graph-related")).toBe("#e5484d");
    fireEvent.change(screen.getByLabelText("태그 선 색 값"), { target: { value: "#12a59" } });
    expect(stage.style.getPropertyValue("--graph-tag-line")).toBe("");
    fireEvent.change(screen.getByLabelText("태그 선 색 값"), { target: { value: "#12A594" } });
    expect(stage.style.getPropertyValue("--graph-tag-line")).toBe("#12a594");
    const saved = JSON.parse(localStorage.getItem(GRAPH_SETTINGS_KEY)!);
    expect(saved).toMatchObject({ v: 1, filter: { tags: false, archived: true }, color: { related: "#e5484d", tagLine: "#12a594" } });
    unmount();
    render(<ProjectsGraph items={items} stages={DEFAULT_STAGES} openProject={() => undefined} />);
    expect(document.querySelectorAll(".graph-node.tag")).toHaveLength(0);
    expect(document.querySelector<HTMLElement>(".graph-stage")!.style.getPropertyValue("--graph-related")).toBe("#e5484d");
    // Back to the defaults, section by section or all at once.
    fireEvent.click(screen.getByRole("button", { name: "그래프 설정" }));
    fireEvent.click(screen.getByText("모두 기본값으로"));
    expect(document.querySelectorAll(".graph-node.tag")).toHaveLength(3);
    expect(JSON.parse(localStorage.getItem(GRAPH_SETTINGS_KEY)!).color.related).toBeNull();
    // Esc closes the panel; the gear is back.
    fireEvent.keyDown(screen.getByLabelText("태그 점 보이기"), { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "그래프 설정" })).toBeNull();
    expect(screen.getByRole("button", { name: "그래프 설정" })).toBeTruthy();
  });
});
