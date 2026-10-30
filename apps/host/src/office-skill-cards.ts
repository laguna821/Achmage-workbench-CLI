import { createHash } from "node:crypto";
import type { TranscriptItem } from "@workbench/contracts";
import { skillContentHash } from "../../../third_party/ieumoffice/user-skills/folder.ts";
import { suggestUserSkillName, validateNewUserSkillName } from "../../../third_party/ieumoffice/user-skills/names.ts";
import { MAX_USER_SKILL_BYTES } from "../../../third_party/ieumoffice/user-skills/constants.ts";
import type { SessionManager } from "./sessions.ts";
import type { Store } from "./store.ts";
import { HttpError } from "./errors.ts";
import { officeSkillId, type OfficeSkillAccess, type OfficeSkillContext } from "./office-skills.ts";
import { saveSkillCard, type SkillCardInput, type SkillCardRevision } from "./skill-card-library.ts";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
type Receipt = { identity: string; targetId?: string; label: string; name: string; revisions: SkillCardRevision[] };
type Saved = { version: 1; fingerprint: string; sessionId: string; artifactId: string; status: "saving" | "interrupted" | "failed" | "completed"; result?: { ok: true; id: string }; item?: TranscriptItem };

/** The original card's explicit Save is the sole write boundary. Name checks
 * pin the source revisions; saved receipts and chat rows share Workbench storage. */
