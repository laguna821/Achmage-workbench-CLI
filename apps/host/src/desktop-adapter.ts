import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Attachment, DesktopAction, DesktopDelivery, DesktopEnvelope, DesktopObservation, DesktopReceipt, DesktopState, DesktopTarget, DesktopWindow, Session, TranscriptItem } from "@workbench/contracts";
import { DesktopInstall } from "./desktop-install.ts";
import { DesktopInputLease } from "./desktop-input-lease.ts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";

type Hooks = { session(id: string): Session | undefined; item(sessionId: string, item: TranscriptItem): void; image?(data: Buffer, name: string, mime: string): { attachment: Attachment; path: string } };
export type DesktopRunner = (args: string[], signal: AbortSignal) => Promise<DesktopEnvelope>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const receiptKey = (id: string) => `desktop-command:${id}`;
const actions = new Set(["click", "double-click", "right-click", "type", "set-value", "clear", "focus", "select", "toggle", "check", "uncheck", "expand", "collapse", "scroll", "press"]);

export class DesktopService {
  readonly installer: DesktopInstall;
  readonly input = new DesktopInputLease();
  private targets = new Map<string, DesktopTarget>();
  private active = new Map<string, AbortController>();
  private permissionStatus: DesktopEnvelope | null = null;
  private readonly store: Pick<Store, "getMeta" | "setMeta" | "metaEntries">;
  private readonly hooks: Hooks;
  private readonly execute: DesktopRunner;
  constructor(dataDir: string, store: Pick<Store, "getMeta" | "setMeta" | "metaEntries">, hooks: Hooks, runner?: DesktopRunner) {
    this.installer = new DesktopInstall(dataDir); this.store = store; this.hooks = hooks;
    this.execute = runner ?? ((args, signal) => this.run(args, signal));
    for (const row of store.metaEntries("desktop-command:")) {
      const receipt = JSON.parse(row.value) as DesktopReceipt;
      if (receipt.state === "running") this.save({ ...receipt, state: "outcome_unknown", delivery: "unknown", finishedAt: Date.now(), error: "호스트 재시작 전 동작의 결과를 확인하지 못했습니다. 자동으로 다시 실행하지 않습니다." });
    }
  }
  state(): DesktopState {
    return { version: this.installer.version, installed: this.installer.installed, installing: this.installer.installing, supported: this.installer.supported,
      platform: `${process.platform}-${process.arch}`, permissionStatus: this.permissionStatus, targets: [...this.targets.values()],
      receipts: this.store.metaEntries("desktop-command:").map(row => JSON.parse(row.value) as DesktopReceipt).sort((a, b) => b.startedAt - a.startedAt).slice(0, 100), inputOwner: this.input.owner, error: this.installer.error };
  }
  targetFor(sessionId: string) { return this.targets.get(sessionId) ?? null; }
  async status() { this.permissionStatus = await this.execute(["status"], AbortSignal.timeout(15_000)); return this.state(); }
  async requestPermissions() { this.permissionStatus = await this.execute(["permissions", "--request"], AbortSignal.timeout(60_000)); return this.state(); }
  async screenshot(sessionId: string) {
    const target = this.target(sessionId);
    if (this.active.has(target.id)) throw new HttpError(409, "desktop_busy", "앱 동작이 끝난 뒤 캡처할 수 있습니다.");
    const controller = new AbortController(); this.active.set(target.id, controller);
    try {
      await this.identity(target);
      const result = await this.execute(["--session", target.id, "screenshot", "--window-id", target.window.id], AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])); this.assertOk(result);
      if (this.targets.get(sessionId) !== target || controller.signal.aborted) throw new HttpError(409, "desktop_target_changed", "앱 연결이 변경되었습니다.");
      const data = object(result.data);
      if (typeof data.data !== "string" || !["png", "jpeg", "webp"].includes(String(data.format)) || !this.hooks.image) throw new HttpError(422, "desktop_capture", "화면 캡처를 저장할 수 없습니다.");
      const saved = this.hooks.image(Buffer.from(data.data, "base64"), `${target.window.app_name}-${Date.now()}.${data.format}`, `image/${data.format}`);
      this.hooks.item(sessionId, { kind: "tool", id: `desktop-capture:${randomUUID()}`, tool: "other", title: `앱 화면 · ${target.window.app_name}`, detail: target.window.title, output: null, status: "completed", at: Date.now(), images: [saved.attachment] });
      return { ...saved, targetId: target.id, width: data.width, height: data.height };
    } finally { if (this.active.get(target.id) === controller) this.active.delete(target.id); }
  }
  async windows(): Promise<DesktopWindow[]> {
    const result = await this.execute(["list-windows"], AbortSignal.timeout(15_000)); this.assertOk(result);
    if (!Array.isArray(result.data)) throw new Error("앱 창 목록 형식을 확인하지 못했습니다.");
    return result.data.filter((row): row is DesktopWindow => !!row && typeof row.id === "string" && !!row.id && typeof row.app_name === "string" && typeof row.pid === "number");
  }
  async bind(sessionId: string, windowId: string, headed: boolean) {
    this.session(sessionId);
    const window = (await this.windows()).find(row => row.id === windowId);
    if (!window) throw new HttpError(409, "desktop_window_gone", "선택한 앱 창이 사라졌습니다. 창 목록을 새로 불러오세요.");
    this.release(sessionId);
    const target: DesktopTarget = { id: randomUUID(), sessionId, window, headed, createdAt: Date.now(), observation: null, needsReconcile: false };
    this.targets.set(sessionId, target); return target;
  }
  release(sessionId: string) { const target = this.targets.get(sessionId); if (target) this.active.get(target.id)?.abort(); this.targets.delete(sessionId); }
  takeOver() { this.input.takeOver(); for (const active of this.active.values()) active.abort(); this.targets.clear(); return this.state(); }
  private session(id: string) { const session = this.hooks.session(id); if (!session || session.archivedAt) throw new HttpError(404, "desktop_session", "사용할 수 있는 세션이 없습니다."); return session; }
  private target(sessionId: string) { this.session(sessionId); const target = this.targets.get(sessionId); if (!target) throw new HttpError(403, "desktop_target", "외부 앱 메뉴에서 이 세션이 사용할 앱 창을 먼저 연결하세요."); return target; }
  private assertOk(envelope: DesktopEnvelope) { if (!envelope.ok) throw new HttpError(422, envelope.error?.code ?? "desktop_error", envelope.error?.message ?? "외부 앱 명령을 완료하지 못했습니다."); }
  private async identity(target: DesktopTarget) {
    const current = (await this.windows()).find(row => row.id === target.window.id);
    if (!current || current.pid !== target.window.pid || current.app_name !== target.window.app_name || current.process_instance !== target.window.process_instance)
      throw new HttpError(409, "desktop_identity_changed", "앱 창 또는 실행 인스턴스가 바뀌었습니다. 사용할 창을 다시 선택하세요.");
    if (this.targets.get(target.sessionId) !== target) throw new HttpError(409, "desktop_target_changed", "사용자가 앱 연결을 변경했습니다.");
  }
  async observe(sessionId: string): Promise<DesktopObservation> {
    const target = this.target(sessionId);
    if (this.active.has(target.id)) throw new HttpError(409, "desktop_busy", "앱 동작이 끝난 뒤 화면을 읽을 수 있습니다.");
    const controller = new AbortController(); this.active.set(target.id, controller);
    try {
      await this.identity(target);
      const result = await this.execute(["--session", target.id, "snapshot", "--window-id", target.window.id], AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])); this.assertOk(result);
      const data = object(result.data), window = object(data.window);
      if (typeof data.snapshot_id !== "string" || window.id !== target.window.id || data.app !== target.window.app_name) throw new HttpError(409, "desktop_snapshot_identity", "관찰한 앱 창의 식별 정보가 다릅니다.");
      if (this.targets.get(sessionId) !== target || controller.signal.aborted) throw new HttpError(409, "desktop_target_changed", "사용자가 앱 연결을 변경했습니다.");
      const observation: DesktopObservation = { id: randomUUID(), targetId: target.id, snapshotId: data.snapshot_id, observedAt: Date.now(), complete: data.complete === true, identityUnproven: data.identity_unproven === true, data: result.data };
      target.observation = observation; return observation;
    } finally { if (this.active.get(target.id) === controller) this.active.delete(target.id); }
  }
  async act(sessionId: string, request: DesktopAction): Promise<DesktopReceipt> {
    this.session(sessionId);
    if (!request || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.commandId) || !actions.has(request.action)) throw new HttpError(400, "desktop_action", "외부 앱 동작 또는 명령 ID 형식이 올바르지 않습니다.");
    const fingerprint = createHash("sha256").update(JSON.stringify({ sessionId, ...request })).digest("hex");
    const previous = this.store.getMeta(receiptKey(request.commandId));
    if (previous) { const receipt = JSON.parse(previous) as DesktopReceipt; if (receipt.fingerprint !== fingerprint) throw new HttpError(409, "desktop_command_reused", "이미 사용한 명령 ID입니다."); return receipt; }
    const target = this.target(sessionId), observation = target.observation;
    if (this.active.has(target.id)) throw new HttpError(409, "desktop_busy", "이 앱 창의 다른 동작이 진행 중입니다.");
    if (target.needsReconcile) throw new HttpError(409, "desktop_reconcile", "이전 동작의 결과가 불명확합니다. 결과를 다시 읽은 뒤 새 동작을 결정하세요.");
    if (!observation || observation.id !== request.observationId || observation.identityUnproven) throw new HttpError(409, "desktop_observation", "현재 앱 창을 다시 읽고 새 관찰 ID로 요청하세요.");
    const argv = this.arguments(target, observation, request), controller = new AbortController();
    this.active.set(target.id, controller); let releaseInput = () => {};
    try {
      if (target.headed) releaseInput = this.input.acquire(target.id, () => controller.abort());
      await this.identity(target); controller.signal.throwIfAborted();
      const receipt: DesktopReceipt = { id: request.commandId, fingerprint, targetId: target.id, sessionId, action: request.action, state: "running", delivery: "unknown", startedAt: Date.now(), finishedAt: null, result: null, error: null };
      this.save(receipt); target.observation = null;
      try {
        const result = await this.execute(argv, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
        const disposition = object(result.ok ? object(result.data).disposition : result.error?.disposition);
        const deliveries = new Set<unknown>(["not_delivered", "delivery_uncertain", "delivered_unverified", "delivered_verified"]);
        const delivery = deliveries.has(disposition.delivery) ? disposition.delivery as DesktopDelivery : "unknown";
        const uncertain = delivery === "unknown" || delivery === "delivery_uncertain";
        target.needsReconcile = uncertain;
        return this.save({ ...receipt, state: uncertain ? "outcome_unknown" : result.ok ? "completed" : "failed", delivery, result, error: result.error?.message ?? null, finishedAt: Date.now() });
      } catch (error) { target.needsReconcile = true; return this.save({ ...receipt, state: "outcome_unknown", error: message(error), finishedAt: Date.now() }); }
    } finally { releaseInput(); if (this.active.get(target.id) === controller) this.active.delete(target.id); }
  }
  private arguments(target: DesktopTarget, observation: DesktopObservation, request: DesktopAction) {
    const args = ["--session", target.id, ...(target.headed ? ["--headed"] : []), request.action];
    if (request.action === "press") {
      if (!request.value || request.value.length > 100 || /[\r\n\0]/.test(request.value)) throw new HttpError(400, "desktop_key", "키 조합이 올바르지 않습니다.");
      args.push("--window-id", target.window.id, "--", request.value);
    } else {
      const prefix = `@${observation.snapshotId}:`;
      if (!request.ref?.startsWith(prefix) || !/^e\d+$/.test(request.ref.slice(prefix.length))) throw new HttpError(409, "desktop_ref", "현재 관찰에서 받은 요소 참조를 사용하세요.");
      args.push(request.ref);
      if (["type", "set-value", "select"].includes(request.action)) { if (typeof request.value !== "string" || request.value.length > 50_000) throw new HttpError(400, "desktop_value", "입력할 값이 필요합니다."); args.push("--", request.value); }
      if (request.action === "scroll") {
        if (request.direction && !["up", "down", "left", "right"].includes(request.direction)) throw new HttpError(400, "desktop_scroll", "스크롤 방향이 올바르지 않습니다.");
        const amount = request.amount ?? 3; if (!Number.isInteger(amount) || amount < 1 || amount > 100) throw new HttpError(400, "desktop_scroll", "스크롤 양은 1–100입니다.");
        args.push("--direction", request.direction ?? "down", "--amount", String(amount));
      }
    }
    return args;
  }
  async reconcile(sessionId: string, commandId: string) {
    const raw = this.store.getMeta(receiptKey(commandId)), receipt = raw ? JSON.parse(raw) as DesktopReceipt : null;
    if (!receipt || receipt.sessionId !== sessionId) throw new HttpError(404, "desktop_receipt", "이 세션의 동작 기록이 없습니다.");
    const observation = await this.observe(sessionId);
    // A fresh screen is evidence, not proof that the prior action succeeded. Preserve unknown.
    this.target(sessionId).needsReconcile = false;
    return { receipt: this.save({ ...receipt, reconciledObservationId: observation.id }), observation };
  }
  private save(receipt: DesktopReceipt) {
    this.store.setMeta(receiptKey(receipt.id), JSON.stringify(receipt));
    if (this.hooks.session(receipt.sessionId)) this.hooks.item(receipt.sessionId, { kind: "tool", id: `desktop:${receipt.id}`, tool: "other", title: `외부 앱 · ${receipt.action}`, detail: `대상 ${receipt.targetId} · ${receipt.delivery}`, output: receipt.error ?? (receipt.result ? JSON.stringify(receipt.result) : null), status: receipt.state === "outcome_unknown" ? "unknown" : receipt.state, at: receipt.startedAt });
    return receipt;
  }
  private run(args: string[], signal: AbortSignal): Promise<DesktopEnvelope> {
    if (!this.installer.installed || !this.installer.binary) throw new HttpError(409, "desktop_not_installed", "외부 앱 메뉴에서 agent-desktop을 먼저 설치하세요.");
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_DESKTOP_HOME: this.installer.stateRoot };
    delete env.AGENT_DESKTOP_MACOS_HELPER_PATH;
    delete env.AGENT_DESKTOP_SESSION;
    delete env.AGENT_DESKTOP_AGENT_ID;
    return new Promise((resolve, reject) => execFile(this.installer.binary!, args, { env, signal, timeout: 35_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      try { const result = JSON.parse(stdout) as DesktopEnvelope; if (result.version !== "2.6" || typeof result.ok !== "boolean") throw new Error("외부 앱 응답 버전이 다릅니다."); resolve(result); }
      catch (parseError) { reject(error ?? new Error(stderr.trim() || message(parseError))); }
    }));
  }
  close() { this.installer.close(); this.takeOver(); }
}
