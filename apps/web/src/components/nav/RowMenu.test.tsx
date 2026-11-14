// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RowMenu } from "./RowMenu.tsx";
import { FromMenu } from "./dialogs.tsx";

afterEach(cleanup);

describe("a row's menu on the shared Menu", () => {
  it("draws items, separators (never two in a row or at an edge) and runs the chosen item", () => {
    const remove = vi.fn(), onClose = vi.fn();
    render(<RowMenu anchor={{ x: 10, y: 10 }} onClose={onClose} request={{ x: 10, y: 10, title: "강의안.md", items: [
      { kind: "separator" },
      { kind: "item", label: "열기", onSelect: vi.fn() },
      { kind: "separator" }, { kind: "separator" },
      { kind: "item", label: "삭제", danger: true, onSelect: remove },
      { kind: "separator" },
    ] }} />);
    const menu = screen.getByRole("menu", { name: "강의안.md" });
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
    expect(remove).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a submenu (a document AI's own actions)", () => {
  it("opens beside its item and runs a chosen action, closing both", () => {
    const archive = vi.fn(), onClose = vi.fn();
    render(<RowMenu anchor={{ x: 10, y: 10 }} onClose={onClose} request={{ x: 10, y: 10, title: "강의안.md", items: [
      { kind: "item", label: "열기", onSelect: vi.fn() },
      { kind: "submenu", label: "문서 AI · Codex · 대기 중", items: [{ kind: "item", label: "보관", onSelect: archive }] },
    ] }} />);
    expect(screen.queryByRole("menuitem", { name: "보관" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /문서 AI · Codex/ }));
    expect(screen.getByRole("menu", { name: "문서 AI · Codex · 대기 중" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "보관" }));
    expect(archive).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

// The keyboard path of the same submenu: → opens it from its item, ← closes it, and the keys go on
// in the menu they came from.
describe("a submenu from the keyboard", () => {
  const menu = (onClose = vi.fn(), archive = vi.fn(), open = vi.fn()) => {
    render(<RowMenu anchor={{ x: 10, y: 10 }} onClose={onClose} request={{ x: 10, y: 10, title: "강의안.md", items: [
      { kind: "item", label: "열기", onSelect: open },
      { kind: "submenu", label: "문서 AI · Codex · 대기 중", items: [{ kind: "item", label: "이름 바꾸기", onSelect: vi.fn() }, { kind: "item", label: "보관", onSelect: archive }] },
    ] }} />);
    return { onClose, archive, open };
  };
  const key = (name: string) => fireEvent.keyDown(document.activeElement!, { key: name });

  it("→ opens the submenu of the active item; ← closes it and leaves the first menu open and in use", () => {
    const { onClose, open } = menu();
    key("ArrowDown");
    key("ArrowRight");
    const sub = screen.getByRole("menu", { name: "문서 AI · Codex · 대기 중" });
    // The keys are the submenu's now.
    expect(sub.closest(".ui-menu")!.contains(document.activeElement)).toBe(true);
    key("ArrowLeft");
    expect(screen.queryByRole("menu", { name: "문서 AI · Codex · 대기 중" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    const first = screen.getByRole("menu", { name: "강의안.md" });
    expect(first.closest(".ui-menu")!.contains(document.activeElement)).toBe(true);
    key("ArrowUp");
    key("Enter");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("→ then ↓ and Enter runs the action in the submenu and closes both", () => {
    const { onClose, archive } = menu();
    key("ArrowDown");
    key("ArrowRight");
    key("ArrowDown");
    key("Enter");
    expect(archive).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("→ on an ordinary item, and ← in the first menu, do nothing", () => {
    const { onClose, open } = menu();
    key("ArrowRight");
    key("ArrowLeft");
    expect(screen.queryByRole("menu", { name: "문서 AI · Codex · 대기 중" })).toBeNull();
    expect(screen.getByRole("menu", { name: "강의안.md" })).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// A dialog opened from a row's menu: when it closes, the focus is back on that row — not on the
// page, where Enter and Esc would answer a waiting approval.
describe("a dialog opened from a row's menu", () => {
  function Row() {
    const [menu, setMenu] = useState<HTMLElement | null>(null), [dialog, setDialog] = useState(false);
    return (
      <div>
        <div data-row-id="doc" tabIndex={0} aria-label="강의안.md 줄">
          <button type="button" aria-label="메뉴" onClick={(event) => setMenu(event.currentTarget)}>⋯</button>
        </div>
        {menu ? <RowMenu anchor={menu} onClose={() => setMenu(null)} request={{ x: 0, y: 0, title: "강의안.md", items: [
          { kind: "submenu", label: "문서 AI", items: [{ kind: "item", label: "이름 바꾸기", onSelect: () => setDialog(true) }] },
        ] }} /> : null}
        {dialog ? <FromMenu><div role="dialog" aria-label="이름 바꾸기"><input aria-label="이름" autoFocus /><button type="button" onClick={() => setDialog(false)}>취소</button></div></FromMenu> : null}
      </div>
    );
  }

  it("gives the focus back to the row when it closes", async () => {
    render(<Row />);
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "이름 바꾸기" }));
    expect(screen.getByRole("dialog", { name: "이름 바꾸기" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("강의안.md 줄")));
  });
});
