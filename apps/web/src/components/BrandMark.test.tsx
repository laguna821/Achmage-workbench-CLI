// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
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

// Home opens without a logo now (Hallmark merge): the top bar's mark makes the one entrance, under the
// same setting, and drops the flag once the arc has swept in (a width change does not replay it).
describe("useBrandGreeting (the top bar's mark)", () => {
  it("enters once per launch with the setting on, and stops after the arc's sweep", async () => {
    vi.resetModules();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
    const { useBrandGreeting } = await import("./BrandMark.tsx");
    const Mark = ({ motion }: { motion: boolean }) => {
      const [greet, done] = useBrandGreeting(motion);
      // jsdom has no AnimationEvent: the two ends are played as clicks carrying each animation's name.
      return <>
        <button type="button" className={`brand${greet ? " greet" : ""}`}>A</button>
        <button type="button" onClick={() => done({ animationName: "brand-rise" })}>rise</button>
        <button type="button" onClick={() => done({ animationName: "brand-sweep" })}>sweep</button>
      </>;
    };
    const view = render(<Mark motion />);
    const mark = view.getByRole("button", { name: "A" });
    expect(mark.classList.contains("greet")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "rise" }));
    expect(mark.classList.contains("greet")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "sweep" }));
    expect(mark.classList.contains("greet")).toBe(false);
    view.unmount();
    expect(render(<Mark motion />).getByRole("button", { name: "A" }).classList.contains("greet")).toBe(false);
  });
  it("stays still with the setting off", async () => {
    vi.resetModules();
    const { useBrandGreeting } = await import("./BrandMark.tsx");
    const Mark = () => <span className={useBrandGreeting(false)[0] ? "greet" : ""}>A</span>;
    expect(render(<Mark />).getByText("A").classList.contains("greet")).toBe(false);
  });
});

