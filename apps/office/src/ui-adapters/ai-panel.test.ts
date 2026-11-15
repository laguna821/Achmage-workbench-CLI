import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { EDITOR_AI_PANEL_KEYS, keepEditorAiPanelClosed } from "./ai-panel.ts";

// Design review I7: a new person meets ONE AI on a document (the head's 문서 AI). The editors' own
// "AI 도우미" panel starts closed; its rail key stays the entry; a stored choice is never changed.
const store = (entries: [string, string][] = []) => {
  const map = new Map(entries);
  return { map, storage: { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) } };
};

it("starts every editor's own AI panel closed on a new install", () => {
  const fresh = store();
  keepEditorAiPanelClosed(fresh.storage);
  for (const key of EDITOR_AI_PANEL_KEYS) expect(fresh.map.get(key), key).toBe("0");
});

it("keeps the person's own choice, open or closed, and touches nothing else", () => {
  const kept = store([["aidocs.showAi", "1"], ["mdapp.showAi", "0"], ["other", "x"]]);
  keepEditorAiPanelClosed(kept.storage);
  expect(kept.map.get("aidocs.showAi")).toBe("1");
  expect(kept.map.get("mdapp.showAi")).toBe("0");
  expect(kept.map.get("other")).toBe("x");
  expect(() => keepEditorAiPanelClosed({ getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } })).not.toThrow();
});

it("names the keys the editors read", () => {
  const read = (path: string) => readFileSync(`vendor/ieumoffice/apps/${path}`, "utf8");
  expect(read("docs/src/renderer/App.tsx")).toContain("aiPanelInitiallyOpen('aidocs.showAi')");
  expect(read("slides/src/renderer/App.tsx")).toContain("aiPanelInitiallyOpen('ai-slides-show-ai')");
  expect(read("sheets/src/renderer/ExcelShell.tsx")).toContain("aiPanelInitiallyOpen('ai-sheets-show-ai')");
  expect(read("markdown/src/renderer/App.tsx")).toContain("aiPanelInitiallyOpen('mdapp.showAi')");
  expect(read("html/src/renderer/App.tsx")).toContain("aiPanelInitiallyOpen('htmlapp.showAi')");
  expect(read("pdf/src/renderer/App.tsx")).toContain("aiPanelInitiallyOpen('genoffice-pdf-show-ai')");
});

it("is seeded by every editor's entry before the editor starts", () => {
  expect(readFileSync("apps/office/src/ui-adapters/connect.ts", "utf8")).toMatch(/keepEditorAiPanelClosed\(localStorage\)/);
});

it("in a narrow pane the open panel lies over the page instead of squeezing it (every editor but Hangul, which already does)", () => {
  const css = readFileSync("apps/office/src/ui-adapters/chrome.css", "utf8");
  const narrow = css.slice(css.indexOf("@media (max-width: 1039px)"));
  expect(narrow).toMatch(/\.app-main > \.ai-dock:not\(\.collapsed\) \{\s*position: absolute;/);
  expect(narrow).toMatch(/\.sheet-body > \.copilot:not\(\.collapsed\) \{\s*position: absolute;/);
});
