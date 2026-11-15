// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMemory } from "@workbench/contracts";
import { MemoryReadout, useAppMemory } from "./MemoryReadout.tsx";
import { UsageLine } from "./UsageCard.tsx";
import { AppearancePanel } from "./AppearanceSheet.tsx";
import { DEFAULT_APPEARANCE, readAppearance, AppearanceContext, type AppearanceApi } from "../appearance.ts";
import { readMemoryShown } from "../theme.ts";

// 0.5.1 "memline": the app's memory, small and muted at the right end of the window's bottom line.

const MB = 1024 * 1024;
const memory = { known: true as const, totalBytes: 512 * MB, windowBytes: 312 * MB, toolsBytes: 1536 * MB, gatewayBytes: 80 * MB, measure: "pss" as const, at: 1 };
const parts = () => [...document.querySelectorAll(".memory-pop .memory-parts > div")].map((row) => [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent]);

let visibility = "visible";
let focused = true;
beforeEach(() => {
  visibility = "visible"; focused = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the readout", () => {
  it("reads 메모리 0.5 GB; the sleeping tabs follow it only when there are some", () => {
    const view = render(<MemoryReadout memory={memory} />);
    expect(document.querySelector(".memory-readout-text")!.textContent).toBe("메모리 0.5 GB");
    view.rerender(<MemoryReadout memory={memory} sleeping={0} />);
    expect(document.querySelector(".memory-readout-text")!.textContent).toBe("메모리 0.5 GB");
    view.rerender(<MemoryReadout memory={memory} sleeping={3} />);
    expect(document.querySelector(".memory-readout-text")!.textContent).toBe("메모리 0.5 GB · 쉬는 탭 3");
    view.rerender(<MemoryReadout memory={{ ...memory, totalBytes: 2254 * MB }} />);
    expect(document.querySelector(".memory-readout-text")!.textContent).toBe("메모리 2.2 GB");
  });

  it("hover shows the three parts in one small popover, and leaving takes it away", () => {
    render(<MemoryReadout memory={memory} />);
    expect(document.querySelector(".memory-pop")).toBeNull();
    fireEvent.mouseEnter(document.querySelector(".memory-readout")!);
    expect(parts()).toEqual([["창", "312 MB"], ["AI 엔진과 도구", "1.5 GB"], ["게이트웨이", "80 MB"]]);
    expect(screen.getByRole("tooltip").classList.contains("popover")).toBe(true);
    // No sleeping-tabs line when the app does not rest tabs (the prop is not given).
    expect(screen.getByRole("tooltip").textContent).not.toContain("쉬게");
    fireEvent.mouseLeave(document.querySelector(".memory-readout")!);
    expect(document.querySelector(".memory-pop")).toBeNull();
  });

  it("focus shows it too (the text is reachable by keyboard and described by the popover); Escape and leaving close it", () => {
    render(<MemoryReadout memory={memory} sleeping={0} />);
    const text = document.querySelector<HTMLElement>(".memory-readout-text")!;
    expect(text.tabIndex).toBe(0);
    act(() => text.focus());
    const pop = screen.getByRole("tooltip");
    expect(text.getAttribute("aria-describedby")).toBe(pop.id);
    // The prop is given (even 0): the popover's last line says what happens to tabs out of sight.
    expect(pop.lastElementChild!.textContent).toBe("지금 보이지 않는 탭은 10분 뒤 쉬게 합니다");
    fireEvent.keyDown(text, { key: "Escape" });
    expect(document.querySelector(".memory-pop")).toBeNull();
    act(() => text.blur());
    act(() => text.focus());
    expect(document.querySelector(".memory-pop")).toBeTruthy();
    act(() => text.blur());
    expect(document.querySelector(".memory-pop")).toBeNull();
  });
});

