import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OfficeExecutionBoot, OfficeExecutionState } from "../../../../packages/contracts/src/office-execution.ts";
import type { DocFormat } from "@workbench/contracts";
import type { Documents } from "../artifacts.ts";
import { officeEditorKind, type EditorGrants } from "../editors.ts";
import { HttpError } from "../errors.ts";
import type { OfficeSessions, OfficeBinding } from "../office-sessions.ts";
import { officeExecutorMode } from "./registry.ts";

type OwnedProcess = { on(event: "error" | "exit", listener: () => void): unknown; stdin: Writable | null; unref(): void; pid?: number };
type Launch = (url: string) => OwnedProcess;
type Options = { binary?: string; webDir?: string | null; launch?: Launch };
type Entry = { binding: OfficeBinding; turnId: string; boot: OfficeExecutionBoot; claimed: boolean; stopped: boolean; process?: OwnedProcess; timer?: NodeJS.Timeout; dispose(): void };
const invalid = () => new HttpError(400, "office_executor_state", "원본 편집기의 실행 상태를 전달하지 못했습니다.");
function executionState(raw: unknown, format: DocFormat): OfficeExecutionState {
  const value = raw as OfficeExecutionState;
  if (!value || typeof value !== "object" || !officeEditorKind(value.format) || officeEditorKind(value.format) !== officeEditorKind(format)
    || JSON.stringify(value).length > 12_000_000) throw invalid();
  if (value.format === "markdown") {
    if (typeof value.snapshot?.body !== "string" || typeof value.snapshot.frontmatter !== "string"
      || !value.document || typeof value.document !== "object" || Array.isArray(value.document)
      || !value.selection || typeof value.selection !== "object" || Array.isArray(value.selection)) throw invalid();
  } else if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw invalid();
  return structuredClone(value);
}

/** One independently owned native process per admitted document turn. The durable
 * conversation remains in OfficeSessions. Boot capabilities are private and one-use;
 * crashes are interrupted, never silently replayed in a fresh renderer. */
