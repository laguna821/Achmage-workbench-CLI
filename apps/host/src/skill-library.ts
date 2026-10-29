import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { formatOf, type SkillImportPreview, type SkillUpdatePreview } from "@workbench/contracts";
import { buildSkillExportZip } from "../../../third_party/ieumoffice/user-skills/export.ts";
import { prepareFolderImport, prepareZipImport, prepareGitHubImport, installImportedSkills, disposeSkillImport, appSkillFoldersByName, describeSkillCandidate, type SkillImport } from "../../../third_party/ieumoffice/user-skills/import.ts";
import { checkGitHubSkillUpdate, applyGitHubSkillUpdate, type GitHubSkillUpdateCheck } from "../../../third_party/ieumoffice/user-skills/update.ts";
import { skillContentHash } from "../../../third_party/ieumoffice/user-skills/folder.ts";
import { parseSkillMd, renderSkillMd } from "../../../third_party/ieumoffice/user-skills/frontmatter.ts";
import { suggestUserSkillName, validateNewUserSkillName } from "../../../third_party/ieumoffice/user-skills/names.ts";
import { MAX_USER_SKILL_BYTES } from "../../../third_party/ieumoffice/user-skills/constants.ts";
import { HttpError } from "./errors.ts";
import { readSkillFile, type UserSkills } from "./user-skills.ts";

type Scope = Parameters<UserSkills["list"]>[0];
type Pending = { imported: SkillImport; hashes: Map<string, string>; expires: number };
type PendingUpdate = { skillId: string; hash: string; check: Extract<GitHubSkillUpdateCheck, { status: "changed" }>; expires: number };
const TTL = 30 * 60_000;

