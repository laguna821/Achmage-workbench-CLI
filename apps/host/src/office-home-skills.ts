import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { OfficeSkillHandoff, OfficeStoredSkill } from "../../../packages/contracts/src/office-skills.ts";
import { OfficeSkillCards } from "./office-skill-cards.ts";
import { officeSkillId, type OfficeSkills, type OfficeSkillAccess } from "./office-skills.ts";
import type { SessionManager } from "./sessions.ts";
import type { Store } from "./store.ts";
import { officeEditorKind } from "./editors.ts";
import { reservePath } from "./create.ts";
import { HttpError } from "./errors.ts";

type Destination = { workId: string; workspaceId?: string };
export type HomeSkillContext = { owner: string; destination?: Destination; assertAlive(): void };
type TemplateRecord = { version: 1; owner: string; fingerprint: string; path: string; workId: string; workspaceId: string | null;
  state: "preparing" | "queued" | "taken" | "interrupted"; artifactId?: string; sessionId?: string; handoff: OfficeSkillHandoff };
const PREFIX = "office-home-template:";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const invalid = () => new HttpError(400, "knowledge_skill_request", "지식베이스 스킬 요청을 확인해 주세요.");

/** Home cards use the same checked saves as document cards, without inventing a
 * document/session. Template copies acquire a real document child only after creation. */