export class OfficeRendererExecutors {
  private readonly entries = new Map<string, Entry>();
  private readonly turns = new Map<string, string>();
  private origin: string | null = null;
  private closed = false;
  private readonly documents: Documents;
  private readonly sessions: OfficeSessions;
  private readonly grants: EditorGrants;
  private readonly options: Options;
  constructor(documents: Documents, sessions: OfficeSessions, grants: EditorGrants, options: Options = {}) {
    this.documents = documents; this.sessions = sessions; this.grants = grants; this.options = options;
  }
  bind(origin: string) {
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/") throw new Error("Executor origin must be the local editor server");
    this.origin = url.origin;
  }
  available(artifactId: string) {
    return !this.closed && Boolean(this.origin) && officeExecutorMode(this.documents.get(artifactId).format) === "independent-renderer"
      && Boolean(this.options.launch || this.options.binary && existsSync(this.options.binary) && this.options.webDir && existsSync(join(this.options.webDir, "office/executor.html")));
  }
  private launch(url: string) {
    if (this.options.launch) return this.options.launch(url);
    const env: NodeJS.ProcessEnv = { ...process.env, WORKBENCH_OFFICE_EXECUTOR_URL: url };
    delete env.WORKBENCH_TOKEN;
    delete env.WORKBENCH_CLI_INPUT;
    return spawn(this.options.binary!, ["--office-executor"], { env, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  }
  start(binding: OfficeBinding, turnId: unknown, sourceToken: string, raw: unknown) {
    const run = this.sessions.requireRun(binding, turnId);
    if (!this.available(run.artifactId)) throw new HttpError(503, "office_executor_unavailable", "독립 문서 실행기를 사용할 수 없습니다.");
    if ([...this.entries.values()].filter(entry => !entry.stopped).length >= 4) throw new HttpError(429, "office_executor_busy", "독립 문서 작업 4개가 진행 중입니다. 하나가 끝난 뒤 다시 요청해 주세요.");
    const request = raw as { state?: unknown; instruction?: unknown; images?: unknown; referenceSnapshot?: unknown };
    const state = executionState(request?.state, this.documents.get(run.artifactId).format);
    if (typeof request.instruction !== "string" || !request.instruction.trim() || request.instruction.length > 2_000_000) throw invalid();
    const images = request.images as { base64: string; mime: string }[] | undefined;
    if (images !== undefined && (!Array.isArray(images) || images.length > 20 || images.some(image => typeof image?.base64 !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(image.mime)) || JSON.stringify(images).length > 24_000_000)) throw invalid();
    const referenceSnapshot = typeof request.referenceSnapshot === "string" ? request.referenceSnapshot : undefined;
    if (referenceSnapshot) this.grants.references.references({ documents: this.documents, grants: this.grants, artifactId: run.artifactId, token: sourceToken }, referenceSnapshot);
    if (this.turns.has(run.turnId)) throw new HttpError(409, "office_executor_duplicate", "이미 인계한 문서 작업입니다. 다시 실행하지 않았습니다.");
    const artifact = this.documents.check(run.artifactId);
    if (artifact.revision !== run.lease.baseRevision || artifact.sha256 !== run.lease.baseHash || artifact.diskState !== "same") throw new HttpError(409, "revision_conflict", "실행기 준비 중 문서가 바뀌었습니다.");
    const token = this.grants.execution(sourceToken, run.lease.access, () => {
      try { this.documents.registry.executions.require(run.lease, this.documents.get(run.artifactId).path); return true; } catch { return false; }
    });
    const observed = this.sessions.observe(binding, run.turnId);
    const user = observed.items.find(item => item.kind === "user");
    if (user?.kind !== "user") throw invalid();
    // Mode change removes the visible view's write bypass before another DOM exists.
    run.lease = this.documents.registry.executions.mode(run.lease, "independent-renderer");
    const capability = randomBytes(32).toString("base64url");
    const boot: OfficeExecutionBoot = { page: `/office/${officeEditorKind(artifact.format)}.html`, instruction: request.instruction, state,
      init: { type: "office:init", token, sessionId: run.sessionId,
        artifact: { id: artifact.id, name: artifact.name, path: artifact.path, revision: artifact.revision, sha256: artifact.sha256 },
        readOnly: false, theme: "light", recover: false, execution: { turnId: run.turnId, images, referenceSnapshot } } };
    const stop = () => {
      const item = this.entries.get(capability); if (!item || item.stopped) return;
      item.stopped = true; clearTimeout(item.timer);
      // Let the already-accepted finish HTTP response drain before closing its renderer.
      const shutdown = setTimeout(() => item.process?.stdin?.end(), 100); shutdown.unref();
      const expiry = setTimeout(() => { this.entries.delete(capability); this.turns.delete(run.turnId); }, 60_000); expiry.unref();
    };
    const entry: Entry = { binding, turnId: run.turnId, boot, claimed: false, stopped: false, dispose: stop };
    this.entries.set(capability, entry); this.turns.set(run.turnId, capability);
    run.controller.signal.addEventListener("abort", stop, { once: true });
    try {
      const child = this.launch(`${this.origin}/office/executor.html#${capability}`); entry.process = child;
      const failed = () => {
        if (entry.stopped) return;
        this.sessions.executorLost(binding, run.turnId);
        stop();
      };
      child.on("error", failed); child.on("exit", failed); child.unref();
      entry.timer = setTimeout(() => { if (!entry.claimed) failed(); }, 45_000); entry.timer.unref();
    } catch (error) { this.sessions.finish(binding, { turnId: run.turnId, status: "failed", error: "독립 문서 실행기를 시작하지 못했습니다." }); stop(); throw error; }
    return { turnId: run.turnId, mode: "independent-renderer" as const };
  }
  boot(capability: string | null) {
    const entry = capability ? this.entries.get(capability) : undefined;
    if (!entry || entry.stopped || entry.claimed) throw new HttpError(401, "office_executor_boot", "문서 실행기의 시작 권한이 없거나 이미 사용됐습니다.");
    this.sessions.requireRun(entry.binding, entry.turnId);
    entry.claimed = true; clearTimeout(entry.timer);
    return entry.boot;
  }
  state(capability: string | null) {
    const entry = capability ? this.entries.get(capability) : undefined;
    if (!entry || !entry.claimed) throw new HttpError(401, "office_executor_boot", "문서 실행기의 연결 권한이 없습니다.");
    return { stop: entry.stopped };
  }
  close() {
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (!entry.stopped) this.sessions.executorLost(entry.binding, entry.turnId);
      entry.dispose();
    }
  }
}
