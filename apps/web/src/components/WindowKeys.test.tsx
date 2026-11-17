// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowKeys, readWindowKeysPref, useWindowShell, windowKeysNote, windowKeysShown, type WindowShell } from "./WindowKeys.tsx";

afterEach(cleanup);
const niri: WindowShell = { desktop: "niri", tiling: true, minimize: "tray", fullscreen: false };
const gnome: WindowShell = { desktop: "GNOME", tiling: false, minimize: "minimize", fullscreen: false };

describe("창 단추", () => {
  it("자동 shows them on a tiling desktop only; 항상 / 숨김 decide; never outside the app", () => {
    expect(windowKeysShown("auto", niri)).toBe(true);
    expect(windowKeysShown("auto", gnome)).toBe(false);
    expect(windowKeysShown("always", gnome)).toBe(true);
    expect(windowKeysShown("hidden", niri)).toBe(false);
    expect(windowKeysShown("always", null)).toBe(false);
    expect(readWindowKeysPref(undefined)).toBe("auto");
    expect(readWindowKeysPref("hidden")).toBe("hidden");
    expect(readWindowKeysPref("x")).toBe("auto");
    expect(windowKeysNote(niri)).toContain("트레이로 숨깁니다");
    expect(windowKeysNote(gnome)).toContain("자동이면 숨깁니다");
  });

  it("three named keys; full screen says 원래 크기로 while on; no 내려놓기 where it cannot come back", () => {
    const onAct = vi.fn();
    const view = render(<WindowKeys shell={niri} onAct={onAct} />);
    const keys = within(view.container);
    fireEvent.click(keys.getByRole("button", { name: "내려놓기" }));
    fireEvent.click(keys.getByRole("button", { name: "전체 화면" }));
    fireEvent.click(keys.getByRole("button", { name: "닫기" }));
    expect(onAct.mock.calls.map(([action]) => action)).toEqual(["minimize", "fullscreen", "close"]);
    view.rerender(<WindowKeys shell={{ ...niri, fullscreen: true }} onAct={onAct} />);
    expect(keys.getByRole("button", { name: "원래 크기로" })).toBeTruthy();
    view.rerender(<WindowKeys shell={{ ...niri, minimize: "none" }} onAct={onAct} />);
    expect(keys.queryByRole("button", { name: "내려놓기" })).toBeNull();
  });

  it("asks the shell once in the desktop app, not in a browser, and follows the answer of an action", async () => {
    const invoke = vi.fn(async (action: string) => ({ ...niri, fullscreen: action === "fullscreen" }));
    const browser = renderHook(() => useWindowShell(false, invoke));
    expect(browser.result.current.shell).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    const app = renderHook(() => useWindowShell(true, invoke));
    await waitFor(() => expect(app.result.current.shell?.desktop).toBe("niri"));
    await act(async () => { app.result.current.act("fullscreen"); });
    await waitFor(() => expect(app.result.current.shell?.fullscreen).toBe(true));
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(["state", "fullscreen"]);
  });
});
