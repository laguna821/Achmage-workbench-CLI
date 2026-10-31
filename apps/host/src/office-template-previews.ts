import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { formatOf, type DocumentAccess } from "@workbench/contracts";
import type { OfficeTemplatePreview } from "../../../packages/contracts/src/office-skills.ts";
import type { SessionManager } from "./sessions.ts";
import type { CreationRecord } from "./creation-journal.ts";
import type { OfficeSkillCards } from "./office-skill-cards.ts";
import type { Store } from "./store.ts";
import type { OfficeSkillAccess, OfficeSkillContext } from "./office-skills.ts";
import { officeEditorKind } from "./editors.ts";
import { HttpError } from "./errors.ts";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const invalid = () => new HttpError(400, "office_preview_input", "양식 미리보기의 내용과 파일 이름을 확인해 주세요.");

/** A preview is a durable working document, with a separate immutable original.
 * Only the card's committed Save can mark it saved; closing/cancelling never writes a skill. */
export class OfficeTemplatePreviews {
  private readonly manager: SessionManager;
  private readonly cards: OfficeSkillCards;
  private readonly access: (context: OfficeSkillContext) => OfficeSkillAccess;
  private readonly saving = new Set<string>();
  constructor(manager: SessionManager, store: Store, cards: OfficeSkillCards, access: (context: OfficeSkillContext) => OfficeSkillAccess) {
    this.manager = manager; this.cards = cards; this.access = access;
    // The card commit may have succeeded just before the process stopped.
    for (const entry of manager.creations.list()) {
      if (entry.office?.preview?.status !== "open" || !entry.artifactId) continue;
      const saved = store.metaEntries("office-skill-card:").map(({ value }) => JSON.parse(value)).find((value) => value.status === "completed" && value.sessionId === entry.sessionId && value.artifactId === entry.artifactId && value.previewId === entry.requestId)?.item;
      if (saved?.kind === "tool" && saved.office?.cardSaved) this.end(entry, "saved", { skillId: saved.office.cardSaved.skillId, title: saved.office.cardSaved.label });
    }
  }
  private forArtifact(artifactId: string) { return this.manager.creations.list().find((item) => item.artifactId === artifactId && item.office?.preview); }
  private current(context: OfficeSkillContext, open = true) {
    const owner = this.access(context), entry = this.forArtifact(context.artifactId);
    if (!entry) return null;
    if (entry.sessionId !== owner.sessionId) throw new HttpError(409, "office_preview_session", "양식을 만들던 대화에서 이어서 진행해 주세요.");
    if (open && entry.office?.preview?.status !== "open") throw new HttpError(409, "office_preview_ended", "이미 끝난 양식 미리보기입니다. 문서 사본은 그대로 보존했습니다.");
    return entry;
  }
  receipt(context: OfficeSkillContext, previewId: unknown) {
    if (previewId === undefined) return undefined;
    const entry = this.current(context);
    if (!entry || entry.requestId !== previewId) throw invalid();
    return entry.office?.preview?.receipt;
  }
  async open(context: OfficeSkillContext, input: Record<string, unknown>) {
    const owner = this.access(context), proposal = input.proposal, draft = input.draft, card = input.card;
    if (!string(input.requestId, 100) || !/^[A-Za-z0-9_-]+$/.test(input.requestId) || !string(input.fileName, 200) || !input.fileName || /[\\/\x00-\x1f<>:"|?*]/.test(input.fileName) || /[. ]$/.test(input.fileName)
      || !string(input.base64, Math.ceil(64 * 1024 * 1024 / 3) * 4) || !string(input.title, 512) || !string(input.tabTitle, 512) || !string(input.text, 200_000) || !input.text.trim() || typeof input.originalRedacted !== "boolean" || !record(proposal) || !record(draft) || !record(card)) throw invalid();
    for (const item of [proposal, draft]) for (const [field, max] of [["name", 200], ["title", 512], ["description", 16000], ["body", 256000]] as const) if (!string(item[field], max)) throw invalid();
    if (!string(proposal.key, 512) || !proposal.key || !["auto", "manual"].includes(draft.invoke as string) || card.label !== (proposal.name || proposal.title)) throw invalid();
    let target: OfficeTemplatePreview["proposal"]["target"];
    if (proposal.target !== undefined) {
      const t = proposal.target;
      if (!record(t) || !string(t.id, 100) || !string(t.name, 200) || !string(t.title, 512) || !string(t.source, 30) || typeof t.owned !== "boolean") throw invalid();
      target = { id: t.id, name: t.name, title: t.title, source: t.source, owned: t.owned };
    }
    if (card.targetId !== target?.id) throw invalid();
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.byteLength > 64 * 1024 * 1024 || bytes.toString("base64") !== input.base64) throw invalid();
    const format = formatOf(input.fileName), editor = format && officeEditorKind(format);
    if (!format || !editor || editor !== officeEditorKind(owner.artifact.format)) throw invalid();
    const requestId = `office-preview:${input.requestId}`, fingerprint = hash(JSON.stringify([owner.sessionId, owner.scope, context.artifactId, owner.access.viewId, input]));
    const prior = this.manager.creations.get(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HttpError(409, "request_id_conflict", "다른 내용으로 미리보기 요청 번호를 재사용할 수 없습니다.");
      if (prior.artifactId) return { ok: true as const, previewId: requestId, tabId: prior.artifactId };
      throw new HttpError(409, "office_preview_interrupted", "이미 준비한 사본을 확인해 주세요. 중복 생성하지 않았습니다.");
    }
    const receipt = this.cards.capture(context, card, (draft.name as string).trim());
    const existing = this.manager.creations.list().find((entry) => entry.sessionId === owner.sessionId && entry.office?.sourceArtifactId === context.artifactId && entry.office.preview?.status === "open" && entry.office.handoff.preview?.proposal.key === proposal.key);
    if (existing?.artifactId) return { ok: true as const, previewId: existing.requestId, tabId: existing.artifactId };
    const preview: OfficeTemplatePreview = { previewId: requestId, title: input.title, fileName: input.fileName, originalRedacted: input.originalRedacted,
      proposal: { key: proposal.key, name: proposal.name as string, title: proposal.title as string, description: proposal.description as string, body: proposal.body as string, wantsTemplate: true, ...(target ? { target } : {}) },
      draft: { name: draft.name as string, title: draft.title as string, description: draft.description as string, body: draft.body as string, invoke: draft.invoke as "auto" | "manual" } };
    const snapshot = this.manager.creations.snapshot(bytes);
    const office: NonNullable<CreationRecord["office"]> = { sourceArtifactId: context.artifactId, sourceViewId: owner.access.viewId, state: "queued",
      handoff: { id: requestId, mode: "skill", target: editor, text: input.text, chips: [], createdAt: Date.now(), preview }, preview: { original: snapshot, receipt, status: "open" } };
    const copy = this.manager.creations.reserve({ requestId, sessionId: owner.sessionId, workId: owner.artifact.workId, workspaceId: owner.artifact.workspaceId ?? null, fingerprint, cwd: owner.scope.projectRoot!,
      target: { format, name: input.tabTitle, extension: extname(input.fileName).toLowerCase() }, sources: [{ artifactId: owner.artifact.id, revision: owner.artifact.revision }], office }, snapshot);
    const tracked = this.manager.documents.track(owner.artifact.workId, copy.cwd, copy.path, "user", owner.sessionId, "현재 문서의 양식 미리보기 사본", copy.sources);
    if (!tracked) throw new HttpError(500, "office_preview_track", "양식 사본을 문서 목록에 연결하지 못했습니다. 생성 기록에 사본을 보존했습니다.");
    this.manager.creations.update(requestId, { state: "completed", artifactId: tracked.artifact.id });
    this.manager.sink.upsertItem(owner.sessionId, { kind: "artifact", id: `artifact:create:${requestId}`, artifactId: tracked.artifact.id, revision: tracked.artifact.revision, change: "created", at: Date.now() });
    return { ok: true as const, tabId: tracked.artifact.id, previewId: requestId };
  }
  original(context: OfficeSkillContext, input: Record<string, unknown>) {
    const entry = this.current(context);
    if (!entry?.office?.preview || entry.requestId !== input.previewId) throw invalid();
    if (entry.office.handoff.preview?.originalRedacted !== false) throw new HttpError(403, "office_preview_redacted", "가림 표시가 있는 원본은 그대로 저장할 수 없습니다.");
    const snapshot = entry.office.preview.original, bytes = readFileSync(snapshot.path);
    if (hash(bytes) !== snapshot.sha256) throw new HttpError(409, "office_preview_changed", "보관한 원본의 내용이 바뀌었습니다. 파일을 보존했습니다.");
    return { ok: true as const, base64: bytes.toString("base64"), fileName: entry.office.handoff.preview.fileName };
  }
  take(context: OfficeSkillContext, target: unknown) {
    const entry = this.current(context, false), office = entry?.office;
    if (!entry || !office || office.handoff.target !== target || office.preview?.status !== "open") return null;
    const resumed = office.state !== "queued";
    this.manager.creations.update(entry.requestId, { office: { ...office, state: "taken", claimedViewId: this.access(context).access.viewId } });
    return { ...office.handoff, resumed };
  }
  links(context: OfficeSkillContext) {
    const owner = this.access(context);
    return this.manager.creations.list().flatMap((entry) => {
      const office = entry.office, preview = office?.preview;
      return entry.sessionId === owner.sessionId && office?.sourceArtifactId === context.artifactId && preview && entry.artifactId
        ? [{ previewId: entry.requestId, tabId: entry.artifactId, outcome: preview.status, label: preview.receipt.label, skillId: preview.skillId, title: preview.title || office.handoff.preview?.draft?.name || preview.receipt.name }] : [];
    });
  }
  events(context: OfficeSkillContext) { return this.links(context).filter((entry) => entry.outcome !== "open"); }
  private end(entry: CreationRecord, status: "saved" | "unsaved", saved?: { skillId: string; title: string }) {
    if (entry.office?.preview?.status === "open") this.manager.creations.update(entry.requestId, { office: { ...entry.office, preview: { ...entry.office.preview, status, ...saved } } });
    return { ok: true as const };
  }
  finish(context: OfficeSkillContext, input: Record<string, unknown>) {
    const entry = this.current(context, false);
    if (!entry || entry.requestId !== input.previewId || !["saved", "unsaved"].includes(input.outcome as string)) throw invalid();
    if (this.saving.has(entry.requestId)) throw new HttpError(409, "office_preview_saving", "양식을 저장 중입니다. 저장 결과를 기다려 주세요.");
    if (input.outcome === "saved") {
      if (entry.office?.preview?.status !== "saved" || !record(input.saved) || input.saved.skillId !== entry.office.preview.skillId) throw new HttpError(409, "office_preview_not_saved", "스킬의 저장 결과를 확인하지 못했습니다.");
      return { ok: true as const };
    }
    return this.end(entry, "unsaved");
  }
  async save<T extends { ok: boolean; id?: string }>(context: OfficeSkillContext, previewId: unknown, title: string, run: (completedOnly: boolean) => Promise<T>): Promise<T> {
    if (previewId === undefined) return run(false);
    const entry = this.current(context, false);
    if (!entry || entry.requestId !== previewId) throw invalid();
    if (entry.office?.preview?.status === "saved") return run(true);
    if (entry.office?.preview?.status !== "open") throw new HttpError(409, "office_preview_ended", "이미 끝난 양식 미리보기입니다.");
    if (this.saving.has(entry.requestId)) throw new HttpError(409, "office_preview_saving", "양식을 저장 중입니다.");
    this.saving.add(entry.requestId);
    try { const result = await run(false); if (result.ok && result.id) this.end(entry, "saved", { skillId: result.id, title }); return result; }
    finally { this.saving.delete(entry.requestId); }
  }
  close(artifactId: string, access: DocumentAccess | undefined) {
    const entry = this.forArtifact(artifactId);
    if (!entry?.office?.preview || entry.office.preview.status !== "open") return { ok: true as const };
    if (!access) throw new HttpError(401, "office_preview_access", "미리보기 창의 닫기 권한을 확인하지 못했습니다.");
    this.manager.documents.registry.assertWrite(artifactId, access);
    if (this.saving.has(entry.requestId)) throw new HttpError(409, "office_preview_saving", "양식을 저장 중입니다. 저장 결과를 기다려 주세요.");
    return this.end(entry, "unsaved");
  }
}
