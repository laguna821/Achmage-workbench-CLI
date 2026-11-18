import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { UserSkills } from "./user-skills.ts";
import { bundledHallymSkill } from "./hallym-kordoc.ts";
import { effectiveHallym, hangulInput, hangulKind, madePath, makeHangulDocument } from "./hangul-document.ts";
import { HangulTemplates } from "./hangul-convert.ts";

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

it("kind: general unless the request carries compose's inputs or names a Hallym / 공문서 form", () => {
  expect(hangulKind({ prompt: "수업 안내문 만들어줘" })).toBe("general");
  expect(hangulKind({ prompt: "공문서 하나 만들어줘" })).toBe("hallym");
  expect(hangulKind({ prompt: "한림대 회의록 양식으로" })).toBe("hallym");
  expect(hangulKind({ prompt: "회의록 만들어줘", sections: { 회의내용: "논의" } })).toBe("hallym");
  expect(hangulKind({ prompt: "공문서", kind: "general" })).toBe("general");
  expect(() => hangulInput({ prompt: "x", kind: "other" })).toThrow();
  expect(() => hangulInput({ prompt: "x", template: "../x" })).toThrow();
});

it("general: Markdown through the 기본 template (the 0.5.4 placement rules), a named template, an attachment read first; a Hallym request still goes to compose", async () => {
  const { root } = setup(), skill = bundledHallymSkill()!;
  const folder = join(root, "project"); mkdirSync(folder);
  const open = join(folder, "열린 문서.hwpx"); writeFileSync(open, "ORIGINAL");
  const templates = new HangulTemplates(join(root, "data"));
  const tracked: string[] = [];
  const target = { documentPath: open, root: folder, templates, track: (path: string) => { tracked.push(path); return `made-${tracked.length}`; } };
  // No Markdown yet: the templates the model may name.
  const listed = await makeHangulDocument(skill, { prompt: "수업 안내문" }, target);
  expect(listed).toMatchObject({ made: false, kind: "general", status: "write-markdown", template: "기본" });
  expect((listed as { templates: { label: string }[] }).templates.map((entry) => entry.label)).toContain("한국언론학회");
  // Markdown → a new HWPX beside the open one through the 기본 template; the open one untouched.
  const made = await makeHangulDocument(skill, { prompt: "수업 안내문", kind: "general", markdown: "# 수업 안내\n\n다음 주 수업은 쉽니다.\n" }, target);
  expect(made).toMatchObject({ made: true, kind: "general", template: "기본", name: "수업 안내.hwpx", inPlace: false, artifactId: "made-1" });
  expect(readFileSync(open, "utf8")).toBe("ORIGINAL");
  expect(readFileSync(join(folder, "수업 안내.hwpx")).subarray(0, 2).toString()).toBe("PK");
  // The same Markdown and template again: the same bytes (deterministic), under a free name.
  await makeHangulDocument(skill, { prompt: "수업 안내문", kind: "general", markdown: "# 수업 안내\n\n다음 주 수업은 쉽니다.\n" }, target);
  expect(readFileSync(join(folder, "수업 안내 (2).hwpx"))).toEqual(readFileSync(join(folder, "수업 안내.hwpx")));
  // A named template.
  const styled = await makeHangulDocument(skill, { prompt: "청소년학 서식으로", kind: "general", template: "builtin:youth-studies", title: "학회 원고", markdown: "# 원고\n\n본문\n" }, target);
  expect(styled).toMatchObject({ made: true, template: "청소년학", name: "학회 원고.hwpx" });
  // An empty untouched open document is filled in place (kept for the turn's end).
  const filled = await makeHangulDocument(skill, { prompt: "안내", kind: "general", markdown: "# 채움\n" }, { ...target, fill: async () => ({ artifactId: "open-1", name: "열린 문서.hwpx" }) });
  expect(filled).toMatchObject({ made: true, inPlace: true, artifactId: "open-1" });
  // An attached .md: read first so the model edits Markdown; outside the project: refused.
  writeFileSync(join(folder, "자료.md"), "---\na: 1\n---\n# 자료\n\n본문 자료\n");
  expect(await makeHangulDocument(skill, { prompt: "이 자료로", source: "자료.md" }, target)).toMatchObject({ status: "source-markdown", markdown: "# 자료\n\n본문 자료\n" });
  writeFileSync(join(root, "밖.md"), "x");
  expect(await makeHangulDocument(skill, { prompt: "이 자료로", source: "../밖.md" }, target)).toMatchObject({ made: false, status: "failed", failure: { code: "outside_project" } });
  // A Hallym / 공문서 request still goes to resolve → compose.
  expect(await makeHangulDocument(skill, { prompt: "공문서 하나 만들어줘" }, target)).toMatchObject({ made: false, status: "form", familyId: "report.hallym" });
}, 120_000);
