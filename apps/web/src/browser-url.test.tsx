import { expect, it } from "vitest";
import { browserUrl } from "./browser-state.ts";

it("accepts blank tabs, addresses and ordinary searches from the same entry", () => {
  expect(browserUrl(" ")).toBe("about:blank");
  expect(browserUrl("about:blank")).toBe("about:blank");
  expect(browserUrl("google.com")).toBe("https://google.com/");
  expect(browserUrl("localhost:3000/test")).toBe("https://localhost:3000/test");
  expect(new URL(browserUrl("new york times")).searchParams.get("q")).toBe("new york times");
  expect(new URL(browserUrl("검색어")).searchParams.get("q")).toBe("검색어");
  for (const input of ["javascript:alert(1)", "file:///tmp/test", "about:config", "https://user:password@example.com"]) expect(() => browserUrl(input)).toThrow();
});
