// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover } from "../Popover.tsx";
import { AnchoredLayer, type LayerCloseReason } from "./AnchoredLayer.tsx";
import { layerOwns } from "./layers.ts";
import { Menu, MenuItem } from "./Menu.tsx";
import { Select } from "./Select.tsx";

afterEach(cleanup);

const OPTIONS = [{ value: "a", label: "회의록" }, { value: "b", label: "리뷰" }];

/** The legacy dialog pattern (ScheduleDialog, nav/dialogs): capture Escape and capture outside-click, guarded. */
function LegacyDialog({ onClose, onChange }: { onClose: () => void; onChange: (value: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("a");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (layerOwns(event)) return; if (event.key === "Escape") onClose(); };
    const onPointer = (event: PointerEvent) => { if (layerOwns(event)) return; if (!ref.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => { window.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onPointer, true); };
  }, [onClose]);
  return <div ref={ref} role="dialog" aria-label="예약"><Select label="엔진" value={value} options={OPTIONS} onChange={next => { setValue(next); onChange(next); }} /></div>;
}

describe("layer stack", () => {
  it("Escape with a Select open inside a dialog closes only the Select", () => {
    const onClose = vi.fn();
    render(<LegacyDialog onClose={onClose} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "엔진" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "엔진" }), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clicking an option inside a dialog chooses it without closing the dialog", () => {
    const onClose = vi.fn(), onChange = vi.fn();
    render(<LegacyDialog onClose={onClose} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "엔진" }));
    const option = screen.getByRole("option", { name: "리뷰" });
    fireEvent.pointerDown(option);
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("b");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("works the same inside the legacy Popover", () => {
    const onClose = vi.fn(), onChange = vi.fn();
    function Host() {
      return <div className="anchor"><button type="button">설정</button>
        <Popover open onClose={onClose} role="dialog" label="설정"><Select label="엔진" value="a" options={OPTIONS} onChange={onChange} /></Popover></div>;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "엔진" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "엔진" }), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "엔진" }));
    const option = screen.getByRole("option", { name: "리뷰" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("b");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("only the top layer answers: a menu above a panel, then the panel", () => {
    const closed: string[] = [];
    function Stack() {
      const [panel, setPanel] = useState(true), [menu, setMenu] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      return <><button type="button">바깥</button>
        <AnchoredLayer open={panel} anchor={{ x: 10, y: 10 }} label="패널" onClose={reason => { closed.push(`panel:${reason}`); setPanel(false); }}>
          <button ref={trigger} type="button" onClick={() => setMenu(true)}>메뉴 열기</button>
          <Menu open={menu} anchor={trigger} label="메뉴" onClose={reason => { closed.push(`menu:${reason}`); setMenu(false); }}><MenuItem>하나</MenuItem></Menu>
        </AnchoredLayer></>;
    }
    render(<Stack />);
    fireEvent.click(screen.getByRole("button", { name: "메뉴 열기" }));
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "하나" }));
    expect(closed).toEqual([]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(closed).toEqual(["menu:escape"]);
    expect(screen.getByRole("dialog", { name: "패널" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "메뉴 열기" }));
    // A press inside the panel closes only the menu stacked above it.
    fireEvent.pointerDown(screen.getByRole("button", { name: "메뉴 열기" }).parentElement!);
    expect(closed).toEqual(["menu:escape", "menu:outside"]);
    fireEvent.pointerDown(screen.getByRole("button", { name: "바깥" }));
    expect(closed).toEqual(["menu:escape", "menu:outside", "panel:outside"]);
  });

  it("an Escape that closed a layer is not also a dialog's cancel", () => {
    render(<LegacyDialog onClose={() => {}} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "엔진" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "엔진" }), { key: "Escape" });
    expect(layerOwns(new Event("cancel"))).toBe(true);
  });
});

describe("AnchoredLayer (panels and forms)", () => {
  function Panel({ onClose }: { onClose: (reason: LayerCloseReason) => void }) {
    const [open, setOpen] = useState(true);
    return <><button type="button">다음</button>
      <AnchoredLayer open={open} anchor={{ x: 20, y: 20 }} label="태그" onClose={reason => { onClose(reason); setOpen(false); }}>
        <form><input aria-label="태그 이름" /><button type="submit">추가</button></form>
      </AnchoredLayer></>;
  }

  it("focuses the first field; Space and Tab keep their normal meaning", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "태그 이름" });
    expect(document.activeElement).toBe(input);
    const space = createEvent.keyDown(input, { key: " " });
    fireEvent(input, space);
    expect(space.defaultPrevented).toBe(false);
    const tab = createEvent.keyDown(input, { key: "Tab" });
    fireEvent(input, tab);
    expect(tab.defaultPrevented).toBe(false);
    screen.getByRole("button", { name: "추가" }).focus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when focus leaves it for the page", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    screen.getByRole("button", { name: "다음" }).focus();
    expect(onClose).toHaveBeenCalledWith("blur");
  });
});

