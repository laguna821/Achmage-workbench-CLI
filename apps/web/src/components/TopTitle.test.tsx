// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopTitle } from "./TopTitle.tsx";

// 0.5.6 round 2: the top bar's name looked like a button on every tab but renamed only on a
// conversation tab. Now it is a button exactly where pressing it renames what it names (the project a
// conversation, document or project tab belongs to); elsewhere (웹, 보관함, the phone page) it is a
// plain name, not a button.
afterEach(cleanup);

describe("the top bar's name", () => {
  it("renames what it names where that can be renamed: pressed, a field with the name; Enter saves; emptied asks for the automatic name", () => {
    const onRename = vi.fn();
    render(<TopTitle kind="프로젝트" title="강의 준비" rename={{ value: "강의 준비", label: "프로젝트 이름", onRename }} />);
    const button = screen.getByRole("button", { name: /강의 준비/ });
    expect(button.getAttribute("title")).toBe("눌러서 프로젝트 이름 바꾸기");
    fireEvent.click(button);
    const field = screen.getByRole("textbox", { name: "프로젝트 이름" }) as HTMLInputElement;
    expect(field.value).toBe("강의 준비");
    expect(field.placeholder).toBe("비우면 자동 이름");
    fireEvent.change(field, { target: { value: "가을 특강" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("가을 특강");
    expect(screen.getByRole("button", { name: /강의 준비/ })).toBeTruthy();
  });

  it("is a plain name, not a button, where nothing is renamed (웹, the phone page)", () => {
    render(<TopTitle kind="웹" title="검색 결과" />);
    expect(screen.queryByRole("button")).toBeNull();
    const name = document.querySelector(".topbar-title")!;
    expect(name.tagName).toBe("DIV");
    expect(name.classList.contains("static")).toBe(true);
    expect(name.textContent).toBe("웹검색 결과");
  });
});
