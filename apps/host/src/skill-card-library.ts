import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { WorkbenchSkill } from "@workbench/contracts";
import { listSkillFolderFiles, skillContentHash } from "../../../third_party/ieumoffice/user-skills/folder.ts";
import { renderSkillMd } from "../../../third_party/ieumoffice/user-skills/frontmatter.ts";
import { validateNewUserSkillName } from "../../../third_party/ieumoffice/user-skills/names.ts";
import { IEUM_SOURCE_FILE, MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES } from "../../../third_party/ieumoffice/user-skills/constants.ts";
import { HttpError } from "./errors.ts";
import { readSkillFile, type UserSkills } from "./user-skills.ts";

export type SkillCardInput = {
  name: string; title: string; description: string; body: string; invoke: "auto" | "manual";
  targetId?: string; overwrite?: boolean; template?: { fileName: string; bytes: Uint8Array };
};
export type SkillCardRevision = { id: string; sha256: string; folderHash: string };
type Scope = Parameters<UserSkills["list"]>[0];
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A card is an explicit edit/save, distinct from an unselected external import.
 * Prepare the entire folder first; retain replaced folders and never edit a native installation. */
export async function saveSkillCard(skills: UserSkills, input: SkillCardInput, scope: Scope, revisions: SkillCardRevision[], assertCurrent: () => void, committing: () => void = () => {}) {
  return skills.mutate(async () => {
    const name = input.name.trim(), problem = validateNewUserSkillName(name);
    const all = await skills.list(scope), target = all.find((s) => s.id === input.targetId);
    if (input.targetId && (!target || target.source === "project")) throw new HttpError(409, "skill_target", "변경할 스킬을 다시 확인해 주세요.");
    if (problem && name !== target?.name) throw new HttpError(400, "bad_name", "스킬 이름에는 영문 소문자·숫자·하이픈을 사용해 주세요.");
    if (!input.description.trim() || !input.body.trim()) throw new HttpError(400, "empty_skill", "설명과 본문을 입력해 주세요.");
    if (input.template && (!input.template.fileName || input.template.fileName.length > 200 || /[\\/\x00-\x1f<>:"|?*]/.test(input.template.fileName) || /[. ]$/.test(input.template.fileName) || input.template.fileName === "." || input.template.bytes.byteLength > MAX_USER_SKILL_BYTES)) throw new HttpError(400, "bad_template", "양식 파일 이름과 크기를 확인해 주세요.");
    const collisions = all.filter((s) => s.editable && s.id !== target?.id && s.name.toLowerCase() === name.toLowerCase());
    if (collisions.length && !(target && !target.editable && input.overwrite)) throw new HttpError(409, "name_taken", "이미 있는 보관함 스킬 이름입니다.");
    const nativeCollision = all.find((s) => !s.editable && s.name.toLowerCase() === name.toLowerCase() && s.id !== target?.id);
    if (nativeCollision && name !== target?.name) throw new HttpError(409, "name_taken", "설치된 스킬과 다른 이름을 사용해 주세요.");
    const checked = new Map<string, Awaited<ReturnType<UserSkills["detail"]>>>();
    for (const skill of [...(target ? [target] : []), ...collisions]) {
      const revision = revisions.find((r) => r.id === skill.id), detail = await skills.detail(skill.id, scope);
      if (!revision || detail.sha256 !== revision.sha256 || await skillContentHash(skill.dir) !== revision.folderHash) throw new HttpError(409, "skill_changed", "카드를 연 뒤 스킬이 바뀌었습니다. 현재 내용을 다시 확인해 주세요.");
      checked.set(skill.id, detail);
    }
    const base = target ? checked.get(target.id)! : undefined;
    const templatePath = input.template ? `assets/${input.template.fileName}` : target?.template?.relativePath;
    const markdown = renderSkillMd({ name, title: input.title.trim() || target?.title || name, description: input.description.trim(), body: input.body, template: templatePath }, base?.markdown);
    if (Buffer.byteLength(markdown) > 256 * 1024) throw new HttpError(413, "skill_too_large", "스킬 설명이 너무 큽니다.");
    await mkdir(skills.appDir, { recursive: true });
    const stage = await mkdtemp(join(skills.appDir, ".card-")), destination = join(skills.appDir, name);
    const replace = [...(target?.editable ? [target] : []), ...collisions];
    const backupRoot = join(dirname(skills.appDir), "skill-backups", `${Date.now()}-${randomUUID()}`);
    try {
      if (target) {
        const listed = await listSkillFolderFiles(target.dir, { files: MAX_USER_SKILL_FILES, bytes: MAX_USER_SKILL_BYTES });
        if (!listed || listed.tooLarge) throw new HttpError(413, "skill_too_large", "스킬 폴더를 복사할 수 없습니다.");
        for (const file of listed.files) {
          if (file.rel === "SKILL.md" || !target.editable && file.rel === IEUM_SOURCE_FILE) continue;
          const path = join(stage, ...file.rel.split("/"));
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, await readSkillFile(target.dir, file.path, MAX_USER_SKILL_BYTES), { flag: "wx" });
        }
      }
      if (input.template) {
        await mkdir(join(stage, "assets"), { recursive: true });
        await writeFile(join(stage, templatePath!), input.template.bytes);
      }
      await writeFile(join(stage, "SKILL.md"), markdown, { flag: "wx" });
      const prepared = await listSkillFolderFiles(stage, { files: MAX_USER_SKILL_FILES, bytes: MAX_USER_SKILL_BYTES });
      if (!prepared || prepared.tooLarge) throw new HttpError(413, "skill_too_large", "양식을 포함한 스킬 폴더가 너무 큽니다.");
      for (const [id, detail] of checked) if (await skillContentHash(detail.skill.dir) !== revisions.find((r) => r.id === id)!.folderHash) throw new HttpError(409, "skill_changed", "사본을 준비하는 동안 스킬이 바뀌었습니다.");
      if (replace.length) await mkdir(backupRoot, { recursive: true });
      assertCurrent();
      // No async gap between the final Markdown CAS and the folder replacement.
      for (const detail of checked.values()) if (hash(readFileSync(join(detail.skill.dir, "SKILL.md"))) !== detail.sha256) throw new HttpError(409, "skill_changed", "저장 전에 스킬이 바뀌었습니다.");
      if (existsSync(destination) && !replace.some((s) => s.dir === destination)) throw new HttpError(409, "name_taken", "같은 이름의 스킬 폴더가 이미 있습니다.");
      const moved: { from: string; to: string }[] = [];
      committing();
      try {
        for (const skill of replace) {
          const to = join(backupRoot, basename(skill.dir)); renameSync(skill.dir, to); moved.push({ from: skill.dir, to });
        }
        renameSync(stage, destination);
      } catch (error) {
        for (const entry of moved.reverse()) renameSync(entry.to, entry.from);
        throw error;
      }
      const saved = (await skills.list(scope)).find((s) => s.dir === destination && s.editable)!;
      await skills.setState(saved.id, { enabled: target?.editable ? target.state.enabled : true, invoke: input.invoke }, scope);
      if (target?.editable && target.id !== saved.id) skills.moveSelectedCopy(target.id, saved.id, scope);
      if (target && !target.editable) await skills.selectCopy(saved.id, target.id, scope);
      return { ...saved, state: { enabled: target?.editable ? target.state.enabled : true, invoke: input.invoke } } satisfies WorkbenchSkill;
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}