describe("Select with a caller-owned search", () => {
  it("passes the query out and shows the options it is given as they are", () => {
    function Ranked() {
      const [query, setQuery] = useState("");
      const options = [{ value: "new", label: "새 프로젝트", icon: "plus" as const }, ...(query ? [{ value: "x", label: `찾은 ${query}`, group: "찾은 프로젝트 1" }] : [{ value: "r", label: "최근", group: "최근 프로젝트" }])];
      return <Select label="프로젝트" value="r" searchable filter={false} onQueryChange={setQuery} options={options} onChange={() => {}} />;
    }
    render(<Ranked />);
    fireEvent.click(screen.getByRole("button", { name: "프로젝트" }));
    fireEvent.change(screen.getByRole("combobox", { name: "프로젝트 찾기" }), { target: { value: "zz" } });
    expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["새 프로젝트", "찾은 zz"]);
    expect(screen.getByRole("group", { name: "찾은 프로젝트 1" })).toBeTruthy();
  });
});

describe("AnchoredLayer tab order (a form in a panel)", () => {
  function Host({ onClose, closeOnTabOut }: { onClose: (reason: LayerCloseReason) => void; closeOnTabOut?: boolean }) {
    const trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return <><button type="button">앞</button>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>태그 추가</button>
      <button type="button">다음</button>
      <AnchoredLayer open={open} anchor={trigger} label="태그" closeOnTabOut={closeOnTabOut} onClose={reason => { onClose(reason); setOpen(false); }}>
        <form><input aria-label="태그 이름" /><button type="submit">추가</button></form>
      </AnchoredLayer></>;
  }
  const openPanel = () => {
    const trigger = screen.getByRole("button", { name: "태그 추가" });
    trigger.focus();
    fireEvent.click(trigger);
    return trigger;
  };

  it("Tab past the last control goes on after the trigger and closes", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    openPanel();
    const add = screen.getByRole("button", { name: "추가" });
    add.focus();
    const tab = createEvent.keyDown(add, { key: "Tab" });
    fireEvent(add, tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "다음" }));
    expect(onClose).toHaveBeenCalledWith("tab");
    expect(screen.queryByRole("dialog", { name: "태그" })).toBeNull();
  });

  it("Shift+Tab before the first control goes back to the trigger and closes", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const trigger = openPanel();
    const input = screen.getByRole("textbox", { name: "태그 이름" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(trigger);
    expect(onClose).toHaveBeenCalledWith("tab");
  });

  it("Tab between controls inside stays inside; Tab on the trigger enters the panel", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} closeOnTabOut={false} />);
    const trigger = openPanel();
    const input = screen.getByRole("textbox", { name: "태그 이름" });
    const inner = createEvent.keyDown(input, { key: "Tab" });
    fireEvent(input, inner);
    expect(inner.defaultPrevented).toBe(false);
    trigger.focus();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(document.activeElement).toBe(input);
  });

  it("closeOnTabOut={false} moves on after the trigger but keeps the panel open", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} closeOnTabOut={false} />);
    openPanel();
    const add = screen.getByRole("button", { name: "추가" });
    add.focus();
    fireEvent.keyDown(add, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "다음" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "태그" })).toBeTruthy();
  });
});

describe("AnchoredLayer tab-out never loses focus", () => {
  function Host({ after }: { after: ReactNode }) {
    const trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return <><style>{".gone { display: none; }"}</style>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>태그 추가</button>
      {after}
      <AnchoredLayer open={open} anchor={trigger} label="태그" onClose={() => setOpen(false)}>
        <button type="button">추가</button>
      </AnchoredLayer></>;
  }
  const tabOut = () => {
    const trigger = screen.getByRole("button", { name: "태그 추가" });
    trigger.focus();
    fireEvent.click(trigger);
    const add = screen.getByRole("button", { name: "추가" });
    expect(document.activeElement).toBe(add);
    fireEvent.keyDown(add, { key: "Tab" });
    expect(screen.queryByRole("dialog", { name: "태그" })).toBeNull();
    return trigger;
  };
  const next = <button type="button">다음</button>;

  it.each([
    ["display:none by a class", <button type="button" className="gone">숨김</button>],
    ["inside a closed <details>", <details><summary>더 보기</summary><button type="button">접힌 단추</button></details>],
    ["visibility:hidden", <button type="button" style={{ visibility: "hidden" }}>안 보임</button>],
  ])("skips a next control hidden by %s", (_name, hidden) => {
    render(<Host after={<>{hidden}{next}</>} />);
    tabOut();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "다음" }));
  });

  it("tries the next candidate when focus() does not take (no layout in jsdom: a zero-size control)", () => {
    render(<Host after={<><button type="button" data-testid="flat">0px</button>{next}</>} />);
    Object.defineProperty(screen.getByTestId("flat"), "focus", { value: () => {} });
    tabOut();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "다음" }));
  });

  it("falls back to the trigger when nothing after it takes focus", () => {
    render(<Host after={<button type="button" className="gone">숨김</button>} />);
    const trigger = tabOut();
    expect(document.activeElement).toBe(trigger);
  });
});
