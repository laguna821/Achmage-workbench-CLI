import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createHangulDocumentSkill, HANGUL_TOOL } from "./hwp-document-tool.ts";
import { patchOfficeExecution } from "../execution-patch.ts";

it("the tool is there only while the request carries hallym-kordoc (removing the chip turns it off for that request)", async () => {
  let on = true;
  const make = vi.fn(async () => ({ made: true, artifactId: "a1", name: "안내.hwpx", draft: true }));
  const opened: string[] = [];
  const skill = createHangulDocumentSkill(() => ({ make }), () => on, (id) => opened.push(id));
  expect(skill.tools.map((tool) => tool.name)).toEqual([HANGUL_TOOL]);
  expect(skill.systemPrompt).toContain("작은 편집");
  expect(skill.systemPrompt).toContain("한림대학교 소속");
  const result = await skill.executeTool({ id: "c", name: HANGUL_TOOL, input: { prompt: "공문서 하나 만들어줘" } });
  expect(result).toMatchObject({ summary: "한글 문서 만들기 · 안내.hwpx (초안)" });
  expect(result.isError).toBeFalsy();
  expect(opened).toEqual(["a1"]);
  on = false;
  expect(skill.tools).toEqual([]); expect(skill.systemPrompt).toBe("");
});

it("a runner failure is a line the person can read", async () => {
  const skill = createHangulDocumentSkill(() => ({ make: async () => { throw new Error("실행기가 응답하지 않습니다"); } }), () => true, () => {});
  const result = await skill.executeTool({ id: "c", name: HANGUL_TOOL, input: { prompt: "x" } });
  expect(result).toMatchObject({ isError: true, summary: "한글 문서 만들기 · 실행기가 응답하지 않습니다" });
});

it("the Hangul panel patch: no inert lock, the chip on by default, the tool in its skill set", () => {
  const root = resolve("vendor/ieumoffice"), id = `${root}/apps/hwp/src/renderer/ai/AiPanel.tsx`;
  const code = patchOfficeExecution(readFileSync(id, "utf8"), id, root, "/workbench/execution-adapter.ts");
  expect(code).not.toContain("workbenchLockDocument('.hwp-stage");
  expect(code).toContain("workbenchHwpHold?.lock(locked)");
  expect(code).toContain('from "/workbench/hwp-document-tool.ts"');
  expect(code).toMatch(/skills\.composer\?\.onPick\(\{ \.\.\.wbHallymItem, hasScripts: false \}\)/);
  expect(code).toMatch(/createFilesSkill\(\(\) => availableAttachmentsRef\.current\(\)\),\n\s+wbCreateHangulDocumentSkill\(/);
});
