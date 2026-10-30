import { extname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkbenchSkill } from "@workbench/contracts";
import type { OfficeSkillSource, OfficeSkillView, OfficeStoredSkill } from "../../../packages/contracts/src/office-skills.ts";
import { listSkillFolderFiles } from "../../../third_party/ieumoffice/user-skills/folder.ts";
import { IEUM_SOURCE_FILE, MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES, SKILL_TEXT_EXTENSIONS } from "../../../third_party/ieumoffice/user-skills/constants.ts";
import type { SessionManager } from "./sessions.ts";
import type { EditorGrants } from "./editors.ts";
import { readSkillFile } from "./user-skills.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import { officeEditorKind } from "./editors.ts";
import { OfficeSkillCards } from "./office-skill-cards.ts";
import type { Store } from "./store.ts";

export type OfficeSkillContext = { artifactId: string; token: string; grants: EditorGrants };
type Context = OfficeSkillContext;
export type OfficeSkillAccess = ReturnType<OfficeSkills["writable"]>;
const sources: Record<WorkbenchSkill["source"], OfficeSkillSource> = { claude: "user", shared: "codex", codex: "codex", imported: "app", ieum: "app", builtin: "builtin", project: "project", plugin: "plugin" };
const sourceOf = (skill: WorkbenchSkill): OfficeSkillSource => sources[skill.source];
export const officeSkillId = (skill: WorkbenchSkill) => `${sourceOf(skill)}:${skill.id}`;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const fail = (reason: string) => ({ ok: false as const, reason });

/** Document-scoped access to the existing library. Reads expose no local paths or
 * scripts; explicit card saves and copies require the authenticated parent. */
