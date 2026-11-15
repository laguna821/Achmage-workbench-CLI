// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopSearch, centreOnWindow } from "./TopSearch.tsx";

// Release unit A, item 4: the owner's draft has a search field in the top bar's centre
// ("프로젝트 · 대화 · 문서 검색" + its shortcut). It opens the existing palette with what was typed.
afterEach(cleanup);

describe("the top bar's search field", () => {
  it("is a quiet field named for what it finds, with the palette's shortcut and no middle dot", () => {
    render(<TopSearch shortcut="Ctrl+K" onOpen={() => undefined} />);
    const field = screen.getByRole("searchbox", { name: "프로젝트, 대화, 문서 찾기" }) as HTMLInputElement;
    expect(field.placeholder).toBe("프로젝트, 대화, 문서 찾기");
    expect(field.placeholder).not.toContain("·");
    expect(document.querySelector(".top-search kbd")?.textContent).toBe("Ctrl+K");
  });

  it("typing opens the palette with what was typed, and the field is left empty", () => {
    const onOpen = vi.fn();
    render(<TopSearch shortcut="Ctrl+K" onOpen={onOpen} />);
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "강" } });
    expect(onOpen).toHaveBeenCalledWith("강");
    expect(field.value).toBe("");
  });

  it("waits for a Hangul syllable to be composed before it opens the palette with it", () => {
    const onOpen = vi.fn();
    render(<TopSearch shortcut="Ctrl+K" onOpen={onOpen} />);
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "ㄱ" } });
    fireEvent.change(field, { target: { value: "강" } });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field, { data: "강" });
    expect(onOpen).toHaveBeenCalledWith("강");
  });

  it("a click, Enter or ↓ opens the palette as it is", () => {
    const onOpen = vi.fn();
    render(<TopSearch shortcut="Ctrl+K" onOpen={onOpen} />);
    const field = screen.getByRole("searchbox");
    fireEvent.click(field);
    expect(onOpen).toHaveBeenLastCalledWith("");
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("Tab passes through it without opening anything", () => {
    const onOpen = vi.fn();
    render(<TopSearch shortcut="Ctrl+K" onOpen={onOpen} />);
    const field = screen.getByRole("searchbox");
    field.focus();
    fireEvent.keyDown(field, { key: "Tab" });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("stands centred on the window when the bar has room on both sides, else where the bar puts it", () => {
    const bar = document.createElement("header"); bar.className = "topbar";
    bar.innerHTML = '<div class="topbar-left"></div><button class="topbar-title"></button><label class="top-search"></label><div class="topbar-right"></div>';
    document.body.append(bar);
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 32, height: 32, x: left, y: 0, toJSON() {} }) as DOMRect;
    const at = (selector: string, left: number, width: number) => { bar.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(left, width); };
    at(".topbar-left", 8, 40); at(".topbar-title", 56, 120); at(".top-search", 300, 352); at(".topbar-right", 1180, 252);
    const field = bar.querySelector<HTMLElement>(".top-search")!;
    // 1440: the field's grid place starts at 300; the window's centre wants 1440 / 2 − 176 = 544.
    expect(centreOnWindow(field, bar, 1440)).toBe(244);
    expect(field.style.getPropertyValue("translate")).toBe("244px 0");
    // A long title reaching past where the centred field would start: it stays in its grid place.
    at(".topbar-title", 56, 500);
    expect(centreOnWindow(field, bar, 1440)).toBe(0);
    expect(field.style.getPropertyValue("translate")).toBe("");
    // The right cluster reaching into the centred field: also stays.
    at(".topbar-title", 56, 120); at(".topbar-right", 860, 572);
    expect(centreOnWindow(field, bar, 1440)).toBe(0);
    bar.remove();
  });

  // Tech review 4b (mutants that survived): Enter/↓ while composing, the 8 px of air, the field's value at the composition's end.
  it("Enter or ↓ pressed while a syllable is still being composed does not open the palette", () => {
    const onOpen = vi.fn();
    render(<TopSearch shortcut="Ctrl+K" onOpen={onOpen} />);
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "가" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "ArrowDown", isComposing: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens with the whole field at the end of a composition (강의), not only the last syllable the event carries", () => {
    const onOpen = vi.fn();
    render(<TopSearch shortcut="Ctrl+K" onOpen={onOpen} />);
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "강의" } });
    fireEvent.compositionEnd(field, { data: "의" });
    expect(onOpen).toHaveBeenCalledWith("강의");
  });

  it("keeps 8 px of air from the clusters: 7 px short of it stays in its grid place, exactly 8 px moves", () => {
    const bar = document.createElement("header"); bar.className = "topbar";
    bar.innerHTML = '<div class="topbar-left"></div><label class="top-search"></label><div class="topbar-right"></div>';
    document.body.append(bar);
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 32, height: 32, x: left, y: 0, toJSON() {} }) as DOMRect;
    const at = (selector: string, left: number, width: number) => { bar.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(left, width); };
    const field = bar.querySelector<HTMLElement>(".top-search")!;
    at(".top-search", 300, 352); at(".topbar-right", 1180, 252);
    // Centred, the field starts at 544: the left cluster ending at 536 leaves exactly 8 px.
    at(".topbar-left", 0, 536);
    expect(centreOnWindow(field, bar, 1440)).toBe(244);
    at(".topbar-left", 0, 537);
    expect(centreOnWindow(field, bar, 1440)).toBe(0);
    bar.remove();
  });
});
