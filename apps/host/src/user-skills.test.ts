import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { UserSkills } from "./user-skills.ts";
import { SkillLibrary } from "./skill-library.ts";

const cleanup: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "wb-skills-")); cleanup.push(root);
  const home = join(root, "home"), data = join(root, "data"), project = join(root, "project"), builtin = join(root, "builtin");
  const meta = new Map<string, string>();
  const skills = new UserSkills({ getMeta: (key) => meta.get(key) ?? null, setMeta: (key, value) => { meta.set(key, value); } }, { dataDir: data, homeDir: home, builtinDir: builtin });
  return { root, home, data, project, builtin, meta, skills, library: new SkillLibrary(skills, data, home) };
}
async function make(parent: string, name = "report", text = "# Original\n") {
  const dir = join(parent, name); await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Make a report\ncustom:\n  untouched: [one, two]\nmetadata:\n  ieum-title: 보고서 양식\n  ieum-template: assets/form.md\n---\nRead the template.\n`);
  await writeFile(join(dir, "assets/form.md"), text);
  return dir;
}

describe("personal skills and template originals", () => {
  it("prefers project and native installations, without falling back when the winner is disabled", async () => {
    const { home, project, builtin, skills } = await setup();
    await make(join(home, ".claude/skills")); await make(join(home, ".codex/skills")); await make(builtin);
    await make(join(project, ".agents/skills")); await make(skills.appDir);
    let list = await skills.list({ projectRoot: project, provider: "claude" });
    expect(list.map((item) => item.source)).toEqual(["project", "claude", "codex", "imported", "builtin"]);
    expect(list.slice(1).every((item) => item.shadowedBy === list[0]!.id)).toBe(true);
    await skills.setState(list[0]!.id, { enabled: false, invoke: "manual" }, { projectRoot: project });
    list = await skills.list({ projectRoot: project });
    expect(list[0]!.state.enabled).toBe(false); expect(list.slice(1).every((item) => item.shadowedBy)).toBe(true);
    expect((await skills.list({ provider: "codex" }))[0]!.source).toBe("codex");
  });
  it("reads .codex/skills but never follows a skill or SKILL.md into the auth home", async () => {
    const { home, skills } = await setup();
    await make(join(home, ".codex/skills"), "safe");
    const secret = await make(join(home, ".codex"), "auth-private");
    await symlink(secret, join(home, ".codex/skills", "escape"));
    const escaped = join(home, ".codex/skills", "escaped-markdown"); await mkdir(escaped);
    await symlink(join(secret, "SKILL.md"), join(escaped, "SKILL.md"));
    expect((await skills.list()).map((item) => item.name)).toEqual(["safe"]);
  });
  it("keeps immutable template snapshots and rejects an escaped template asset", async () => {
    const { root, home, skills } = await setup(); const dir = await make(join(home, ".claude/skills"));
    const skill = (await skills.list())[0]!; const first = await skills.templateSnapshot(skill.id);
    await writeFile(join(dir, "assets/form.md"), "# Revised\n");
    const second = await skills.templateSnapshot(skill.id);
    expect(second.sha256).not.toBe(first.sha256); expect(await readFile(first.path, "utf8")).toBe("# Original\n");
    const outside = join(root, "outside.md"); await writeFile(outside, "private");
    await rm(join(dir, "assets/form.md")); await symlink(outside, join(dir, "assets/form.md"));
    await expect(skills.templateSnapshot(skill.id)).rejects.toMatchObject({ code: "template_unavailable" });
    expect(await readFile(outside, "utf8")).toBe("private");
  });
  it("serializes imported-copy edits with CAS while preserving unrelated YAML and native originals", async () => {
    const { home, skills } = await setup(); await make(join(home, ".claude/skills"), "native"); await make(skills.appDir);
    const list = await skills.list(); const imported = list.find((item) => item.source === "imported")!;
    const detail = await skills.detail(imported.id);
    const result = await Promise.allSettled(["first", "second"].map((body) => skills.update(imported.id, detail.sha256, { title: "새 이름", description: "새 설명", body })));
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(result.find((item) => item.status === "rejected")).toMatchObject({ reason: { code: "skill_changed" } });
    expect((await skills.detail(imported.id)).markdown).toContain("  untouched: [one, two]");
    expect(await readdir(imported.dir)).toEqual(expect.not.arrayContaining([expect.stringContaining(".tmp")]));
    const native = list.find((item) => item.source === "claude")!;
    await expect(skills.update(native.id, (await skills.detail(native.id)).sha256, { title: "X", description: "Y", body: "Z" })).rejects.toMatchObject({ code: "native_skill_readonly" });
  });
  it("preserves unknown future settings rather than replacing them", async () => {
    const { skills, meta } = await setup(); const raw = JSON.stringify({ version: 99, states: { future: true } }); meta.set("user-skills:states", raw);
    await expect(skills.list()).rejects.toMatchObject({ code: "unknown_skill_state" }); expect(meta.get("user-skills:states")).toBe(raw);
  });
});

describe("skill import/export", () => {
  it("previews without activating, imports a private copy and round-trips template bytes through ZIP", async () => {
    const { root, skills, library } = await setup(); const source = await make(join(root, "source"));
    const preview = await library.prepare("folder", source); expect(await skills.list()).toEqual([]);
    await library.install(preview.id, [preview.candidates[0]!.key]);
    const skill = (await skills.list())[0]!; expect(skill.state).toEqual({ enabled: false, invoke: "manual" });
    const zip = await library.export(skill.id, {}); const loaded = await JSZip.loadAsync(zip.bytes);
    expect(await loaded.file("report/assets/form.md")!.async("string")).toBe("# Original\n");
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toContain("Read the template.");
    const clone = await library.clone(skill.id, {}); expect(clone.candidates[0]!.name).toBe("report-copy"); expect(clone.candidates[0]!.collision).toBe(false);
    await library.discard(clone.id);
    await skills.setState(skill.id, { enabled: true, invoke: "manual" });
    const replacement = await library.prepare("folder", source);
    await expect(library.install(replacement.id, [replacement.candidates[0]!.key])).rejects.toMatchObject({ kind: "needs-choice" });
    await library.install(replacement.id, [replacement.candidates[0]!.key], { [replacement.candidates[0]!.key]: "replace" });
    expect((await skills.detail(skill.id)).skill.state.enabled).toBe(false);
    expect(await readdir(join(root, "data/skill-backups"))).toHaveLength(1);
  });
  it("requires a new preview when the folder changed, and rejects a ZIP traversal entry", async () => {
    const { root, skills, library } = await setup(); const source = await make(join(root, "source"));
    const preview = await library.prepare("folder", source); await writeFile(join(source, "assets/form.md"), "changed");
    await expect(library.install(preview.id, [preview.candidates[0]!.key])).rejects.toMatchObject({ code: "skill_source_changed" });
    expect(await skills.list()).toEqual([]); await library.discard(preview.id);
    const zip = new JSZip(); zip.file("../escaped.md", "escape"); zip.file("report/SKILL.md", await readFile(join(source, "SKILL.md")));
    const file = join(root, "unsafe.zip"); await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(library.prepare("zip", file)).rejects.toThrow();
    expect(await readdir(root)).not.toContain("escaped.md");
  });
  it("registers an existing document as a personal form while preserving the original", async () => {
    const { root, skills, library } = await setup(); const file = join(root, "한글 양식.md"); await writeFile(file, "## 회의록\n");
    const preview = await library.register({ title: "회의록", description: "회의 기록 양식", body: "Fill the provided form", file }, {});
    expect(preview.candidates[0]!.hasTemplate).toBe(true);
    await library.install(preview.id, [preview.candidates[0]!.key]);
    const skill = (await skills.list())[0]!; await skills.setState(skill.id, { enabled: true, invoke: "manual" });
    const template = await skills.templateSnapshot(skill.id);
    expect(await readFile(template.path, "utf8")).toBe("## 회의록\n"); expect(await readFile(file, "utf8")).toBe("## 회의록\n");
  });

  it("previews GitHub changes, requires an explicit local-edit replacement and backs up the old copy", async () => {
    const { root, skills, library } = await setup(); const source = await make(join(root, "source"));
    const markdown = await readFile(join(source, "SKILL.md"), "utf8");
    let commit = "a".repeat(40), form = "# Remote version one\n";
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url === "https://api.github.com/repos/example/templates") return new Response(JSON.stringify({ default_branch: "main" }));
      if (url.endsWith("/commits/main")) return new Response(commit);
      if (url.startsWith("https://codeload.github.com/example/templates/zip/")) {
        const zip = new JSZip(); zip.file("templates-root/report/SKILL.md", markdown); zip.file("templates-root/report/assets/form.md", form);
        return new Response(await zip.generateAsync({ type: "arraybuffer" }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const imported = await library.prepare("github", "https://github.com/example/templates");
    await library.install(imported.id, [imported.candidates[0]!.key]);
    const skill = (await skills.list())[0]!; expect(skill.github).toBe(true);
    await skills.setState(skill.id, { enabled: true, invoke: "manual" });
    await writeFile(join(skill.dir, "assets/form.md"), "# My local edit\n");
    commit = "b".repeat(40); form = "# Remote version two\n";
    const check = await library.checkUpdate(skill.id, {});
    expect(check).toMatchObject({ status: "changed", locallyEdited: true, changes: [{ rel: "assets/form.md", change: "modified" }] });
    await expect(library.applyUpdate(check.id!, false, {})).rejects.toMatchObject({ code: "skill_local_changes" });
    expect(await readFile(join(skill.dir, "assets/form.md"), "utf8")).toBe("# My local edit\n");
    await library.applyUpdate(check.id!, true, {});
    expect(await readFile(join(skill.dir, "assets/form.md"), "utf8")).toBe(form);
    const backup = (await readdir(join(root, "data/skill-backups")))[0]!;
    expect(await readFile(join(root, "data/skill-backups", backup, "report/assets/form.md"), "utf8")).toBe("# My local edit\n");
    expect((await skills.detail(skill.id)).skill.state.enabled).toBe(true);
    expect(requests.every(({ url, init }) => ["api.github.com", "codeload.github.com"].includes(new URL(url).hostname) && !new Headers(init.headers).has("authorization"))).toBe(true);
    expect(await library.checkUpdate(skill.id, {})).toMatchObject({ status: "up-to-date", locallyEdited: false });
  });
});