export class OfficeSkillCards {
  private readonly checked = new Map<string, Receipt>();
  private readonly saving = new Set<string>();
  private readonly manager: SessionManager;
  private readonly store: Store;
  private readonly access: (context: OfficeSkillContext) => OfficeSkillAccess;
  constructor(manager: SessionManager, store: Store, access: (context: OfficeSkillContext) => OfficeSkillAccess) {
    this.manager = manager; this.store = store; this.access = access;
    for (const entry of store.metaEntries("office-skill-card:")) {
      const saved = this.saved(entry.value);
      if (saved.status === "saving") {
        this.store.setMeta(entry.key, JSON.stringify({ ...saved, status: "interrupted" }));
        this.manager.sink.upsertItem(saved.sessionId, { kind: "notice", id: `${entry.key}:recovered`, level: "info", text: "스킬 저장이 중단되었습니다. 보관함과 백업에서 결과를 확인해 주세요. 저장은 자동 반복하지 않았습니다.", at: Date.now() });
      }
      // Recover a completed save's notification after a crash between commit and publish.
      if (saved.status === "completed" && saved.item) this.manager.sink.upsertItem(saved.sessionId, saved.item);
    }
  }
  private saved(raw: string): Saved {
    const value = JSON.parse(raw) as Saved;
    if (value.version !== 1) throw new HttpError(409, "office_skill_version", "스킬 저장 기록의 버전을 확인해 주세요. 기록은 보존했습니다.");
    return value;
  }
  private identity(access: OfficeSkillAccess) { return JSON.stringify([access.scope, access.sessionId, access.artifact.id, access.access.viewId]); }
  private card(raw: unknown) {
    if (!record(raw) || !string(raw.id, 100) || !/^[A-Za-z0-9_-]+$/.test(raw.id) || !string(raw.label, 512) || !raw.label.trim() || (raw.targetId !== undefined && !string(raw.targetId, 100))) throw new HttpError(400, "office_skill_card", "스킬 카드 정보를 확인해 주세요.");
    return { id: raw.id, label: raw.label, targetId: raw.targetId as string | undefined };
  }
  async read(context: OfficeSkillContext, operation: string, input: unknown) {
    const before = this.access(context), identity = this.identity(before);
    const current = () => { if (identity !== this.identity(this.access(context))) throw new HttpError(409, "office_skill_scope", "카드를 확인하는 동안 문서나 대화가 바뀌었습니다."); };
    if (!record(input)) throw new HttpError(400, "office_skill_card", "스킬 카드 요청이 올바르지 않습니다.");
    const all = await this.manager.userSkills.list(before.scope); current();
    if (operation === "suggest-name") {
      if (!string(input.title, 512)) throw new HttpError(400, "office_skill_card", "스킬 제목이 올바르지 않습니다.");
      return suggestUserSkillName(input.title, { taken: all.map((s) => s.name) });
    }
    const card = this.card(input.card), key = hash(identity + card.id), target = all.find((s) => officeSkillId(s) === card.targetId);
    if (!string(input.name, 200)) throw new HttpError(400, "office_skill_card", "스킬 이름이 올바르지 않습니다.");
    if (card.targetId && (!target || target.source === "project" || target.problem || !target.editable && target.shadowedBy)) throw new HttpError(409, "office_skill_target", "변경할 스킬을 다시 확인해 주세요.");
    const old = this.checked.get(key);
    if (old && (old.targetId !== card.targetId || old.label !== card.label)) throw new HttpError(409, "office_skill_card", "다른 제안으로 카드 번호를 재사용할 수 없습니다.");
    const name = input.name.trim(), revisions = old?.revisions.filter((r) => r.id === target?.id) ?? [];
    for (const skill of all.filter((s) => s.id === target?.id || s.editable && s.name.toLowerCase() === name.toLowerCase())) {
      if (revisions.some((r) => r.id === skill.id)) continue;
      const detail = await this.manager.userSkills.detail(skill.id, before.scope);
      revisions.push({ id: skill.id, sha256: detail.sha256, folderHash: await skillContentHash(skill.dir) });
    }
    current();
    if (this.checked.size >= 256 && !old) this.checked.delete(this.checked.keys().next().value!);
    this.checked.set(key, { identity, targetId: card.targetId, label: card.label, name, revisions });
    const problem = validateNewUserSkillName(name);
    if (problem && name !== target?.name) return { ok: false, problem };
    const collision = all.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== target?.id && (s.editable || name !== target?.name));
    return collision ? { ok: false, problem: "taken" } : { ok: true };
  }
  async save(context: OfficeSkillContext, input: unknown) {
    const before = this.access(context), identity = this.identity(before);
    if (!record(input)) throw new HttpError(400, "office_skill_card", "스킬 저장 요청이 올바르지 않습니다.");
    const card = this.card(input.card), key = hash(identity + card.id), storeKey = `office-skill-card:${key}`;
    for (const [field, limit] of [["name", 200], ["title", 512], ["description", 16_000], ["body", 256_000]] as const) if (!string(input[field], limit)) throw new HttpError(400, "office_skill_card", "스킬 내용과 길이를 확인해 주세요.");
    if (!["auto", "manual"].includes(input.invoke as string) || input.targetId !== card.targetId || input.overwrite !== undefined && typeof input.overwrite !== "boolean") throw new HttpError(400, "office_skill_card", "스킬 선택과 대상을 확인해 주세요.");
    let template: SkillCardInput["template"];
    if (input.template !== undefined) {
      if (!record(input.template) || !string(input.template.fileName, 200) || !string(input.template.base64, Math.ceil(MAX_USER_SKILL_BYTES / 3) * 4) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.template.base64)) throw new HttpError(400, "bad_template", "양식 파일을 읽지 못했습니다.");
      template = { fileName: input.template.fileName, bytes: Buffer.from(input.template.base64, "base64") };
    }
    const fingerprint = hash(JSON.stringify([card, input.name, input.title, input.description, input.body, input.invoke, input.overwrite ?? false, input.template ?? null]));
    const raw = this.store.getMeta(storeKey), saved = raw ? this.saved(raw) : null;
    if (saved && saved.status !== "failed") {
      if (saved.fingerprint !== fingerprint) throw new HttpError(409, "request_id_conflict", "이미 저장한 카드와 다른 요청입니다.");
      if (saved.status === "completed" && saved.result) return saved.result;
      throw new HttpError(409, "office_skill_interrupted", "저장 결과를 보관함에서 확인해 주세요. 같은 사본을 다시 쓰지 않았습니다.");
    }
    if (this.saving.has(key)) throw new HttpError(409, "office_skill_busy", "이 카드를 저장 중입니다.");
    const checked = this.checked.get(key);
    if (!checked || checked.identity !== identity || checked.targetId !== card.targetId || checked.label !== card.label || checked.name !== (input.name as string).trim()) throw new HttpError(409, "office_skill_unchecked", "카드 이름과 현재 스킬 판을 다시 확인해 주세요.");
    this.saving.add(key);
    const pending: Saved = { version: 1, fingerprint, sessionId: before.sessionId, artifactId: before.artifact.id, status: "saving" };
    let committing = false;
    try {
      this.store.setMeta(storeKey, JSON.stringify(pending));
      const all = await this.manager.userSkills.list(before.scope), target = all.find((s) => officeSkillId(s) === card.targetId);
      if (card.targetId && !target) throw new HttpError(409, "office_skill_target", "변경할 스킬을 찾지 못했습니다.");
      const result = await saveSkillCard(this.manager.userSkills, { name: input.name as string, title: input.title as string, description: input.description as string, body: input.body as string, invoke: input.invoke as "auto" | "manual", targetId: target?.id, overwrite: input.overwrite as boolean | undefined, template }, before.scope, checked.revisions,
        () => { if (identity !== this.identity(this.access(context))) throw new HttpError(409, "office_skill_scope", "저장 전에 선택한 문서나 대화가 바뀌었습니다."); }, () => { committing = true; });
      const answer = { ok: true as const, id: officeSkillId(result) };
      const item: TranscriptItem = { kind: "tool", tool: "mcp", id: `office-skill-card:${key}`, title: card.label, detail: "propose_skill\n{}", output: `skill-card-saved:${answer.id}`, status: "completed", at: Date.now(), office: { turnId: `skill-card:${card.id}`, artifactId: before.artifact.id, cardSaved: { skillId: answer.id, label: card.label } } };
      this.store.setMeta(storeKey, JSON.stringify({ ...pending, status: "completed", result: answer, item } satisfies Saved));
      this.manager.sink.upsertItem(before.sessionId, item);
      return answer;
    } catch (error) {
      if (this.store.getMeta(storeKey) === JSON.stringify(pending)) this.store.setMeta(storeKey, JSON.stringify({ ...pending, status: committing ? "interrupted" : "failed" }));
      throw error;
    } finally { this.saving.delete(key); }
  }
}
