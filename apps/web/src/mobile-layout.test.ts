import { afterEach, describe, expect, it, vi } from "vitest";
import { compactInput } from "./mobile-layout.ts";

// Return makes a new line only on a touch screen; a narrow window under a mouse sends with Return as
// on the desktop (Hallmark merge U4/U5: input follows the pointer, never the window's width).
const media = (matching: (query: string) => boolean) => vi.stubGlobal("window", { matchMedia: (query: string) => ({ matches: matching(query), media: query }) });

describe("compactInput", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is off for a 760px window under a mouse", () => {
    media((query) => /max-width/.test(query) && !/pointer/.test(query));
    expect(compactInput()).toBe(false);
  });
  it("is on under a coarse pointer, whatever the width", () => {
    media((query) => /pointer: coarse/.test(query));
    expect(compactInput()).toBe(true);
  });
});
