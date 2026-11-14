// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuGroup, MenuItem, MenuLabel, MenuSeparator, type MenuCloseReason } from "./Menu.tsx";

afterEach(cleanup);

function Harness({ onSelect = () => {}, onClose = () => {}, onOuterKey = () => {} }: { onSelect?: (what: string) => void; onClose?: (reason: MenuCloseReason) => void; onOuterKey?: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div onKeyDown={event => onOuterKey(event.key)}>
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>열기</button>
    <button type="button">바깥</button>
    <Menu open={open} anchor={trigger} label="보기 메뉴" onClose={reason => { onClose(reason); setOpen(false); }}>
      <MenuLabel hint="⇧⌘.">보기</MenuLabel>
      <MenuItem icon="grid" hint="2칸" onSelect={() => onSelect("배치")}>화면 배치</MenuItem>
      <MenuItem type="radio" checked={false} onSelect={() => onSelect("모델")}>모델</MenuItem>
      <MenuItem type="radio" checked onSelect={() => onSelect("엔진")}>엔진</MenuItem>
      <MenuSeparator />
      <MenuItem disabled disabledReason="권한이 없습니다." onSelect={() => onSelect("잠김")}>모두 지우기</MenuItem>
      <MenuGroup label="편집">
        <MenuItem checked={false} shortcut="Ctrl+E" onSelect={() => onSelect("Edit")}>Edit mode</MenuItem>
        <MenuItem onSelect={() => onSelect("목록")}>목록 보기</MenuItem>
      </MenuGroup>
    </Menu>
  </div>;
}

const openMenu = () => {
  const trigger = screen.getByRole("button", { name: "열기" });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.getByRole("menu", { name: "보기 메뉴" });
};
// Focus sits in the menu's type-ahead field, which points at the active item.
const activeName = (_menu?: HTMLElement) => document.getElementById(document.activeElement?.getAttribute("aria-activedescendant") ?? "")?.querySelector(".ui-menu-text")?.textContent;
const field = () => screen.getByRole("combobox", { name: "보기 메뉴" });

describe("Menu", () => {
  it("renders in a top layer outside the trigger's container with menu roles", () => {
    const view = render(<Harness />);
    const menu = openMenu();
    expect(view.container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    expect(screen.getByRole("menuitem", { name: /화면 배치/ })).toBeTruthy();
    expect(screen.getAllByRole("menuitemradio").map(item => item.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(screen.getByRole("menuitemcheckbox", { name: /Edit mode/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("group", { name: "편집" })).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /모두 지우기/ }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("권한이 없습니다.")).toBeTruthy();
    expect(screen.getByText("Ctrl+E").tagName).toBe("KBD");
    expect(screen.getByText("2칸")).toBeTruthy();
  });

  it("focuses on the checked item and moves with arrows, Home and End, through disabled items too", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const menu = openMenu();
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("aria-controls")).toBe(menu.id);
    expect(activeName(menu)).toBe("엔진");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // Reachable and announced with its reason, but Enter does nothing.
    expect(activeName(menu)).toBe("모두 지우기권한이 없습니다.");
    const locked = screen.getByRole("menuitem", { name: /모두 지우기/ });
    expect(document.getElementById(locked.getAttribute("aria-describedby")!)?.textContent).toBe("권한이 없습니다.");
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(activeName(menu)).toBe("Edit mode");
    fireEvent.keyDown(menu, { key: "End" });
    expect(activeName(menu)).toBe("목록 보기");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(activeName(menu)).toBe("화면 배치");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(activeName(menu)).toBe("목록 보기");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(activeName(menu)).toBe("화면 배치");
  });

  it("chooses with Enter, closes and returns focus to the trigger", () => {
    const onSelect = vi.fn(), onClose = vi.fn();
    render(<Harness onSelect={onSelect} onClose={onClose} />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("모델");
    expect(onClose).toHaveBeenCalledWith("select");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "열기" }));
  });

  it("closes on Escape without the key reaching what is behind the menu", () => {
    const onClose = vi.fn(), onOuterKey = vi.fn();
    render(<Harness onClose={onClose} onOuterKey={onOuterKey} />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("escape");
    expect(onOuterKey).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "열기" }));
  });

  it("closes on a click elsewhere but not on its own trigger", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    openMenu();
    fireEvent.pointerDown(screen.getByRole("button", { name: "열기" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: /화면 배치/ }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "바깥" }));
    expect(onClose).toHaveBeenCalledWith("outside");
  });

  it("clicks choose an item; a disabled item does nothing", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /모두 지우기/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Edit mode/ }));
    expect(onSelect).toHaveBeenCalledWith("Edit");
  });

  it("moves to what is typed through an editable field, so an IME can compose Hangul", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      openMenu();
      const input = field();
      fireEvent.change(input, { target: { value: "e" } });
      expect(activeName()).toBe("Edit mode");
      act(() => { vi.advanceTimersByTime(1000); });
      expect((input as HTMLInputElement).value).toBe("");
      // An IME: keydown while composing is ignored; the field's value carries the syllable being built.
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "Process", keyCode: 229, isComposing: true });
      fireEvent.change(input, { target: { value: "ㅁ" } });
      expect(activeName()).toBe("목록 보기");
      fireEvent.keyDown(input, { key: "Process", keyCode: 229, isComposing: true });
      fireEvent.change(input, { target: { value: "모" } });
      expect(activeName()).toBe("목록 보기");
      fireEvent.change(input, { target: { value: "모델" } });
      expect(activeName()).toBe("모델");
      fireEvent.compositionEnd(input);
      act(() => { vi.advanceTimersByTime(1000); });
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: "화" } });
      fireEvent.compositionEnd(input);
      expect(activeName()).toBe("화면 배치");
    } finally { vi.useRealTimers(); }
  });

  it("keeps pointer events in the menu from reaching the owner's handlers", () => {
    const owner = vi.fn();
    function Owned() {
      const trigger = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(true);
      return <header onMouseDown={owner} onPointerDown={owner} onClick={owner}><button ref={trigger} type="button">칸</button>
        <Menu open={open} anchor={trigger} label="칸 메뉴" onClose={() => setOpen(false)}><MenuItem onSelect={() => {}}>둘째 칸</MenuItem></Menu></header>;
    }
    render(<Owned />);
    const item = screen.getByRole("menuitem", { name: "둘째 칸" });
    fireEvent.pointerDown(item);
    fireEvent.mouseDown(item);
    fireEvent.click(item);
    expect(owner).not.toHaveBeenCalled();
  });

  it("opens at a point for context menus and portals into an open modal dialog", () => {
    function PointMenu() {
      const [open, setOpen] = useState(true);
      return <Menu open={open} anchor={{ x: 40, y: 50 }} label="행 메뉴" onClose={() => setOpen(false)}><MenuItem onSelect={() => {}}>이름 바꾸기</MenuItem></Menu>;
    }
    render(<PointMenu />);
    const menu = screen.getByRole("menu", { name: "행 메뉴" });
    expect(menu.closest(".ui-layer")?.parentElement).toBe(document.body);
    cleanup();

    function DialogMenu() {
      const trigger = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return <dialog open><button ref={trigger} type="button" onClick={() => setOpen(true)}>열기</button>
        <Menu open={open} anchor={trigger} label="대화상자 메뉴" onClose={() => setOpen(false)}><MenuItem onSelect={() => {}}>하나</MenuItem></Menu></dialog>;
    }
    render(<DialogMenu />);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    expect(screen.getByRole("menu", { name: "대화상자 메뉴" }).closest("dialog")).toBeTruthy();
  });
});