/** Import previews have no activation side effects; installs only touch Workbench-owned copies. */
export class SkillLibrary {
  private readonly imports = new Map<string, Pending>();
  private readonly updates = new Map<string, PendingUpdate>();
  private readonly tempDir: string;
  readonly skills: UserSkills;
  private readonly dataDir: string;
  private readonly home: string;
  constructor(skills: UserSkills, dataDir: string, home = homedir()) {
    this.skills = skills; this.dataDir = dataDir; this.home = home;
    this.tempDir = join(dataDir, "skill-previews");
  }
  private async clean() {
    for (const [id, item] of this.imports) if (item.expires < Date.now()) { this.imports.delete(id); await disposeSkillImport(item.imported); }
    for (const [id, item] of this.updates) if (item.expires < Date.now()) { this.updates.delete(id); await disposeSkillImport(item.check.update); }
    if (this.imports.size + this.updates.size >= 20) throw new HttpError(429, "too_many_skill_previews", "열어 둔 가져오기 미리보기를 먼저 닫아 주세요.");
  }
  private async keep(imported: SkillImport): Promise<SkillImportPreview> {
    const id = randomUUID(), hashes = new Map<string, string>();
    for (const candidate of imported.candidates) if (!candidate.problem) hashes.set(candidate.key, await skillContentHash(candidate.dir));
    this.imports.set(id, { imported, hashes, expires: Date.now() + TTL });
    return { id, origin: imported.origin.kind === "github" ? `${imported.origin.repo}@${imported.origin.commit}` : imported.origin.kind === "folder" ? imported.origin.folder : imported.origin.file, license: imported.rootLicense ?? null,
      candidates: imported.candidates.map((item) => ({ key: item.key, name: item.name, title: item.title, description: item.description, files: item.files, bytes: item.bytes, hasScripts: item.hasScripts, hasTemplate: item.hasTemplate, collision: item.collision, problem: item.problem ?? null, urls: item.urls, license: item.license ?? null })) };
  }
  async prepare(kind: "folder" | "zip" | "github", input: string) {
    await this.clean();
    if (!input.trim()) throw new HttpError(400, "missing_skill_source", "가져올 위치를 입력해 주세요.");
    const shared = { appSkillsDir: this.skills.appDir, tempDir: this.tempDir };
    const imported = kind === "folder" ? await prepareFolderImport({ ...shared, folder: resolve(input), homeDir: this.home })
      : kind === "zip" ? await prepareZipImport({ ...shared, file: resolve(input) })
      : await prepareGitHubImport({ ...shared, address: input, fetch, signal: AbortSignal.timeout(60_000) });
    try { return await this.keep(imported); } catch (error) { await disposeSkillImport(imported); throw error; }
  }
  async discard(id: string) {
    const imported = this.imports.get(id); this.imports.delete(id);
    const update = this.updates.get(id); this.updates.delete(id);
    if (imported) await disposeSkillImport(imported.imported);
    if (update) await disposeSkillImport(update.check.update);
  }
  private async backup(dir: string) {
    const target = join(this.dataDir, "skill-backups", `${Date.now()}-${randomUUID()}`, basename(dir));
    await mkdir(dirname(target), { recursive: true });
    await rename(dir, target);
  }
  async install(id: string, selected: string[], collisions: Record<string, "replace" | "skip"> = {}) {
    return this.skills.mutate(async () => {
      const pending = this.imports.get(id);
      if (!pending || pending.expires < Date.now()) throw new HttpError(409, "skill_preview_expired", "가져오기 미리보기를 다시 열어 주세요.");
      if (!selected.length) throw new HttpError(400, "no_skills_selected", "가져올 스킬을 선택해 주세요.");
      for (const key of selected) {
        const candidate = pending.imported.candidates.find((item) => item.key === key);
        if (!candidate || candidate.problem || await skillContentHash(candidate.dir) !== pending.hashes.get(key)) throw new HttpError(409, "skill_source_changed", "미리보기 뒤 원본이 바뀌었습니다. 다시 확인해 주세요.");
      }
      const result = await installImportedSkills(pending.imported, { appSkillsDir: this.skills.appDir, selected, onCollision: collisions, discardReplaced: (dir) => this.backup(dir) });
      // Replacing a previously enabled import is still a fresh import, requiring a new selection.
      const list = await this.skills.list();
      for (const entry of result.installed) {
        const skill = list.find((item) => item.source === "imported" && item.dir === entry.dir);
        if (skill) await this.skills.setState(skill.id, { enabled: false, invoke: "manual" });
      }
      await this.discard(id);
      return result;
    });
  }
  async export(id: string, scope: Scope) {
    const { skill } = await this.skills.detail(id, scope);
    return buildSkillExportZip(skill.dir);
  }
  async clone(id: string, scope: Scope) {
    await this.clean();
    const result = await this.export(id, scope);
    await mkdir(this.tempDir, { recursive: true });
    const folder = await mkdtemp(join(this.tempDir, "clone-")), zip = join(folder, result.info.fileName);
    let imported: SkillImport | null = null;
    try {
      await writeFile(zip, result.bytes, { flag: "wx" });
      imported = await prepareZipImport({ appSkillsDir: this.skills.appDir, tempDir: this.tempDir, file: zip });
      const candidate = imported.candidates[0]!;
      const markdown = await readFile(join(candidate.dir, "SKILL.md"), "utf8"), parsed = parseSkillMd(markdown)!;
      const name = suggestUserSkillName(`${candidate.name}-copy`, { taken: (await this.skills.list(scope)).map((item) => item.name) });
      await writeFile(join(candidate.dir, "SKILL.md"), renderSkillMd({ name, title: `${candidate.title} 사본`, description: candidate.description, body: parsed.body, template: parsed.metadata["ieum-template"] }, markdown));
      imported.candidates = [(await describeSkillCandidate(candidate.dir, candidate.rel, await appSkillFoldersByName(this.skills.appDir)))!];
      imported.origin = { kind: "zip", file: `${candidate.title} · 보관함 사본` };
      return await this.keep(imported);
    } catch (error) { if (imported) await disposeSkillImport(imported); throw error; }
    finally { await rm(folder, { recursive: true, force: true }); }
  }
  async register(input: { title: string; name?: string; description: string; body: string; file?: string }, scope: Scope) {
    await this.clean();
    if (!input.title.trim() || !input.description.trim()) throw new HttpError(400, "invalid_skill", "양식 이름과 설명을 입력해 주세요.");
    const installed = await this.skills.list(scope);
    const name = input.name?.trim() || suggestUserSkillName(input.title, { taken: installed.map((item) => item.name) });
    if (validateNewUserSkillName(name)) throw new HttpError(400, "invalid_skill_name", "스킬 이름에는 영문 소문자·숫자·하이픈을 사용해 주세요.");
    await mkdir(this.tempDir, { recursive: true });
    const folder = await mkdtemp(join(this.tempDir, "personal-"));
    try {
      let template: string | undefined;
      if (input.file) {
        const file = await realpath(resolve(input.file));
        if (!formatOf(file)) throw new HttpError(415, "unsupported_template", "지원하는 문서 파일을 선택해 주세요.");
        const bytes = await readSkillFile(dirname(file), file, MAX_USER_SKILL_BYTES);
        template = `assets/${basename(file)}`;
        await mkdir(join(folder, "assets")); await writeFile(join(folder, template), bytes, { flag: "wx" });
      }
      const markdown = renderSkillMd({ name, title: input.title, description: input.description, body: input.body, template });
      if (Buffer.byteLength(markdown) > 256 * 1024) throw new HttpError(413, "skill_too_large", "스킬 설명이 너무 큽니다.");
      await writeFile(join(folder, "SKILL.md"), markdown, { flag: "wx" });
      const imported = await prepareFolderImport({ folder, appSkillsDir: this.skills.appDir, homeDir: this.home });
      imported.tempDir = folder;
      return await this.keep(imported);
    } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
  }
  async checkUpdate(id: string, scope: Scope): Promise<SkillUpdatePreview> {
    await this.clean();
    const { skill } = await this.skills.detail(id, scope);
    if (!skill.editable || !skill.github) throw new HttpError(409, "not_github_skill", "Workbench에 GitHub에서 가져온 스킬만 여기서 업데이트할 수 있습니다.");
    const hash = await skillContentHash(skill.dir);
    const check = await checkGitHubSkillUpdate({ skillDir: skill.dir, appSkillsDir: this.skills.appDir, tempDir: this.tempDir, fetch, signal: AbortSignal.timeout(60_000) });
    const token = check.status === "changed" ? randomUUID() : null;
    if (check.status === "changed") this.updates.set(token!, { skillId: id, hash, check, expires: Date.now() + TTL });
    return { id: token, status: check.status, commit: check.commit, locallyEdited: check.locallyEdited, changes: check.status === "changed" ? check.changedFiles : [] };
  }
  async applyUpdate(id: string, allowLocalChanges: boolean, scope: Scope) {
    return this.skills.mutate(async () => {
      const pending = this.updates.get(id);
      if (!pending || pending.expires < Date.now()) throw new HttpError(409, "skill_preview_expired", "업데이트 내용을 다시 확인해 주세요.");
      const { skill } = await this.skills.detail(pending.skillId, scope);
      if (!skill.editable || await skillContentHash(skill.dir) !== pending.hash) throw new HttpError(409, "skill_changed", "확인한 뒤 로컬 스킬이 바뀌었습니다. 다시 확인해 주세요.");
      if (pending.check.locallyEdited && !allowLocalChanges) throw new HttpError(409, "skill_local_changes", "수정한 로컬 판을 백업하고 바꿀지 선택해 주세요.");
      this.updates.delete(id);
      return applyGitHubSkillUpdate(pending.check, { skillDir: skill.dir, appSkillsDir: this.skills.appDir, discardReplaced: (dir) => this.backup(dir) });
    });
  }
  async remove(id: string, expectedSha256: string, scope: Scope) {
    return this.skills.mutate(async () => {
      const detail = await this.skills.detail(id, scope);
      if (!detail.skill.editable) throw new HttpError(409, "native_skill_readonly", "설치된 원본은 해당 도구에서 관리해 주세요.");
      if (detail.sha256 !== expectedSha256) throw new HttpError(409, "skill_changed", "현재 스킬을 다시 확인해 주세요.");
      await this.backup(detail.skill.dir);
      return { ok: true };
    });
  }
  async shutdown() {
    for (const id of [...this.imports.keys(), ...this.updates.keys()]) await this.discard(id);
  }
}
