import { basename, extname } from "node:path";
import type { OfficeOutputPlan } from "../../../../packages/contracts/src/office-output.ts";
import type { OfficeBinding, OfficeSessions } from "../office-sessions.ts";
import type { Documents } from "../artifacts.ts";
import { OfficeOutputs } from "../office-output.ts";
import { HttpError } from "../errors.ts";

type Pending = { format: string; revision: number; name: string; longJob: boolean; plan?: OfficeOutputPlan; question: string; cancelled: boolean };
const invalid = () => new HttpError(400, "office_executor_output", "문서 결과의 저장 요청을 확인해 주세요.");
/** A renderer cannot select a filesystem destination itself. The same durable
 * transcript question supplies the human-selected path and overwrite decision. */
export class OfficeExecutorOutputs {
  private readonly pending = new Map<string, Pending>();
  private readonly plans = new Map<string, { turnId: string; plan: OfficeOutputPlan }>();
  private readonly documents: Documents;
  private readonly sessions: OfficeSessions;
  private readonly outputs: OfficeOutputs;
  constructor(documents: Documents, sessions: OfficeSessions, outputs: OfficeOutputs) {
    this.documents = documents; this.sessions = sessions; this.outputs = outputs;
  }
  prepare(binding: OfficeBinding, turnId: string, request: Record<string, unknown>) {
    const run = this.sessions.requireRun(binding, turnId);
    if (typeof request.requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(request.requestId)) throw invalid();
    const key = turnId + ":" + request.requestId;
    let entry = this.pending.get(key);
    if (!entry) {
      const artifact = this.documents.get(binding.artifactId);
      if (typeof request.format !== "string" || !["hwp", "hwpx", "pdf", "docx", "odt", "pptx", "xlsx", "xlsm", "md", "markdown", "html", "htm", "xmind", "epub"].includes(request.format)
        || !Number.isSafeInteger(request.revision) || Number(request.revision) < 1 || Number(request.revision) > artifact.revision) throw invalid();
      const name = typeof request.defaultName === "string" && request.defaultName.trim() && request.defaultName.length <= 4096
        ? request.defaultName : basename(artifact.path, extname(artifact.path)) + "-결과." + request.format;
      entry = { format: request.format, revision: Number(request.revision), name, longJob: request.longJob === true, question: "output_" + request.requestId, cancelled: false };
      this.pending.set(key, entry);
      const captured = entry;
      run.controller.signal.addEventListener("abort", () => {
        if (captured.plan) { this.outputs.cancel(binding.artifactId, captured.plan.id, run.lease.access); this.plans.delete(captured.plan.id); }
        this.pending.delete(key);
      }, { once: true });
    }
    if (entry.cancelled) return null;
    const answer = this.sessions.question(run, { turnId, id: entry.question,
      prompt: "결과 파일의 저장 위치를 선택해 주세요. 원본 옆의 기본 이름: " + entry.name,
      fields: [{ id: "path", prompt: "파일 이름 또는 전체 경로 (빈칸이면 위 기본 이름)", required: false }] });
    if (answer.decision === null) return { pending: true };
    if (answer.decision !== "accept") { entry.cancelled = true; return null; }
    if (!entry.plan) {
      const selected = answer.response?.path;
      if (selected !== undefined && typeof selected !== "string") throw invalid();
      const plan = this.outputs.prepare(binding.artifactId, entry.revision, selected?.trim() || entry.name, run.lease.access, entry.longJob);
      entry.plan = { id: plan.id, path: plan.path, format: plan.format, replace: false, longJob: entry.longJob };
      this.plans.set(plan.id, { turnId, plan: entry.plan });
      if (plan.exists) this.sessions.question(run, { turnId, id: entry.question + "_replace", prompt: "이미 있는 파일을 바꿀까요? 이전 파일은 백업합니다.\n" + plan.path });
    }
    const replaceId = "office-question:" + turnId + ":" + entry.question + "_replace";
    if (this.sessions.observe(run, turnId).items.some(item => item.id === replaceId)) {
      const replace = this.sessions.question(run, { turnId, id: entry.question + "_replace" });
      if (replace.decision === null) return { pending: true };
      if (replace.decision !== "accept") { this.cancel(binding, turnId, entry.plan.id); entry.cancelled = true; return null; }
      entry.plan.replace = true;
    }
    return entry.plan;
  }
  cancel(binding: OfficeBinding, turnId: string, planId: string) {
    const run = this.sessions.requireRun(binding, turnId), owned = this.plans.get(planId);
    if (!owned || owned.turnId !== turnId) return;
    this.outputs.cancel(binding.artifactId, planId, run.lease.access); this.plans.delete(planId);
    for (const entry of this.pending.values()) if (entry.plan?.id === planId) entry.cancelled = true;
  }
  cancelPreparation(binding: OfficeBinding, turnId: string, requestId: string) {
    this.sessions.requireRun(binding, turnId);
    const entry = this.pending.get(turnId + ":" + requestId);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.plan) this.cancel(binding, turnId, entry.plan.id);
    for (const suffix of ["", "_replace"]) {
      const id = "office-question:" + turnId + ":" + entry.question + suffix;
      const item = this.sessions.observe(binding, turnId).items.find(item => item.id === id);
      if (item?.kind === "approval" && item.decision === null) this.sessions.answerQuestion(binding.sessionId, id, "decline");
    }
  }
  async commit(binding: OfficeBinding, turnId: string, planId: string, bytes: Buffer, sourceRevision?: number, generatedId?: string) {
    const run = this.sessions.requireRun(binding, turnId), owned = this.plans.get(planId);
    if (!owned || owned.turnId !== turnId) throw invalid();
    const result = await this.outputs.commit(binding.artifactId, planId, bytes, owned.plan.replace, run.lease.access, sourceRevision, generatedId);
    return { path: result.path, artifactId: result.artifact?.id ?? null };
  }
}