export class OfficeSkills {
  private readonly manager: SessionManager;
  private readonly opening = new Set<string>();
  private readonly cards: OfficeSkillCards;
  constructor(manager: SessionManager, store: Store) {
    this.manager = manager;
    this.cards = new OfficeSkillCards(manager, store, (context) => this.writable(context));
    // An uncertain handoff never silently starts a model after an app restart.
    for (const record of manager.creations.list()) {
      if (record.office?.state !== "queued") continue;
      manager.creations.update(record.requestId, { office: { ...record.office, state: "interrupted" } });
      manager.sink.upsertItem(record.sessionId, { kind: "notice", id: `office-template-recovered:${record.requestId}`, at: Date.now(), level: "info", text: `양식 사본을 보존했습니다. 요청은 자동 재전송하지 않았습니다.\n${record.office.handoff.text}` });
    }
  }
  private scope(context: Context) {
    const { artifactId, token, grants } = context;
    if (!grants.allows(token, artifactId)) throw new HttpError(401, "unauthorized", "이 문서의 스킬을 읽을 권한이 없습니다.");
    const artifact = this.manager.documents.get(artifactId), access = grants.access(token), sessionId = grants.session(token);
    const view = this.manager.documents.registry.list().find((item) => item.viewId === access?.viewId);
    if (!view || view.artifactId !== artifactId || view.sessionId !== sessionId) throw new HttpError(409, "office_view_changed", "문서 창이나 선택한 세션이 바뀌었습니다.");
    if (sessionId) this.manager.office.scope(artifactId, sessionId);
    return this.manager.skillScope(sessionId ?? undefined, artifact.workId, artifact.workspaceId ?? undefined);
  }
  private view(skill: WorkbenchSkill, all: WorkbenchSkill[]): OfficeSkillView {
    const shadowed = all.find((entry) => entry.id === skill.shadowedBy);
    return {
      id: officeSkillId(skill), source: sourceOf(skill), ...(skill.plugin ? { plugin: skill.plugin } : {}),
      name: skill.name, title: skill.title, description: skill.description,
      enabled: skill.state.enabled, invoke: skill.state.invoke, hidden: false, hasScripts: skill.hasScripts,
      ...(skill.template ? { template: skill.template.relativePath } : {}), templateExists: Boolean(skill.template?.exists),
      agentOnly: false, ...(skill.problem ? { unreadable: skill.problem } : {}), files: skill.files, bytes: skill.bytes,
      owned: skill.editable, ...(skill.shadowedBy ? { shadowedBy: shadowed ? officeSkillId(shadowed) : `app:${skill.shadowedBy}` } : {}),
      // Management stays in the authenticated Workbench library dialog.
      can: { edit: false, copyToMine: false, export: false, checkUpdate: false, openFolder: false, remove: false, hide: false },
    };
  }
  private async detail(id: unknown, scope: ReturnType<OfficeSkills["scope"]>) {
    if (!string(id, 100)) throw new HttpError(400, "office_skill_id", "스킬 번호가 올바르지 않습니다.");
    const all = await this.manager.userSkills.list(scope), entry = all.find((skill) => officeSkillId(skill) === id);
    if (!entry) return { failure: fail("not-found") };
    if (entry.problem) return { failure: fail("unreadable") };
    if (!entry.state.enabled || entry.shadowedBy) return { failure: fail("disabled") };
    const detail = await this.manager.userSkills.detail(entry.id, scope);
    // A state/source change while reading cannot revive a disabled or shadowed skill.
    if (!detail.skill.state.enabled || detail.skill.shadowedBy) return { failure: fail("disabled") };
    return { detail };
  }
  async read(context: Context, operation: string, input: unknown = {}) {
    const scope = this.scope(context), identity = JSON.stringify(scope);
    if (operation === "take-handoff") return this.take(context, input);
    if (operation === "suggest-name" || operation === "check-name") return this.cards.read(context, operation, input);
    const stillHere = () => { if (identity !== JSON.stringify(this.scope(context))) throw new HttpError(409, "office_skill_scope", "스킬을 읽는 동안 작업공간 또는 엔진 선택이 바뀌었습니다."); };
    if (operation === "list") {
      const all = await this.manager.userSkills.list(scope); stillHere();
      return all.map((entry) => this.view(entry, all));
    }
    if (!record(input)) throw new HttpError(400, "office_skill_input", "스킬 요청 형식이 올바르지 않습니다.");
    const result = await this.detail(input.id, scope); stillHere();
    if (result.failure) return result.failure;
    const { skill, body, sha256 } = result.detail!;
    const listed = await listSkillFolderFiles(skill.dir, { files: MAX_USER_SKILL_FILES, bytes: MAX_USER_SKILL_BYTES });
    stillHere();
    if (!listed || listed.tooLarge) return fail(listed ? "too-large" : "unreadable");
    if (operation === "ai-read-file") {
      if (!string(input.path, 1000)) return fail("outside");
      const path = input.path.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!path || isAbsolute(input.path) || /^[A-Za-z]:/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) return fail("outside");
      if (!SKILL_TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || path === IEUM_SOURCE_FILE) return fail("not-text");
      const file = listed.files.find((entry) => process.platform === "win32" ? entry.rel.toLowerCase() === path.toLowerCase() : entry.rel === path);
      if (!file) return fail("not-found");
      const bytes = await readSkillFile(skill.dir, file.path, 1_000_000); stillHere();
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("not-text"); }
      return { ok: true, text };
    }
    const value = { id: officeSkillId(skill), name: skill.name, title: skill.title, description: skill.description, body, sha256,
      ...(skill.template?.exists ? { template: skill.template.relativePath } : {}), hasScripts: skill.hasScripts };
    return { ok: true, skill: { ...value, files: operation === "read" ? listed.files.map(({ rel, size }) => ({ rel, size })) : listed.files.map((file) => file.rel).filter((rel) => rel !== "SKILL.md" && rel !== IEUM_SOURCE_FILE && SKILL_TEXT_EXTENSIONS.has(extname(rel).toLowerCase())) } };
  }
  writable(context: Context) {
    const scope = this.scope(context), sessionId = context.grants.session(context.token), access = context.grants.access(context.token);
    if (!sessionId || !scope.projectRoot) throw new HttpError(409, "office_session_required", "양식과 함께 사용할 대화를 먼저 연결해 주세요.");
    this.manager.documents.registry.assertWrite(context.artifactId, access);
    return { scope, sessionId, access: access!, artifact: this.manager.documents.get(context.artifactId) };
  }
  /** Only the authenticated Workbench parent routes creation and navigation here. */
  async action(context: Context, action: unknown, input: unknown) {
    const before = this.writable(context);
    if (!record(input)) throw new HttpError(400, "office_template_input", "양식 요청 형식이 올바르지 않습니다.");
    if (action === "save-card") return this.cards.save(context, input);
    if (action === "focus-tab") {
      const entry = this.manager.creations.list().find((item) => item.artifactId === input.tabId && item.sessionId === before.sessionId && item.office?.sourceArtifactId === context.artifactId && item.office.sourceViewId === before.access.viewId);
      if (!entry?.artifactId) return fail("not-found");
      this.manager.documents.get(entry.artifactId);
      return { ok: true, tabId: entry.artifactId };
    }
    if (action !== "open-template" || !string(input.requestId, 100) || !/^[A-Za-z0-9_-]+$/.test(input.requestId) || !string(input.text, 200_000) || !input.text.trim() || !string(input.skillId, 100) || !Array.isArray(input.chips) || input.chips.length < 1 || input.chips.length > 50) throw new HttpError(400, "office_template_input", "양식 요청을 확인해 주세요.");
    const requestId = `office-template:${input.requestId}`, fingerprint = createHash("sha256").update(JSON.stringify([context.artifactId, before.sessionId, before.access.viewId, input])).digest("hex");
    const previous = this.manager.creations.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.sessionId !== before.sessionId) throw new HttpError(409, "request_id_conflict", "다른 내용으로 양식 요청 번호를 재사용할 수 없습니다.");
      if (previous.artifactId) return { ok: true, tabId: previous.artifactId };
      throw new HttpError(409, "office_template_interrupted", "이미 준비한 사본을 확인해 주세요. 새 사본을 중복 생성하지 않았습니다.");
    }
    if (this.opening.has(before.access.viewId)) throw new HttpError(409, "office_template_busy", "이 문서에서 양식 사본을 준비 중입니다.");
    this.opening.add(before.access.viewId);
    try {
      const selected: OfficeStoredSkill[] = [];
      for (const chip of input.chips) {
        const found = await this.detail(record(chip) ? chip.id : undefined, before.scope);
        if (!found.detail) return found.failure!;
        const { skill, sha256 } = found.detail;
        if (selected.some((entry) => entry.id === officeSkillId(skill))) throw new HttpError(400, "office_template_input", "같은 스킬이 여러 번 선택되었습니다.");
        selected.push({ id: officeSkillId(skill), source: sourceOf(skill), title: skill.title, sha256 });
      }
      if (!selected.some((entry) => entry.id === input.skillId)) return fail("not-found");
      const found = await this.detail(input.skillId, before.scope);
      if (!found.detail) return found.failure!;
      const snapshot = await this.manager.userSkills.templateSnapshot(found.detail.skill.id, before.scope);
      const target = officeEditorKind(snapshot.format);
      if (!target) return fail("bad-template");
      const current = this.writable(context);
      if (current.sessionId !== before.sessionId || JSON.stringify(current.scope) !== JSON.stringify(before.scope)) throw new HttpError(409, "office_view_changed", "양식을 준비하는 동안 선택한 세션이 바뀌었습니다.");
      const copy = this.manager.creations.reserve({ requestId, sessionId: before.sessionId, workId: before.artifact.workId, workspaceId: before.artifact.workspaceId ?? null, fingerprint, cwd: before.scope.projectRoot!, target: { format: snapshot.format, name: snapshot.skill.title, template: { skillId: snapshot.skill.id, title: snapshot.skill.title, sha256: snapshot.sha256, skillSha256: snapshot.skillSha256 } }, sources: [{ artifactId: before.artifact.id, revision: before.artifact.revision }] }, { ...snapshot, skillDir: snapshot.skill.dir });
      const tracked = this.manager.documents.track(before.artifact.workId, copy.cwd, copy.path, "user", before.sessionId, "Office 양식 원본의 작업 사본", copy.sources);
      if (!tracked) throw new HttpError(500, "office_template_track", "양식 사본을 문서 목록에 연결하지 못했습니다. 생성 기록에 사본을 보존했습니다.");
      const office = { sourceArtifactId: context.artifactId, sourceViewId: before.access.viewId, state: "queued" as const, handoff: { id: requestId, mode: "skill" as const, target, text: input.text, chips: selected.map(({ id, source, title }) => ({ id, source, title })), createdAt: Date.now() } };
      this.manager.creations.update(requestId, { state: "completed", artifactId: tracked.artifact.id, office });
      this.manager.sink.upsertItem(before.sessionId, { kind: "artifact", id: `artifact:create:${requestId}`, artifactId: tracked.artifact.id, revision: tracked.artifact.revision, change: "created", at: Date.now() });
      return { ok: true, tabId: tracked.artifact.id };
    } finally { this.opening.delete(before.access.viewId); }
  }
  private take(context: Context, input: unknown) {
    const owner = this.writable(context);
    if (!record(input) || input.target !== officeEditorKind(owner.artifact.format)) return null;
    const entry = this.manager.creations.list().find((item) => item.artifactId === context.artifactId && item.sessionId === owner.sessionId && item.office?.state === "queued" && item.office.handoff.target === input.target);
    if (!entry?.office) return null;
    this.manager.creations.update(entry.requestId, { office: { ...entry.office, state: "taken", claimedViewId: owner.access.viewId } });
    return entry.office.handoff;
  }
  /** Revalidate the exact versions the composer read, before admitting a model run. */
  async prepare(context: Context, raw: unknown): Promise<{ text: string; skills: OfficeStoredSkill[]; skillReads: OfficeStoredSkill[] } | undefined> {
    if (raw === undefined) return undefined;
    if (!record(raw) || !string(raw.text, 2_000_000) || !raw.text.trim() || !Array.isArray(raw.chips) || raw.chips.length > 50 || (raw.reads !== undefined && !Array.isArray(raw.reads))) throw new HttpError(400, "office_skill_context", "스킬 요청 정보가 올바르지 않습니다.");
    const versions = raw.reads ?? [], chips = raw.chips;
    if (versions.length > 50) throw new HttpError(413, "office_skills_limit", "한 요청의 스킬 수가 너무 많습니다.");
    const scope = this.scope(context), identity = JSON.stringify(scope), reads: OfficeStoredSkill[] = [];
    for (const version of versions) {
      if (!record(version) || !string(version.id, 100) || typeof version.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(version.sha256) || reads.some((entry) => entry.id === version.id)) throw new HttpError(400, "office_skill_context", "스킬 판 정보가 올바르지 않습니다.");
      const found = await this.detail(version.id, scope);
      if (!found.detail || found.detail.sha256 !== version.sha256) throw new HttpError(409, "office_skill_changed", "선택한 스킬이 바뀌었거나 꺼졌습니다. 스킬을 다시 선택해 주세요.");
      const { skill, sha256 } = found.detail;
      reads.push({ id: officeSkillId(skill), source: sourceOf(skill), title: skill.title, sha256 });
    }
    const selected: OfficeStoredSkill[] = [];
    for (const chip of chips) {
      const read = record(chip) ? reads.find((entry) => entry.id === chip.id) : undefined;
      if (!read || selected.some((entry) => entry.id === read.id)) throw new HttpError(400, "office_skill_context", "선택한 스킬의 읽기 기록이 없습니다.");
      selected.push(read);
    }
    if (identity !== JSON.stringify(this.scope(context))) throw new HttpError(409, "office_skill_scope", "요청 중 선택한 작업공간이 바뀌었습니다.");
    return { text: raw.text, skills: selected, skillReads: reads };
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, token: string | null, grants: EditorGrants) {
    const match = /^\/api\/artifacts\/([^/]+)\/ai\/skills\/(list|read|ai-read|ai-read-file|take-handoff|suggest-name|check-name)$/.exec(url.pathname);
    if (!match) return false;
    const [, artifactId, operation] = match;
    if (req.method !== (operation === "list" ? "GET" : "POST")) throw new HttpError(405, "method_not_allowed", "허용되지 않은 스킬 요청입니다.");
    let input: unknown = {};
    if (operation !== "list") { try { input = JSON.parse((await readBody(req, 4000)).toString("utf8")); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "office_skill_input", "스킬 요청을 읽지 못했습니다."); } }
    res.setHeader("cache-control", "no-store");
    sendJson(res, 200, await this.read({ artifactId: artifactId!, token: token ?? "", grants }, operation!, input)); return true;
  }
}
