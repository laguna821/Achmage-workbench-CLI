import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync, renameSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { formatOf, type Provider, type WorkbenchSkill, type WorkbenchSkillDetail, type WorkbenchSkillSource, type WorkbenchSkillState } from "@workbench/contracts";
import { isInsideDir, listSkillFolderFiles, normalizeSkillTemplatePath, readUserSkillFolder } from "../../../third_party/ieumoffice/user-skills/folder.ts";
import { MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES } from "../../../third_party/ieumoffice/user-skills/constants.ts";
import { userSkillSources } from "../../../third_party/ieumoffice/user-skills/sources.ts";
import { parseSkillMd, renderSkillMd } from "../../../third_party/ieumoffice/user-skills/frontmatter.ts";
import type { UserSkillSourceDir } from "../../../third_party/ieumoffice/user-skills/types.ts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";

const MAX_MARKDOWN = 256 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Source = { source: WorkbenchSkillSource; dir: string; core: UserSkillSourceDir["source"]; plugin?: string };
type Scope = { projectRoot?: string; provider?: Provider };

/** Bounded reads through a descriptor; an escaped file link is never read as a skill asset. */
export async function readSkillFile(root: string, file: string, limit: number): Promise<Buffer> {
  const canonical = await realpath(file);
  if (!isInsideDir(canonical, root)) throw new HttpError(409, "skill_path_changed", "스킬 파일이 폴더 밖으로 이동했습니다.");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new HttpError(413, "skill_too_large", "스킬 파일이 너무 크거나 일반 파일이 아닙니다.");
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new HttpError(409, "skill_changed", "읽는 동안 스킬 파일이 바뀌었습니다. 다시 확인해 주세요.");
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

/** Read native installations; only Workbench's imported copies and its own state are writable. */
export class UserSkills {
  readonly appDir: string;
  private readonly home: string;
  private readonly dataDir: string;
  private readonly builtinDir?: string;
  private readonly store: Pick<Store, "getMeta" | "setMeta">;
  private editing: Promise<unknown> = Promise.resolve();

  constructor(store: Pick<Store, "getMeta" | "setMeta">, options: { dataDir: string; homeDir?: string; builtinDir?: string }) {
    this.store = store; this.dataDir = resolve(options.dataDir); this.home = resolve(options.homeDir ?? homedir());
    this.appDir = join(this.dataDir, "user-skills"); this.builtinDir = options.builtinDir;
  }
  /** Serialize our writes without changing any installed engine's skill settings. */
  mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.editing.then(run);
    this.editing = result.catch(() => undefined);
    return result;
  }
  private states(): Record<string, WorkbenchSkillState> {
    const raw = this.store.getMeta("user-skills:states");
    if (!raw) return {};
    let value;
    try { value = JSON.parse(raw); } catch { throw new HttpError(409, "unknown_skill_state", "읽을 수 없는 스킬 설정은 보존했습니다."); }
    if (value?.version !== 1 || !value.states || typeof value.states !== "object" || Array.isArray(value.states)) throw new HttpError(409, "unknown_skill_state", "이 버전에서 읽을 수 없는 스킬 설정입니다. 저장된 설정은 보존했습니다.");
    return value.states;
  }
  private copyKey(scope: Scope) { return `user-skills:selected-copies:${hash(scope.projectRoot ?? "global")}`; }
  private selectedCopies(scope: Scope): Record<string, { id: string; sourceId: string }> {
    const raw = this.store.getMeta(this.copyKey(scope));
    if (!raw) return {};
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new HttpError(409, "unknown_skill_state", "선택한 스킬 사본 설정을 읽지 못했습니다."); }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([name, choice]) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || !choice || typeof choice !== "object" || typeof choice.id !== "string" || typeof choice.sourceId !== "string")) throw new HttpError(409, "unknown_skill_state", "선택한 스킬 사본 설정을 보존했습니다.");
    return value as Record<string, { id: string; sourceId: string }>;
  }
  /** A person explicitly saved an installed skill as their selected local copy.
   * This changes only Workbench's choice for this project; default source order stays intact. */
  async selectCopy(id: string, sourceId: string, scope: Scope = {}) {
    const all = await this.list(scope), copy = all.find((s) => s.id === id), source = all.find((s) => s.id === sourceId);
    if (!copy?.editable || !source || source.source === "project") throw new HttpError(409, "skill_copy_selection", "보관함 사본을 확인할 수 없습니다.");
    const selected = this.selectedCopies(scope); selected[source.name.toLowerCase()] = { id, sourceId };
    this.store.setMeta(this.copyKey(scope), JSON.stringify(selected));
  }
  /** Keep an explicit copy selection through a rename, without reviving its original. */
  moveSelectedCopy(before: string, after: string, scope: Scope = {}) {
    const selected = this.selectedCopies(scope);
    for (const choice of Object.values(selected)) if (choice.id === before) choice.id = after;
    this.store.setMeta(this.copyKey(scope), JSON.stringify(selected));
  }
  private async sources(scope: Scope): Promise<Source[]> {
    const native = await userSkillSources({ homeDir: this.home, appSkillsDir: this.appDir, projectRoot: scope.projectRoot, builtinDir: this.builtinDir });
    const sources: Source[] = native.map((entry) => ({ ...entry, core: entry.source, source: ({ user: "claude", codex: "shared", app: "imported" } as Partial<Record<string, WorkbenchSkillSource>>)[entry.source] ?? entry.source as WorkbenchSkillSource }));
    sources.push({ source: "codex", core: "codex", dir: join(this.home, ".codex", "skills") });
    sources.push({ source: "ieum", core: "app", dir: join(this.home, ".ieumoffice", "skills") });
    const order: Record<WorkbenchSkillSource, number> = { project: 0, claude: scope.provider === "claude" ? 10 : 11, codex: scope.provider === "claude" ? 11 : 10, shared: 12, plugin: 13, imported: 20, ieum: 21, builtin: 30 };
    return sources.sort((a, b) => order[a.source] - order[b.source]);
  }
  async list(scope: Scope = {}): Promise<WorkbenchSkill[]> {
    const entries: WorkbenchSkill[] = [], seenPaths = new Set<string>();
    const states = this.states();
    const codex = await realpath(join(this.home, ".codex")).catch(() => join(this.home, ".codex"));
    const codexSkills = await realpath(join(this.home, ".codex", "skills")).catch(() => join(codex, "skills"));
    const appRoot = await realpath(this.appDir).catch(() => this.appDir);
    for (const source of await this.sources(scope)) {
      const children = await readdir(source.dir, { withFileTypes: true }).catch(() => []);
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (child.name.startsWith(".") || (!child.isDirectory() && !child.isSymbolicLink())) continue;
        const dir = await realpath(join(source.dir, child.name)).catch(() => null);
        if (!dir || seenPaths.has(dir) || (isInsideDir(dir, codex) && !isInsideDir(dir, codexSkills))) continue;
        // Never follow a SKILL.md link out of its skill folder or scan an unrelated cache folder.
        const markdownPath = await realpath(join(dir, "SKILL.md")).catch(() => null);
        if (!markdownPath || !isInsideDir(markdownPath, dir)) continue;
        const info = await stat(markdownPath).catch(() => null);
        if (!info?.isFile() || info.size > MAX_MARKDOWN) continue;
        seenPaths.add(dir);
        const skill = await readUserSkillFolder(dir, { source: source.core, plugin: source.plugin });
        if (!skill) continue;
        const id = `skill-${hash(dir).slice(0, 32)}`;
        const saved = states[id];
        entries.push({
          id, name: skill.name, title: skill.title, description: skill.description, source: source.source, dir, plugin: skill.plugin ?? null,
          template: skill.template ? { relativePath: skill.template, name: basename(skill.template), format: formatOf(skill.template), exists: skill.templateExists } : null,
          state: { enabled: typeof saved?.enabled === "boolean" ? saved.enabled : source.source !== "imported" && source.source !== "builtin", invoke: saved?.invoke === "auto" ? "auto" : "manual" },
          shadowedBy: null, editable: source.source === "imported" && isInsideDir(dir, appRoot), hasScripts: skill.hasScripts, github: skill.github,
          files: skill.files, bytes: skill.bytes, problem: skill.unreadable ?? null,
        });
      }
    }
    const selected = this.selectedCopies(scope);
    const names = new Map<string, string>();
    for (const [name, choice] of Object.entries(selected)) {
      // A disabled, removed or unreadable selected copy cannot silently activate
      // the old installation. The person can explicitly enable that installation.
      if (!entries.some((s) => s.source === "project" && s.name.toLowerCase() === name)) names.set(name, choice.id);
    }
    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      entry.shadowedBy = names.get(name) === entry.id ? null : names.get(name) ?? null;
      // An explicitly disabled installed skill still wins over a bundled same-name fallback.
      if (!entry.shadowedBy && !entry.problem) names.set(name, entry.id);
    }
    return entries;
  }
  async detail(id: string, scope: Scope = {}): Promise<WorkbenchSkillDetail> {
    const skill = (await this.list(scope)).find((entry) => entry.id === id);
    if (!skill || skill.problem) throw new HttpError(404, "skill_unavailable", "읽을 수 있는 스킬을 찾지 못했습니다.");
    const markdown = (await readSkillFile(skill.dir, join(skill.dir, "SKILL.md"), MAX_MARKDOWN)).toString("utf8");
    const parsed = parseSkillMd(markdown);
    if (!parsed || parsed.name?.trim() !== skill.name || parsed.description?.trim() !== skill.description || (parsed.metadata["ieum-title"]?.trim() || skill.name) !== skill.title || (normalizeSkillTemplatePath(parsed.metadata["ieum-template"]) ?? null) !== (skill.template?.relativePath ?? null)) throw new HttpError(409, "skill_changed", "목록을 읽은 뒤 스킬이 바뀌었습니다. 다시 확인해 주세요.");
    return { skill, markdown, body: parsed.body, sha256: hash(markdown) };
  }
  async setState(id: string, state: WorkbenchSkillState, scope: Scope = {}) {
    const { skill } = await this.detail(id, scope);
    if (typeof state?.enabled !== "boolean" || !["manual", "auto"].includes(state.invoke)) throw new HttpError(400, "invalid_skill_state", "스킬 선택 상태가 올바르지 않습니다.");
    const states = this.states(); states[id] = { enabled: state.enabled, invoke: state.invoke };
    this.store.setMeta("user-skills:states", JSON.stringify({ version: 1, states }));
    const selected = this.selectedCopies(scope), key = skill.name.toLowerCase();
    if (selected[key] && state.enabled && selected[key]!.id !== id) {
      delete selected[key]; this.store.setMeta(this.copyKey(scope), JSON.stringify(selected));
      return (await this.list(scope)).find((entry) => entry.id === id) ?? { ...skill, state: states[id]! };
    }
    return { ...skill, state: states[id]! };
  }
  async update(id: string, expectedSha256: string, input: { title: string; description: string; body: string }, scope: Scope = {}) {
    return this.mutate(async () => {
    const detail = await this.detail(id, scope);
    if (!detail.skill.editable) throw new HttpError(409, "native_skill_readonly", "설치된 원본 스킬은 이곳에서 바꾸지 않습니다. Workbench 사본을 만들어 편집해 주세요.");
    if (expectedSha256 !== detail.sha256) throw new HttpError(409, "skill_changed", "다른 곳에서 이 스킬을 바꿨습니다. 현재 내용을 다시 확인해 주세요.");
    if (![input?.title, input?.description, input?.body].every((value) => typeof value === "string") || !input.description.trim()) throw new HttpError(400, "invalid_skill", "스킬 이름·설명·내용을 확인해 주세요.");
    const parsed = parseSkillMd(detail.markdown)!;
    const markdown = renderSkillMd({ name: detail.skill.name, title: input.title.trim(), description: input.description.trim(), body: input.body, template: parsed.metadata["ieum-template"] }, detail.markdown);
    if (Buffer.byteLength(markdown) > MAX_MARKDOWN) throw new HttpError(413, "skill_too_large", "스킬 설명이 너무 큽니다.");
    const file = join(detail.skill.dir, "SKILL.md"), temporary = join(detail.skill.dir, `.skill-${randomUUID()}.tmp`);
    // Recheck after asynchronous preparation; a native edit never loses to a stale form.
    await writeFile(temporary, markdown, { flag: "wx" });
    try {
      // No asynchronous gap between the final revision check and replacement.
      if (hash(readFileSync(file)) !== expectedSha256) throw new HttpError(409, "skill_changed", "저장 전에 스킬이 바뀌었습니다. 편집 내용은 유지해 주세요.");
      renameSync(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return { skill: { ...detail.skill, title: input.title.trim(), description: input.description.trim() }, markdown, body: input.body, sha256: hash(markdown) };
    });
  }
  async templateSnapshot(id: string, scope: Scope = {}, requireSelected = true) {
    const { skill, markdown, sha256: skillSha256 } = await this.detail(id, scope);
    if (requireSelected && (!skill.state.enabled || skill.shadowedBy)) throw new HttpError(409, "skill_not_selected", "사용할 스킬 판을 목록에서 선택해 주세요.");
    if (!skill.template?.exists || !skill.template.format) throw new HttpError(404, "template_unavailable", "지원하는 양식 파일을 찾지 못했습니다.");
    const listed = await listSkillFolderFiles(skill.dir, { files: MAX_USER_SKILL_FILES, bytes: MAX_USER_SKILL_BYTES });
    const asset = listed && !listed.tooLarge && listed.files.find((file) => file.rel === skill.template!.relativePath);
    if (!asset) throw new HttpError(404, "template_unavailable", "양식이 없거나 스킬 폴더 밖으로 이동했습니다.");
    const bytes = await readSkillFile(skill.dir, asset.path, MAX_USER_SKILL_BYTES), digest = hash(bytes);
    if (hash(await readSkillFile(skill.dir, join(skill.dir, "SKILL.md"), MAX_MARKDOWN)) !== skillSha256) throw new HttpError(409, "skill_changed", "양식을 읽는 동안 스킬 설명이 바뀌었습니다. 다시 확인해 주세요.");
    if (bytes.length > MAX_USER_SKILL_BYTES) throw new HttpError(413, "template_too_large", "양식 파일이 너무 큽니다.");
    const extension = skill.template.name.endsWith(".design.json") ? ".design.json" : `.${skill.template.name.split(".").at(-1)}`;
    const path = join(this.dataDir, "template-snapshots", `${digest}${extension}`);
    await mkdir(dirname(path), { recursive: true });
    try { await writeFile(path, bytes, { flag: "wx" }); await chmod(path, 0o444); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (hash(await readFile(path)) !== digest) throw new HttpError(409, "template_snapshot_changed", "양식 사본의 내용이 바뀌어 사용하지 않았습니다. 원본은 보존했습니다.");
    return { skill, path, sha256: digest, skillSha256, markdown, size: bytes.length, format: skill.template.format };
  }
}
