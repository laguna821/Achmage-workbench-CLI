import { expect, it } from "vitest";
import { classifyLines, mapTitleRanges, segmentLine, parseKeySpec, keyLabel } from "../../../third_party/fast-find/adapter/ui.ts";

it("maps Korean decomposed titles and emoji back to their complete display graphemes", () => {
  const title = "📝 " + "가나다".normalize("NFD") + " café";
  const ranges = mapTitleRanges(title, "가나다 cafe", [[0, 3], [4, 8]]);
  expect(ranges.map(([a, b]) => title.slice(a, b))).toEqual(["가나다".normalize("NFD"), "café"]);
  const parts = segmentLine("📝 " + "가나다".normalize("NFD") + " #평가", ["가나"], { marks: 20, styles: 20 }, false);
  expect(parts.filter(part => part.mark).map(part => part.text)).toEqual(["가나".normalize("NFD")]);
});

it("preserves code fences and bounds long lines without splitting a surrogate pair", () => {
  expect(classifyLines(["# 제목", "```", "# 코드", "```", "## 본문"]).map(line => line.kind)).toEqual(["h1", "code", "code", "code", "h2"]);
  const parts = segmentLine("x".repeat(1999) + "📝" + "y".repeat(20), ["xx"], { marks: 3, styles: 3 }, false);
  expect(parts.filter(part => part.mark)).toHaveLength(3);
  expect(parts.map(part => part.text).join("")).not.toMatch(/[\uD800-\uDBFF]…$/);
  expect(parseKeySpec("Mod+Alt+Enter")).toEqual({ modifiers: ["Mod", "Alt"], key: "Enter" });
  expect(keyLabel("Alt+Enter", true)).toBe("⌥⏎");
});
