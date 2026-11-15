// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import Reader from "./Reader.tsx";

// Re-review 1, next round 5: the reader's head said "r1" (the app's word is "1판"), and Esc out of it
// left the focus on BODY instead of on what opened it.
const artifact = { id: "a1", name: "강의안.md", format: "markdown", revision: 3, workId: "w1", path: "강의안.md", updatedAt: 0 } as unknown as Artifact;
const api = { artifactText: vi.fn(async () => ({ text: "# 제목\n\n본문" })) } as unknown as Api;
const state = { tools: {} } as unknown as State;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("읽기", () => {
  it("names the version in the app's word (3판), and its name without a middle dot", () => {
    render(<Reader api={api} state={state} artifact={artifact} start={{ page: null, fraction: 0 }} onClose={() => undefined} />);
    const head = document.querySelector(".reader-bar")!;
    expect(head.textContent).toContain("3판");
    expect(head.textContent).not.toMatch(/\br3\b/);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("강의안.md 읽기");
  });

  it("Esc closes it and the focus goes back to what opened it", async () => {
    const opener = document.createElement("button");
    opener.textContent = "읽기";
    document.body.append(opener);
    opener.focus();
    let open = true;
    const onClose = vi.fn(() => { open = false; });
    const view = render(<Reader api={api} state={state} artifact={artifact} start={{ page: null, fraction: 0 }} onClose={onClose} />);
    // The reader takes the keys (its close key holds the focus while it is open).
    expect(document.activeElement).not.toBe(opener);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(open).toBe(false);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  // Tech review 4 (MINOR): aria-modal, so Tab stays inside; its page keys never eat what a field takes.
  it("keeps Tab inside: from its last key Tab goes to its first, Shift+Tab from the first to the last", async () => {
    const outside = document.createElement("button"); outside.textContent = "뒤의 키"; document.body.append(outside);
    try {
      render(<Reader api={api} state={state} artifact={artifact} start={{ page: null, fraction: 0 }} onClose={() => undefined} />);
      await act(async () => undefined);
      const dialog = screen.getByRole("dialog");
      const keys = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      expect(keys.length).toBeGreaterThan(0);
      keys.at(-1)!.focus();
      // The browser's own Tab would leave for the app beneath: the reader takes it (not default) and moves inside.
      expect(fireEvent.keyDown(keys.at(-1)!, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(keys[0]);
      expect(fireEvent.keyDown(keys[0]!, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(keys.at(-1));
    } finally { outside.remove(); }
  });

  it("does not take Space or the arrows typed in a field or on a key", async () => {
    const field = document.createElement("input"); document.body.append(field);
    try {
      render(<Reader api={api} state={state} artifact={artifact} start={{ page: null, fraction: 0 }} onClose={() => undefined} />);
      await act(async () => undefined);
      for (const key of [" ", "ArrowLeft", "ArrowRight", "Home", "End"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        field.dispatchEvent(event);
        expect(event.defaultPrevented, key).toBe(false);
      }
      const close = screen.getAllByRole("button")[0]!;
      const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      close.dispatchEvent(space);
      expect(space.defaultPrevented).toBe(false);
    } finally { field.remove(); }
  });
});
