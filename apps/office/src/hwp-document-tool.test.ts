import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createHangulDocumentSkill, HANGUL_TOOL } from "./hwp-document-tool.ts";
import { patchOfficeExecution } from "../execution-patch.ts";
import { IEUM_HWP_DIR } from "../../../scripts/ieum-earlier-source.mjs";

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

it("two kinds in the one tool: general (Markdown + a template, the default) and hallym (forms); the steps that only read are not errors", async () => {
  const skill = createHangulDocumentSkill(() => ({ make: async (input) => input.markdown
    ? { made: true, kind: "general" as const, template: "기본", artifactId: "g1", name: "안내.hwpx" }
    : input.source ? { made: false, kind: "general" as const, status: "source-markdown" } : { made: false, kind: "general" as const, status: "write-markdown" } }), () => true, () => {});
  const schema = skill.tools[0].inputSchema as { properties: Record<string, { enum?: string[] }> };
  expect(schema.properties.kind.enum).toEqual(["general", "hallym"]);
  expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["markdown", "template", "source"]));
  expect(skill.systemPrompt).toContain('kind "general"이 기본');
  expect(skill.systemPrompt).toContain("source-markdown");
  expect(await skill.executeTool({ id: "c", name: HANGUL_TOOL, input: { prompt: "안내문", kind: "general", markdown: "# 안내" } })).toMatchObject({ summary: "한글 문서 만들기 · 안내.hwpx (기본 서식)" });
  const listed = await skill.executeTool({ id: "c", name: HANGUL_TOOL, input: { prompt: "한국언론학회 서식으로" } });
  expect(listed).toMatchObject({ summary: "한글 문서 만들기 · 서식 목록 읽음" }); expect(listed.isError).toBeFalsy();
  const read = await skill.executeTool({ id: "c", name: HANGUL_TOOL, input: { prompt: "첨부로", source: "자료.docx" } });
  expect(read).toMatchObject({ summary: "한글 문서 만들기 · 첨부 파일을 Markdown으로 읽음" }); expect(read.isError).toBeFalsy();
});

it("a runner failure is a line the person can read", async () => {
  const skill = createHangulDocumentSkill(() => ({ make: async () => { throw new Error("실행기가 응답하지 않습니다"); } }), () => true, () => {});
  const result = await skill.executeTool({ id: "c", name: HANGUL_TOOL, input: { prompt: "x" } });
  expect(result).toMatchObject({ isError: true, summary: "한글 문서 만들기 · 실행기가 응답하지 않습니다" });
});

it("the Hangul panel patch: no inert lock, the chip on by default, the tool in its skill set", () => {
  const root = resolve(IEUM_HWP_DIR), id = `${root}/apps/hwp/src/renderer/ai/AiPanel.tsx`;
  const code = patchOfficeExecution(readFileSync(id, "utf8"), id, root, "/workbench/execution-adapter.ts");
  expect(code).not.toContain("workbenchLockDocument('.hwp-stage");
  expect(code).toContain("workbenchHwpHold?.lock(locked)");
  expect(code).toContain('from "/workbench/hwp-document-tool.ts"');
  expect(code).toMatch(/skills\.composer\?\.onPick\(\{ \.\.\.wbHallymItem, hasScripts: false \}\)/);
  expect(code).toMatch(/createFilesSkill\(\(\) => availableAttachmentsRef\.current\(\)\),\n\s+wbCreateHangulDocumentSkill\(/);
});
