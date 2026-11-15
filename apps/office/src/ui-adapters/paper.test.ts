import { expect, it } from "vitest";
import { keepPaperWhite } from "./paper.ts";

const store = (entries: [string, string][] = []) => {
  const map = new Map(entries);
  return { map, storage: { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) } };
};

it("keeps a Word page white paper in the dark theme unless the person chose the dark page", () => {
  const fresh = store();
  keepPaperWhite(fresh.storage);
  expect(fresh.map.get("aidocs.darkPage")).toBe("0");
  // The person's own choice (보기 › 어둡게 보기), either way, stays.
  for (const chosen of ["1", "0"]) {
    const kept = store([["aidocs.darkPage", chosen], ["other", "x"]]);
    keepPaperWhite(kept.storage);
    expect([...kept.map]).toEqual([["aidocs.darkPage", chosen], ["other", "x"]]);
  }
  // No storage: nothing breaks, the editor keeps its default.
  expect(() => keepPaperWhite({ getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } })).not.toThrow();
});

it("names the key Ieum's Word editor reads", async () => {
  const { readFileSync } = await import("node:fs");
  expect(readFileSync("vendor/ieumoffice/apps/docs/src/renderer/dark-page-pref.ts", "utf8")).toContain("DARK_PAGE_KEY = 'aidocs.darkPage'");
});