export class OfficeHomeSkills {
  private readonly cards: OfficeSkillCards<HomeSkillContext>;
  private readonly opening = new Set<string>();
  private readonly manager: SessionManager;
  private readonly store: Store;
  private readonly library: OfficeSkills;
  constructor(manager: SessionManager, store: Store, library: OfficeSkills) {
    this.manager = manager; this.store = store; this.library = library;
    this.cards = new OfficeSkillCards(manager, store, context => ({ scope: this.scope(context), ownerId: context.owner, sessionId: null, artifactId: null }), "office-home-skill-card:");
    for (const { key, value } of this.entries()) {
      if (value.state !== "queued" && value.state !== "preparing") continue;
      this.store.setMeta(key, JSON.stringify({ ...value, state: "interrupted" }));
      if (value.sessionId) this.manager.sink.upsertItem(value.sessionId, { kind: "notice", id: key + ":recovered", level: "info", text: `지식베이스 양식 사본을 보존했습니다. 요청은 자동 재전송하지 않았습니다.\n${value.handoff.text}`, at: Date.now() });
    }
  }
  private entries() {
    return this.store.metaEntries(PREFIX).map(entry => {
      const value = JSON.parse(entry.value) as TemplateRecord;
      if (value.version !== 1) throw new HttpError(409, "knowledge_template_version", "양식 생성 기록의 버전을 확인해 주세요. 기록은 보존했습니다.");
      return { key: entry.key, value };
    });
  }
  private destination(context: HomeSkillContext) {
    context.assertAlive();
    const input = context.destination;
    if (!record(input) || !string(input.workId, 100) || (input.workspaceId !== undefined && !string(input.workspaceId, 100))) throw new HttpError(400, "knowledge_destination", "양식을 열 프로젝트를 선택해 주세요.");
    return this.manager.documentDestination(input.workId, input.workspaceId);
  }
  private scope(context: HomeSkillContext) {
    context.assertAlive();
    if (!context.destination) return this.manager.skillScope();
    this.destination(context);
    return this.manager.skillScope(undefined, context.destination.workId, context.destination.workspaceId);
  }
  async invoke(context: HomeSkillContext, operation: string, input: unknown = {}) {
    context.assertAlive();
    if (["list", "read", "ai-read", "ai-read-file"].includes(operation)) return this.library.readLibrary(() => this.scope(context), operation, input);
    if (operation === "suggest-name" || operation === "check-name") return this.cards.read(context, operation, input);
    if (operation === "save-card") {
      if (!record(input) || input.template !== undefined || record(input.card) && input.card.previewId !== undefined) throw invalid();
      return this.cards.save(context, input);
    }
    if (operation === "open-template") return this.open(context, input);
    if (operation === "focus-tab") {
      if (!record(input) || !string(input.tabId, 100)) throw invalid();
      const owned = this.entries().find(({ value }) => value.owner === context.owner && value.artifactId === input.tabId);
      if (!owned) throw new HttpError(403, "knowledge_template_scope", "이 지식베이스 창에서 만든 양식만 열 수 있습니다.");
      this.manager.documents.get(input.tabId);
      return { ok: true, tabId: input.tabId };
    }
    throw invalid();
  }
  private async detail(id: unknown, scope: ReturnType<SessionManager["skillScope"]>) {
    if (!string(id, 100)) throw invalid();
    const all = await this.manager.userSkills.list(scope), item = all.find(skill => officeSkillId(skill) === id);
    if (!item || item.problem || !item.state.enabled || item.shadowedBy) throw new HttpError(409, "office_skill_changed", "선택한 스킬이 바뀌었거나 꺼졌습니다. 다시 선택해 주세요.");
    const detail = await this.manager.userSkills.detail(item.id, scope);
    if (detail.skill.problem || !detail.skill.state.enabled || detail.skill.shadowedBy) throw new HttpError(409, "office_skill_changed", "선택한 스킬이 바뀌었습니다.");
    return detail;
  }
  private async open(context: HomeSkillContext, input: unknown) {
    if (!record(input) || !string(input.requestId, 100) || !/^[\w-]+$/.test(input.requestId) || !string(input.skillId, 100) || !string(input.text, 200_000) || !input.text.trim() || !Array.isArray(input.chips) || !input.chips.length || input.chips.length > 50) throw invalid();
    const work = this.destination(context), folder = realpathSync(work.cwd), scope = this.scope(context);
    const key = PREFIX + hash(context.owner + ":" + input.requestId), fingerprint = hash(JSON.stringify([context.owner, context.destination, input]));
    const raw = this.store.getMeta(key);
    if (raw) {
      const previous = JSON.parse(raw) as TemplateRecord;
      if (previous.fingerprint !== fingerprint) throw new HttpError(409, "request_id_conflict", "다른 내용으로 양식 요청 번호를 재사용할 수 없습니다.");
      if (previous.artifactId) { this.manager.documents.get(previous.artifactId); return { ok: true, tabId: previous.artifactId }; }
      throw new HttpError(409, "knowledge_template_interrupted", `앞서 준비한 사본을 확인해 주세요. 중복 생성하지 않았습니다: ${previous.path}`);
    }
    if (this.opening.has(context.owner)) throw new HttpError(409, "knowledge_template_busy", "양식 사본을 준비 중입니다.");
    this.opening.add(context.owner);
    try {
      const selected: OfficeStoredSkill[] = [];
      for (const chip of input.chips) {
        const found = await this.detail(record(chip) ? chip.id : undefined, scope), id = officeSkillId(found.skill);
        if (selected.some(skill => skill.id === id)) throw invalid();
        selected.push({ id, title: found.skill.title, source: id.split(":")[0] as OfficeStoredSkill["source"], sha256: found.sha256 });
      }
      if (!selected.some(skill => skill.id === input.skillId)) throw invalid();
      const chosen = await this.detail(input.skillId, scope), snapshot = await this.manager.userSkills.templateSnapshot(chosen.skill.id, scope);
      const target = officeEditorKind(snapshot.format);
      if (!target) return { ok: false, reason: "bad-template" };
      // Every chip is rechecked after asynchronous file reads; an old list cannot revive it.
      for (const selectedSkill of selected) if ((await this.detail(selectedSkill.id, scope)).sha256 !== selectedSkill.sha256) throw new HttpError(409, "office_skill_changed", "양식을 준비하는 동안 스킬이 바뀌었습니다.");
      const current = this.destination(context);
      if (current.cwd !== work.cwd || realpathSync(current.cwd) !== folder || JSON.stringify(this.scope(context)) !== JSON.stringify(scope)) throw new HttpError(409, "knowledge_destination_changed", "양식을 열 작업공간이 바뀌었습니다.");
      if (hash(readFileSync(snapshot.path)) !== snapshot.sha256 || snapshot.skillSha256 !== chosen.sha256) throw new HttpError(409, "template_changed", "선택한 양식 판이 바뀌었습니다.");
      const name = snapshot.skill.title.replace(/[. ]+$/, "") || "새 문서";
      const path = reservePath(folder, { format: snapshot.format, name: /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? "_" + name : name, extension: extname(snapshot.path) || undefined });
      this.manager.documents.registry.assertPath(path);
      const handoff: OfficeSkillHandoff = { id: key, mode: "skill", target, text: input.text, chips: selected.map(({ id, source, title }) => ({ id, source, title })), createdAt: Date.now() };
      const pending: TemplateRecord = { version: 1, owner: context.owner, fingerprint, path, workId: work.id, workspaceId: context.destination?.workspaceId ?? work.defaultWorkspaceId ?? null, state: "preparing", handoff };
      this.store.setMeta(key, JSON.stringify(pending));
      copyFileSync(snapshot.path, path, constants.COPYFILE_EXCL);
      if (!(statSync(path).mode & 0o200)) chmodSync(path, 0o600);
      if (hash(readFileSync(path)) !== snapshot.sha256) throw new HttpError(409, "template_changed", "양식 사본의 내용을 확인할 수 없습니다. 사본은 보존했습니다.");
      const artifact = this.manager.openFile(work.id, path, context.destination?.workspaceId);
      const child = this.manager.documentSession(artifact.id, null);
      this.store.setMeta(key, JSON.stringify({ ...pending, artifactId: artifact.id, sessionId: child.id, state: "queued" } satisfies TemplateRecord));
      this.manager.sink.upsertItem(child.id, { kind: "artifact", id: key + ":artifact", artifactId: artifact.id, revision: artifact.revision, change: "created", at: Date.now() });
      return { ok: true, tabId: artifact.id };
    } finally { this.opening.delete(context.owner); }
  }
  /** Called only after the existing document writer/session checks. */
  take(owner: OfficeSkillAccess, target: unknown) {
    const entry = this.entries().find(({ value }) => value.state === "queued" && value.artifactId === owner.artifact.id && value.sessionId === owner.sessionId && value.handoff.target === target);
    if (!entry) return null;
    this.store.setMeta(entry.key, JSON.stringify({ ...entry.value, state: "taken" }));
    return entry.value.handoff;
  }
}