describe("refreshing", () => {
  function Probe({ read }: { read: (() => Promise<AppMemory>) | null }) {
    const value = useAppMemory(read);
    return <output>{value ? value.totalBytes / MB : "none"}</output>;
  }
  const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const shown = () => document.querySelector("output")!.textContent;

  it("reads at once, then every 30 s while the window is visible and focused", async () => {
    vi.useFakeTimers();
    let total = 500;
    const read = vi.fn(async (): Promise<AppMemory> => ({ ...memory, totalBytes: total++ * MB }));
    render(<Probe read={read} />);
    await settle();
    expect([read.mock.calls.length, shown()]).toEqual([1, "500"]);
    await settle(29_000);
    expect(read).toHaveBeenCalledTimes(1);
    await settle(1_000);
    expect([read.mock.calls.length, shown()]).toEqual([2, "501"]);
    await settle(60_000);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("does not read while the window is hidden or another window has the focus; back in front it reads when 30 s have passed", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (): Promise<AppMemory> => memory);
    render(<Probe read={read} />);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    visibility = "hidden"; focused = false;
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.blur(window);
    await settle(300_000);
    expect(read).toHaveBeenCalledTimes(1);
    // Visible again but another window has the focus: still nothing.
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await settle(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    focused = true;
    fireEvent.focus(window);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    // A short look away and back: the next read waits for its 30 s.
    focused = false; fireEvent.blur(window);
    await settle(5_000);
    focused = true; fireEvent.focus(window);
    await settle(24_000);
    expect(read).toHaveBeenCalledTimes(2);
    await settle(1_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("a hidden window does not read at all, not even first; one in sight without the focus reads once", async () => {
    vi.useFakeTimers();
    visibility = "hidden"; focused = false;
    const read = vi.fn(async (): Promise<AppMemory> => memory);
    render(<Probe read={read} />);
    await settle(120_000);
    expect(read).not.toHaveBeenCalled();
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await settle(120_000);
    expect([read.mock.calls.length, shown()]).toEqual([1, "512"]);
  });

  it("shows nothing when the gateway does not know, when the call fails, and when it is turned off", async () => {
    vi.useFakeTimers();
    let answer: () => Promise<AppMemory> = async () => ({ known: false });
    const read = vi.fn(() => answer());
    const view = render(<Probe read={read} />);
    await settle();
    expect([read.mock.calls.length, shown()]).toEqual([1, "none"]);
    answer = async () => memory;
    await settle(30_000);
    expect(shown()).toBe("512");
    answer = async () => { throw new Error("gateway away"); };
    await settle(30_000);
    expect(shown()).toBe("none");
    answer = async () => memory;
    await settle(30_000);
    expect(shown()).toBe("512");
    view.rerender(<Probe read={null} />);
    await settle(90_000);
    expect([read.mock.calls.length, shown()]).toEqual([4, "none"]);
  });
});

describe("the window's bottom line", () => {
  const providers = { claude: { provider: "claude", installed: true, loggedIn: true, billingVars: [], usage: [{ label: "5시간", usedPercent: 12, resetsAt: null }] } } as never;

  it("with the usage limits: the readout is the line's last thing, after the limits", () => {
    render(<UsageLine providers={providers} onRefresh={async () => undefined} end={<MemoryReadout memory={memory} />} />);
    const line = document.querySelector(".usage-line")!;
    expect(line.querySelector(".usage-line-key .usage-window")).toBeTruthy();
    expect(line.lastElementChild!.classList.contains("memory-readout")).toBe(true);
    expect(document.querySelectorAll(".usage-line")).toHaveLength(1);
  });

  it("without the usage limits: the line holds only the readout; without either there is no line", () => {
    const view = render(<UsageLine providers={{}} onRefresh={async () => undefined} end={<MemoryReadout memory={memory} />} />);
    const line = document.querySelector(".usage-line")!;
    expect(line.children).toHaveLength(1);
    expect(line.textContent).toBe("메모리 0.5 GB");
    expect(line.getAttribute("aria-label")).toBe("메모리");
    view.rerender(<UsageLine providers={{}} onRefresh={async () => undefined} end={null} />);
    expect(document.querySelector(".usage-line")).toBeNull();
  });
});

describe("설정 › 화면 › 메모리 표시", () => {
  it("an old record is on; only a stored 끄기 is off", () => {
    expect([readMemoryShown(undefined), readMemoryShown(null), readMemoryShown("x"), readMemoryShown(true), readMemoryShown(false)]).toEqual([true, true, true, true, false]);
  });

  it("켜기 / 끄기, 켜기 chosen first; choosing 끄기 stores it", () => {
    const onMemoryShown = vi.fn();
    const api = { appearance: readAppearance({ ...DEFAULT_APPEARANCE, v: 8 }), appTheme: "light", updateLook: vi.fn(), setMode: vi.fn(), resetLook: vi.fn(), lookOf: () => DEFAULT_APPEARANCE.claude.light } as unknown as AppearanceApi;
    render(<AppearanceContext.Provider value={api}><AppearancePanel target={{ provider: "claude", theme: "light" }} onTarget={() => {}} themePref="system" onThemePref={() => {}} onMemoryShown={onMemoryShown} /></AppearanceContext.Provider>);
    const group = screen.getByRole("radiogroup", { name: "메모리 표시" });
    const cells = within(group).getAllByRole("radio");
    expect(cells.map((cell) => [cell.textContent, cell.getAttribute("aria-checked")])).toEqual([["켜기", "true"], ["끄기", "false"]]);
    fireEvent.click(cells[1]!);
    expect(onMemoryShown).toHaveBeenCalledWith(false);
  });
});
