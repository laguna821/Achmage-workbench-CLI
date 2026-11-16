import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { UserSkills } from "./user-skills.ts";
import { bundledHallymSkill } from "./hallym-kordoc.ts";
import { effectiveHallym, hangulInput, madePath, makeHangulDocument } from "./hangul-document.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "wb-hangul-doc-")); roots.push(root);
  const state = new Map<string, string>();
  const skills = new UserSkills({ getMeta: key => state.get(key) ?? null, setMeta: (key, value) => { state.set(key, value); } }, { dataDir: join(root, "data"), homeDir: join(root, "home") });
  return { root, skills };
}

it("default rule: the bundled hallym-kordoc answers in every Hangul document unless disabled; an installed copy keeps its precedence", async () => {
  const { root, skills } = setup();
  const first = effectiveHallym(await skills.list());
  expect("skill" in first && first.skill.source).toBe("builtin");
  expect("skill" in first && first.skill.dir).toBe(bundledHallymSkill());
  // The person turns it off in 설정 › 스킬: nothing runs.
  const builtin = (await skills.list()).find(skill => skill.name === "hallym-kordoc")!;
  await skills.setState(builtin.id, { enabled: false, invoke: "auto" });
  expect(effectiveHallym(await skills.list())).toEqual({ refused: "disabled" });
  await skills.setState(builtin.id, { enabled: true, invoke: "auto" });
  // Their own installed copy shadows it: that copy answers (here it has no runner, so it says so — the bundled one is NOT run behind it).
  const native = join(root, "home/.codex/skills/hallym-kordoc"); mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "SKILL.md"), "---\nname: hallym-kordoc\ndescription: mine\n---\nMINE\n");
  expect(effectiveHallym(await skills.list({ provider: "codex" }))).toEqual({ refused: "no-runner" });
  mkdirSync(join(native, "scripts")); writeFileSync(join(native, "scripts/run.mjs"), "");
  const mine = effectiveHallym(await skills.list({ provider: "codex" }));
  expect("skill" in mine && mine.skill.source).toBe("codex");
});

it("never names the made document over an existing file", () => {
  const taken = new Set(["/p/회의 안내.hwpx", "/p/회의 안내 (2).hwpx"]);
  expect(madePath("/p", "회의 안내", path => taken.has(path))).toBe("/p/회의 안내 (3).hwpx");
  expect(madePath("/p", "a/b:c.hwp", () => false)).toBe("/p/a b c.hwpx");
  expect(madePath("/p", "  ", () => false)).toBe("/p/새 한글 문서.hwpx");
});

it("refuses malformed input", () => {
  expect(() => hangulInput({})).toThrow();
  expect(() => hangulInput({ prompt: "x", values: { a: 1 } })).toThrow();
  expect(hangulInput({ prompt: "공문서", sections: { 개요: "본문" } }).prompt).toBe("공문서");
});

it("the runner really runs: form first, then a new HWPX beside the open document (the open one untouched), a labelled draft", async () => {
  const { root } = setup(), skill = bundledHallymSkill()!;
  const folder = join(root, "project"); mkdirSync(folder);
  const open = join(folder, "열린 문서.hwpx"); writeFileSync(open, "ORIGINAL");
  const tracked: string[] = [];
  const target = { documentPath: open, track: (path: string) => { tracked.push(path); return "made-1"; } };
  const form = await makeHangulDocument(skill, { prompt: "공문서 하나 만들어줘" }, target);
  expect(form).toMatchObject({ made: false, status: "form", familyId: "report.hallym" });
  expect((form as { form: { sections: string[] } }).form.sections.length).toBeGreaterThan(0);
  expect(readdirSync(folder)).toEqual(["열린 문서.hwpx"]);
  const made = await makeHangulDocument(skill, { prompt: "공문서 하나 만들어줘", title: "시설 점검 안내", values: { purpose: "시설 점검 일정 안내" },
    sections: { "추진 배경": "정기 점검 시기입니다.", "현황과 문제": "노후 설비가 있습니다.", "제안 내용": "다음 주 점검을 진행합니다.", "추진 일정": "- 일시: 미정", "기대효과": "안전 확보" } }, target);
  expect(made).toMatchObject({ made: true, artifactId: "made-1", name: "시설 점검 안내.hwpx", draft: true, templateStatus: "common-draft" });
  // the missing 제출 부서 is reported, not invented
  expect(JSON.stringify((made as { missingFields: unknown }).missingFields)).toContain("department");
  expect(tracked).toEqual([join(folder, "시설 점검 안내.hwpx")]);
  const bytes = readFileSync(join(folder, "시설 점검 안내.hwpx"));
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(readFileSync(open, "utf8")).toBe("ORIGINAL");
  // made again: a second file, never over the first
  await makeHangulDocument(skill, { prompt: "공문서", title: "시설 점검 안내", sections: { "추진 배경": "다시" } }, target);
  expect(existsSync(join(folder, "시설 점검 안내 (2).hwpx"))).toBe(true);
}, 60_000);

it("an ambiguous request comes back as the skill's question, and nothing is made", async () => {
  const { root } = setup(), skill = bundledHallymSkill()!;
  const open = join(root, "a.hwpx"); writeFileSync(open, "X");
  const result = await makeHangulDocument(skill, { prompt: "회의록 만들어줘", sections: { 회의내용: "논의" } }, { documentPath: open, track: () => "x" });
  expect(result).toMatchObject({ made: false, status: "needs-clarification", needsClarification: true });
  expect(readdirSync(root)).toEqual(["a.hwpx"]);
}, 30_000);
