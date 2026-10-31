import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { UserSkills } from "./user-skills.ts";
import { bundledHallymSkill } from "./hallym-kordoc.ts";
import { createGuide } from "./create.ts";
import { hangulPages } from "./hwp-pages.mjs";
import { hwpToText } from "../../../third_party/ieumoffice/file-parse/hwp.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "wb-hallym-")); roots.push(root);
  const state = new Map<string, string>();
  const skills = new UserSkills({ getMeta: key => state.get(key) ?? null, setMeta: (key, value) => { state.set(key, value); } }, { dataDir: join(root, "data"), homeDir: join(root, "home") });
  return { root, skills };
}

it("provides the approved default without copying it to either CLI home; respects an installed disabled winner", async () => {
  const { root, skills } = setup();
  const builtin = (await skills.list()).find(skill => skill.name === "hallym-kordoc")!;
  expect(builtin).toMatchObject({ source: "builtin", state: { enabled: true, invoke: "auto" }, shadowedBy: null });
  expect(existsSync(join(root, "home"))).toBe(false);
  const native = join(root, "home/.codex/skills/hallym-kordoc"); mkdirSync(native, { recursive: true });
  const text = "---\nname: hallym-kordoc\ndescription: My custom Hangul skill\n---\nCUSTOM\n";
  writeFileSync(join(native, "SKILL.md"), text);
  const installed = (await skills.list({ provider: "codex" })).find(skill => skill.source === "codex")!;
  await skills.setState(installed.id, { enabled: false, invoke: "manual" });
  const all = await skills.list({ provider: "codex" });
  expect(all.find(skill => skill.source === "builtin")?.shadowedBy).toBe(installed.id);
  expect(all.some(skill => !skill.shadowedBy && skill.state.enabled)).toBe(false);
  expect(readFileSync(join(native, "SKILL.md"), "utf8")).toBe(text);
});

it("creates ordinary HWPX with the public skill and renders it through Ieum, without invented affiliation", async () => {
  const { root } = setup(), skill = bundledHallymSkill()!;
  const guide = createGuide({ format: "hwpx", name: "회의" }, join(root, "회의.hwpx"), root, { ieum: null, kordoc: null, hallymSkill: skill });
  expect(guide).toContain(join(skill, "SKILL.md"));
  expect(guide).toContain("일반 문서에 한림대 소속이나 기관 양식을 강제하지 마세요");
  const request = join(root, "request.json"), outputDir = join(root, "output");
  writeFileSync(request, JSON.stringify({ schemaVersion: 1, mode: "generate", markdown: "# 협업 보고서\n\n실제 한글 생성과 이음 표시를 확인합니다.\n\n| 항목 | 결과 |\n| --- | --- |\n| 문서 | 보존 |\n", outputDir }));
  const result = JSON.parse(execFileSync(process.execPath, [join(skill, "core/scripts/run.mjs"), request], { encoding: "utf8", env: { ...process.env, KORDOC_OFFLINE: "1" } }));
  expect(result.status).toBe("success");
  const file = join(outputDir, "document.hwpx"), bytes = readFileSync(file);
  const text = await hwpToText(bytes);
  expect(text).toContain("실제 한글 생성"); expect(text).not.toContain("한림");
  const pages = await hangulPages(file, "hwpx");
  expect(pages.length).toBeGreaterThan(0);
  expect(pages[0]).toMatchObject({ page: 1, width: expect.any(Number), height: expect.any(Number) });
  expect(pages[0]!.svg).toContain("<svg");
  expect(readFileSync(file)).toEqual(bytes);
});
