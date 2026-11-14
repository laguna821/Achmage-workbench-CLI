// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "./Select.tsx";

afterEach(cleanup);

const projects: SelectOption<string>[] = [
  { value: "", label: "모든 프로젝트" },
  { value: "a", label: "강의 자료", group: "강의", hint: "대기 중" },
  { value: "b", label: "목록 정리", group: "강의", hint: "작업 중" },
  { value: "c", label: "논문 리뷰", group: "연구", keywords: ["review"] },
  { value: "d", label: "모델 비교", group: "연구", disabled: true },
];

function Harness({ onChange = () => {}, searchable = false, disabled = false }: { onChange?: (value: string) => void; searchable?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState("a");
  return <Select label="프로젝트 범위" value={value} options={projects} searchable={searchable} disabled={disabled} onChange={next => { onChange(next); setValue(next); }} />;
}

const trigger = () => screen.getByRole("button", { name: "프로젝트 범위" });
const activeOption = () => {
  const input = document.activeElement as HTMLElement;
  return document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.querySelector(".ui-menu-text")?.textContent;
};

describe("Select", () => {
  it("shows the current choice on a trigger that opens a listbox", () => {
    render(<Harness />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent).toContain("강의 자료");
    expect(screen.queryByRole("listbox")).toBeNull();
    trigger().focus();
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox", { name: "프로젝트 범위" });
    expect(list.parentElement?.closest(".ui-menu")?.parentElement).toBe(document.body);
    const options = screen.getAllByRole("option");
    expect(options.map(option => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false", "false"]);
    expect(screen.getByRole("group", { name: "연구" })).toBeTruthy();
    const input = screen.getByRole("combobox", { name: "프로젝트 범위" });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(activeOption()).toBe("강의 자료");
  });

  it("chooses with the keyboard and returns focus to the trigger", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const input = screen.getByRole("combobox", { name: "프로젝트 범위" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOption()).toBe("논문 리뷰");
    // A disabled option is reachable but Enter does not take it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOption()).toBe("모델 비교");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOption()).toBe("모든 프로젝트");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().textContent).toContain("모든 프로젝트");
  });

  it("Escape closes without changing the value", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("jumps to what is typed, including Hangul still being composed", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const input = screen.getByRole("combobox", { name: "프로젝트 범위" });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Process", keyCode: 229, isComposing: true });
    fireEvent.change(input, { target: { value: "ㄴ" } });
    expect(activeOption()).toBe("논문 리뷰");
    fireEvent.change(input, { target: { value: "모" } });
    expect(activeOption()).toBe("목록 정리");
    fireEvent.change(input, { target: { value: "모든" } });
    expect(activeOption()).toBe("모든 프로젝트");
    fireEvent.compositionEnd(input);
  });

  it("filters a searchable list by name, group or keyword and picks the first match", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} searchable />);
    fireEvent.click(trigger());
    const search = screen.getByRole("combobox", { name: "프로젝트 범위 찾기" });
    fireEvent.change(search, { target: { value: "연구" } });
    expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["논문 리뷰", "모델 비교"]);
    fireEvent.change(search, { target: { value: "review" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "없는 것" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("맞는 항목이 없습니다.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "리뷰" } });
    fireEvent.keyDown(search, { key: " " });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("Tab from the open list goes on to the control after the trigger, Shift+Tab back to the trigger", () => {
    render(<><Harness /><button type="button">다음</button></>);
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("combobox", { name: "프로젝트 범위" }), { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("combobox", { name: "프로젝트 범위" }), { key: "Tab", shiftKey: true });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("does not open when disabled", () => {
    render(<Harness disabled />);
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Select with a pinned action (ProjectChoice)", () => {
  const works: SelectOption<string>[] = [
    { value: "w1", label: "학과 회의록 정리", title: "/works/minutes" },
    { value: "w2", label: "논문 리뷰 메모", title: "/works/review" },
    { value: "w3", label: "리뷰 정리" },
  ];
  function Choice({ onChange, onNew }: { onChange: (value: string) => void; onNew: () => void }) {
    return <Select label="프로젝트" value={null} placeholder="새 프로젝트" searchable options={works} onChange={onChange}
      emptyText="맞는 프로젝트가 없습니다." actions={[{ key: "new", label: "새 프로젝트", icon: "plus", hint: "새 폴더", checked: true, onSelect: onNew }]} />;
  }
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "프로젝트" }));
    return screen.getByRole("combobox", { name: "프로젝트 찾기" });
  };

  it("opens on the current action; Enter there runs it", () => {
    const onNew = vi.fn(), onChange = vi.fn();
    render(<Choice onChange={onChange} onNew={onNew} />);
    open();
    expect(activeOption()).toBe("새 프로젝트");
    expect(screen.getByRole("option", { name: /논문 리뷰 메모/ }).getAttribute("title")).toBe("/works/review");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onNew).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("typing 리뷰 then Enter chooses the first matching project, not the action", () => {
    const onNew = vi.fn(), onChange = vi.fn();
    render(<Choice onChange={onChange} onNew={onNew} />);
    const search = open();
    fireEvent.change(search, { target: { value: "리뷰" } });
    expect(activeOption()).toBe("논문 리뷰 메모");
    // The action is still listed after the matches and reachable by arrows.
    expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["논문 리뷰 메모", "리뷰 정리", "새 프로젝트새 폴더"]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("w2");
    expect(onNew).not.toHaveBeenCalled();
  });

  it("no match: the empty text shows, Enter does nothing until the user arrows to the action", () => {
    const onNew = vi.fn(), onChange = vi.fn();
    render(<Choice onChange={onChange} onNew={onNew} />);
    const search = open();
    fireEvent.change(search, { target: { value: "없는 이름" } });
    expect(screen.getByRole("status").textContent).toBe("맞는 프로젝트가 없습니다.");
    expect(activeOption()).toBeUndefined();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onNew).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(activeOption()).toBe("새 프로젝트");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onNew).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});
