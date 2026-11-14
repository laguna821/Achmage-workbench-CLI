// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Hig.tsx";

afterEach(() => cleanup());

const OPTIONS = [{ value: "a", label: "대화" }, { value: "b", label: "문서" }, { value: "c", label: "검토", disabled: true, title: "검토할 수정안이 없습니다" }] as const;

function Choice({ tabs = false }: { tabs?: boolean }) {
  const [value, setValue] = useState<"a" | "b" | "c">("b");
  return <Segmented label="보기" value={value} onChange={setValue} options={OPTIONS} tabs={tabs} />;
}

const group = () => screen.getByRole("radiogroup", { name: "보기" });
const indicator = () => group().querySelector<HTMLElement>(".hk-seg__indicator");

describe("Segmented", () => {
  it("draws one indicator placed on the chosen cell, and moves it when the choice changes", () => {
    render(<Choice />);
    expect(indicator()).not.toBeNull();
    expect(group().style.getPropertyValue("--_n")).toBe("3");
    expect(group().style.getPropertyValue("--_i")).toBe("1");
    fireEvent.click(screen.getByRole("radio", { name: "대화" }));
    expect(screen.getByRole("radio", { name: "대화" }).getAttribute("aria-checked")).toBe("true");
    expect(group().style.getPropertyValue("--_i")).toBe("0");
    expect(group().querySelectorAll(".hk-seg__indicator")).toHaveLength(1);
  });

  it("only slides after its first placement (no slide in from the left on mount)", async () => {
    vi.useFakeTimers();
    try {
      render(<Choice />);
      expect(group().hasAttribute("data-ready")).toBe(false);
      await act(async () => { vi.advanceTimersByTime(50); });
      expect(group().hasAttribute("data-ready")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips disabled cells by click and by arrow keys, and keeps their titles", () => {
    render(<Choice />);
    const disabled = screen.getByRole("radio", { name: "검토" });
    expect(disabled.getAttribute("title")).toBe("검토할 수정안이 없습니다");
    fireEvent.click(disabled);
    expect(group().style.getPropertyValue("--_i")).toBe("1");
    fireEvent.keyDown(screen.getByRole("radio", { name: "문서" }), { key: "ArrowRight" });
    expect(group().style.getPropertyValue("--_i")).toBe("0");
    expect(document.activeElement?.textContent).toBe("대화");
  });

  it("as tabs, says which tab is selected and still places the indicator", () => {
    render(<Choice tabs />);
    const list = screen.getByRole("tablist", { name: "보기" });
    expect(screen.getByRole("tab", { name: "문서" }).getAttribute("aria-selected")).toBe("true");
    expect(list.style.getPropertyValue("--_i")).toBe("1");
  });
});
