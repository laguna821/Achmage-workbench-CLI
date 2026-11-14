// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeBrand } from "./BrandMark.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// "홈 로고 움직임": the home logo makes one short entrance per launch, only when the setting is on.
describe("HomeBrand", () => {
  it("stays still with the setting off, enters once with it on, then stays still", () => {
    const off = render(<HomeBrand motion={false} />);
    expect(off.getByRole("img", { name: "Achmage" }).closest(".home-brand")?.classList.contains("greet")).toBe(false);
    off.unmount();

    const on = render(<HomeBrand motion />);
    expect(on.container.querySelector(".home-brand")?.classList.contains("greet")).toBe(true);
    on.unmount();

    const again = render(<HomeBrand motion />);
    expect(again.container.querySelector(".home-brand")?.classList.contains("greet")).toBe(false);
  });
});

// Reduced motion: the logo is simply there from the first frame (no entrance, no delay).
describe("HomeBrand under reduced motion", () => {
  it("shows the logo still on the first launch, even with the setting on", async () => {
    vi.resetModules();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, addEventListener() {}, removeEventListener() {} }));
    const { HomeBrand: Fresh } = await import("./BrandMark.tsx");
    const view = render(<Fresh motion />);
    expect(view.container.querySelector(".home-brand")?.classList.contains("greet")).toBe(false);
    expect(view.getByRole("img", { name: "Achmage" })).toBeTruthy();
  });
});

// One wordmark per screen: the hero tells its owner while it is on screen, so the top bar can step back.
describe("HomeBrand presence", () => {
  it("reports itself shown while mounted, once, and gone when it leaves", () => {
    const seen: boolean[] = [];
    const view = render(<HomeBrand motion={false} onShown={(shown) => seen.push(shown)} />);
    view.rerender(<HomeBrand motion={false} onShown={(shown) => seen.push(shown)} />);
    expect(seen).toEqual([true]);
    view.unmount();
    expect(seen).toEqual([true, false]);
  });
});
