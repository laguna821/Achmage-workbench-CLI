// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppearanceContext, type AppearanceApi } from "../appearance.ts";
import { ContextMenu } from "./ContextMenu.tsx";
import { MenuItem, Popover } from "./Popover.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("navigates the real context menu, reads disabled reasons, and returns Escape to its opener", () => {
  const choose = vi.fn();
  function Menu() {
    const [open, setOpen] = useState(false);
    return <AppearanceContext.Provider value={{ appTheme: "light" } as AppearanceApi}>
      <button onClick={() => setOpen(true)}>만들기</button>
      {open ? <ContextMenu onClose={() => setOpen(false)} request={{ x: 0, y: 0, title: "프로젝트", items: [
        { kind: "item", label: "문서", onSelect: choose },
        { kind: "item", label: "삭제", disabled: true, disabledReason: "작업이 끝난 뒤 삭제할 수 있습니다.", onSelect: choose },
        { kind: "item", label: "선택한 작업공간", checked: true, icon: "folder", onSelect: choose },
      ] }} /> : null}
    </AppearanceContext.Provider>;
  }
  render(<Menu />);
  const opener = screen.getByRole("button", { name: "만들기" }); opener.focus(); fireEvent.click(opener);
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "문서" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("작업이 끝난 뒤 삭제할 수 있습니다.")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Enter" }); expect(choose).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { checked: true }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement?.textContent).toBe("문서");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(opener);
});

it("uses menu keys for popover choices without forcing a form into a menu", () => {
  function Picker({ form = false }: { form?: boolean }) {
    const [open, setOpen] = useState(false);
    return <div className="anchor"><button onClick={() => setOpen(true)}>선택</button><Popover open={open} onClose={() => setOpen(false)}>
      {form ? <input autoFocus aria-label="이름" defaultValue="초안" /> : <><MenuItem onSelect={() => {}}>첫 항목</MenuItem><MenuItem active onSelect={() => setOpen(false)}>선택 항목</MenuItem></>}
    </Popover></div>;
  }
  const view = render(<Picker />);
  const opener = screen.getByRole("button", { name: "선택" }); opener.focus(); fireEvent.click(opener);
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "선택 항목" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" }); expect(document.activeElement?.textContent).toBe("첫 항목");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(document.activeElement).toBe(opener);
  view.rerender(<Picker form />); opener.focus(); fireEvent.click(opener);
  expect(screen.queryByRole("menu")).toBeNull(); expect(screen.getByRole("dialog")).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "이름" }); expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "Escape", isComposing: true }); expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Home" }); expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "Escape" }); expect(document.activeElement).toBe(opener);
});
