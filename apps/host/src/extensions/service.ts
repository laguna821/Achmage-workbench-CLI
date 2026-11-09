import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compileDirectoryPlugin } from "@workbench/paseo-plugin-host/compiler";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { ExtensionActivation, ExtensionArtifact, ExtensionCall, ExtensionInstallRequest,
  ExtensionRecord, ExtensionRun, ExtensionRunResult, ExtensionScreen, ExtensionScreenCall, ExtensionState, Workspace } from "@workbench/contracts";
import type { SessionManager } from "../sessions.ts";
import { HttpError } from "../errors.ts";
import { ExtensionRegistry } from "./registry.ts";
import { normalizePermissions, permissionsSubset, requireExtensionCall } from "./permissions.ts";
import { ExtensionRuntime } from "./runtime.ts";
import { extensionBroker } from "./broker.ts";
import { createExtensionScreen } from "./screen.ts";

type Owned = { call: ExtensionCall; runtime: ExtensionRuntime; run: ExtensionRun };
const stale = () => new HttpError(409, "extension_stale", "확장 버전 또는 권한이 바뀌었습니다. 새 상태를 확인해 주세요.");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class ExtensionService {
  private readonly registry: ExtensionRegistry;
  private readonly manager: SessionManager;
  private readonly authorizeWrite: ((workspace: Workspace, absolutePath: string) => void) | undefined;
  private readonly owned = new Map<string, Owned>();
  private readonly screens = new Map<string, ExtensionScreen>();
  private closing = false;
  constructor(options: { dataDir: string; manager: SessionManager; authorizeWrite?: (workspace: Workspace, absolutePath: string) => void }) {
    this.registry = new ExtensionRegistry(options.dataDir); this.manager = options.manager; this.authorizeWrite = options.authorizeWrite;
  }
  /** No code executes on startup. Persisted approvals are rechecked when an operation starts. */
  async start(): Promise<void> {
    for (const record of this.registry.list()) {
      try { this.registry.verify(record); } catch (error) {
        this.registry.put({ ...record, status: "failed", error: errorText(error), grant: { ...record.grant, enabled: false, generation: record.grant.generation + 1, revokedAt: Date.now() } });
      }
    }
  }
  state(): ExtensionState {
    return { extensions: this.registry.list(), runs: this.registry.history(), runtime: {
      format: "paseo-quickjs-v1", isolation: "quickjs-wasm", nativeCode: false, platform: process.platform, verification: process.platform === "linux" ? "host-tested" : "not-tested",
    } };
  }
  async install(request: ExtensionInstallRequest): Promise<ExtensionRecord> {
    this.available(); const artifact = await this.registry.stage(request.directory, request.expectedHash);
    if (this.registry.list().some(record => record.manifest.id === artifact.manifest.id)) throw new HttpError(409, "extension_installed", "이미 설치되어 있습니다. 버전 갱신을 사용해 주세요.");
    // Compilation is source processing only. Installation does not evaluate its default export.
    await compileDirectoryPlugin(this.registry.verify(artifact), "0.15.3");
    const record: ExtensionRecord = { ...artifact, status: "disabled", previous: null, error: null,
      grant: { extensionId: artifact.manifest.id, artifactHash: artifact.artifactHash, generation: 1, enabled: false,
        capabilities: [], workspaceIds: [], permissions: { files: [], network: [] }, revokedAt: null } };
    this.registry.put(record); return record;
  }
  async activate(id: string, approval: ExtensionActivation): Promise<ExtensionRecord> {
    this.available(); const current = this.registry.get(id); this.match(current, approval.expectedHash, approval.expectedGeneration);
    if (!Array.isArray(approval.workspaceIds) || approval.workspaceIds.length > 50 || approval.workspaceIds.some(id => typeof id !== "string" || id === "*")) throw new HttpError(400, "extension_workspace", "작업공간 ID 목록이 필요합니다.");
    for (const workspaceId of approval.workspaceIds) this.workspace(workspaceId);
    if (!Array.isArray(approval.capabilities) || approval.capabilities.some(cap => !current.manifest.capabilities.includes(cap))) throw new HttpError(400, "extension_capability", "manifest에 없는 기능은 승인할 수 없습니다.");
    const permissions = normalizePermissions(approval.permissions);
    if (!permissionsSubset(permissions, current.manifest.permissions)) throw new HttpError(400, "extension_permissions", "manifest에 없는 권한은 승인할 수 없습니다.");
    await this.probe(current); this.match(this.registry.get(id), approval.expectedHash, approval.expectedGeneration);
    const record: ExtensionRecord = { ...current, status: "enabled", error: null, grant: { ...current.grant,
      generation: current.grant.generation + 1, enabled: true, revokedAt: null, capabilities: [...new Set(approval.capabilities)],
      workspaceIds: [...new Set(approval.workspaceIds)], permissions } };
    this.registry.put(record); await this.stopOwned(id); return record;
  }
  async disable(id: string, expectedGeneration: number): Promise<ExtensionRecord> {
    const current = this.registry.get(id); this.match(current, current.artifactHash, expectedGeneration);
    const next: ExtensionRecord = { ...current, status: "disabled", grant: { ...current.grant, enabled: false, generation: current.grant.generation + 1, revokedAt: Date.now() } };
    this.registry.put(next); this.clearScreens(id); await this.stopOwned(id); return next;
  }
  async update(id: string, request: ExtensionInstallRequest): Promise<ExtensionRecord> {
    this.available(); const before = this.registry.get(id);
    const generation = before.grant.generation + 1;
    this.registry.put({ ...before, status: "updating", grant: { ...before.grant, generation, enabled: false, revokedAt: Date.now() } });
    this.clearScreens(id); await this.stopOwned(id);
    try {
      const artifact = await this.registry.stage(request.directory, request.expectedHash);
      if (artifact.manifest.id !== id || artifact.manifest.version === before.manifest.version) throw new HttpError(400, "extension_version", "동일 확장의 새 버전이 필요합니다.");
      await this.probe(artifact); this.match(this.registry.get(id), before.artifactHash, generation);
      const canKeep = before.grant.enabled && before.grant.capabilities.every(cap => artifact.manifest.capabilities.includes(cap))
        && permissionsSubset(before.grant.permissions, artifact.manifest.permissions);
      const next: ExtensionRecord = { ...artifact, previous: this.artifact(before), status: canKeep ? "enabled" : "disabled", error: null,
        grant: { ...before.grant, artifactHash: artifact.artifactHash, generation: generation + 1, enabled: canKeep, revokedAt: canKeep ? null : Date.now() } };
      this.registry.put(next); return next;
    } catch (error) {
      const current = this.registry.get(id);
      // A concurrent disable takes precedence over rollback; never resurrect a revoked grant.
      if (current.grant.generation === generation && current.status === "updating") {
        this.registry.put({ ...before, error: `Update refused; previous verified artifact retained: ${errorText(error)}`,
          grant: { ...before.grant, generation: generation + 1 } });
      }
      throw error;
    }
  }
  async rollback(id: string, expectedGeneration: number): Promise<ExtensionRecord> {
    const current = this.registry.get(id); this.match(current, current.artifactHash, expectedGeneration);
    if (!current.previous) throw new HttpError(409, "extension_no_previous", "되돌릴 이전 버전이 없습니다.");
    this.registry.verify(current.previous);
    const next: ExtensionRecord = { ...current.previous, previous: this.artifact(current), status: "disabled", error: null,
      grant: { ...current.grant, artifactHash: current.previous.artifactHash, generation: expectedGeneration + 1, enabled: false, revokedAt: Date.now(), capabilities: [], workspaceIds: [], permissions: { files: [], network: [] } } };
    this.registry.put(next); this.clearScreens(id); await this.stopOwned(id); return next;
  }
  async run(call: ExtensionCall): Promise<ExtensionRunResult> {
    if (call.capability === "screen") throw new HttpError(400, "extension_screen", "화면은 격리된 화면 열기를 사용해 주세요.");
    const owned = await this.begin(call);
    try {
      const record = this.registry.get(call.extensionId); let output: unknown;
      if (call.capability === "tool") {
        const tool = record.manifest.tools.find(tool => tool.id === call.contributionId);
        if (!tool) throw new HttpError(404, "extension_tool", "등록된 도구가 없습니다.");
        output = await owned.runtime.invoke(tool.method, call.input ?? {});
      } else {
        const provider = record.manifest.providers.find(provider => provider.id === call.contributionId);
        if (!provider) throw new HttpError(404, "extension_provider", "등록된 공급자가 없습니다.");
        const operation = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>).operation : "catalog";
        if (operation === "status") output = await owned.runtime.providerStatus(provider.method);
        else if (operation === "catalog" || operation === undefined) {
          const connection = await owned.runtime.connectProvider(provider.method);
          try { output = await this.catalog(connection, this.workspace(call.workspaceId).cwd); } finally { await connection.close(); }
        } else throw new HttpError(400, "extension_provider_operation", "UI 실행은 공급자 상태 또는 모델 목록을 조회합니다.");
      }
      this.check(call); const run = this.finish(owned, "completed", null); return { run, output };
    } catch (error) { this.finish(owned, this.isCurrent(call) ? "failed" : "cancelled", errorText(error)); throw error; }
    finally { this.owned.delete(owned.run.id); await owned.runtime.close(); }
  }
  /** U07 adapter seam. Original ProviderConnection protocol, isolated from Claude/Codex model names. */
  async providerConnection(call: ExtensionCall): Promise<ProviderConnection> {
    if (call.capability !== "provider") throw new HttpError(400, "extension_provider", "공급자 권한이 필요합니다.");
    const owned = await this.begin(call);
    try {
      const contribution = this.registry.get(call.extensionId).manifest.providers.find(item => item.id === call.contributionId);
      if (!contribution) throw new HttpError(404, "extension_provider", "등록된 공급자가 없습니다.");
      const connection = await owned.runtime.connectProvider(contribution.method);
      return { version: connection.version, capabilities: connection.capabilities,
        send: async input => {
          this.check(call); const workspace = this.workspace(call.workspaceId);
          if (input.type === "session.open") input = { ...input, config: { ...input.config, cwd: workspace.cwd, env: {}, mcpServers: {} } };
          else if (input.type === "catalog" || input.type === "sessions") input = { ...input, cwd: workspace.cwd };
          await connection.send(input); this.check(call);
        },
        onEvent: listener => connection.onEvent(event => { if (this.isCurrent(call)) listener(event); }),
        close: async () => { try { await connection.close(); this.finish(owned, "completed", null); } finally { this.owned.delete(owned.run.id); await owned.runtime.close(); } },
      };
    } catch (error) { this.finish(owned, "failed", errorText(error)); this.owned.delete(owned.run.id); await owned.runtime.close(); throw error; }
  }
  screen(call: ExtensionCall): ExtensionScreen {
    if (call.capability !== "screen") throw new HttpError(400, "extension_screen", "화면 권한이 필요합니다.");
    const record = this.check(call), contribution = record.manifest.screens.find(item => item.id === call.contributionId);
    if (!contribution) throw new HttpError(404, "extension_screen", "등록된 화면이 없습니다.");
    const directory = this.registry.verify(record);
    const screen = createExtensionScreen(call, readFileSync(path.join(directory, contribution.file), "utf8"));
    for (const [key, value] of this.screens) if (value.expiresAt < Date.now()) this.screens.delete(key);
    if (this.screens.size >= 100) this.screens.delete(this.screens.keys().next().value!);
    this.screens.set(screen.nonce, screen); return screen;
  }
  async screenCall(request: ExtensionScreenCall): Promise<ExtensionRunResult> {
    const ticket = this.screens.get(request.nonce), call = request.call;
    if (!ticket || ticket.expiresAt <= Date.now() || ticket.extensionId !== call.extensionId || ticket.artifactHash !== call.artifactHash
      || ticket.grantGeneration !== call.grantGeneration || ticket.workspaceId !== call.workspaceId || call.capability !== "tool") throw new HttpError(403, "extension_screen_ticket", "화면 연결 권한이 만료되었거나 다릅니다.");
    this.check({ ...call, capability: "screen", contributionId: ticket.screenId }); return this.run(call);
  }
  async close(): Promise<void> { this.closing = true; this.screens.clear(); await Promise.all([...this.owned.values()].map(async owned => { this.finish(owned, "cancelled", "Host stopped"); await owned.runtime.close(); })); this.owned.clear(); }
  private available(): void { if (this.closing) throw new HttpError(503, "extension_closed", "확장 서비스가 종료 중입니다."); }
  private workspace(id: string): Workspace {
    const workspace = this.manager.workspaces.get(id);
    const work = this.manager.view.works.get(workspace.workId);
    if (!work || work.archivedAt !== null) throw new HttpError(403, "extension_workspace", "활성 프로젝트의 작업공간이 필요합니다.");
    return this.manager.workspaces.requireActive(id, workspace.workId);
  }
  private check(call: ExtensionCall): ExtensionRecord {
    this.available(); const record = this.registry.get(call.extensionId); requireExtensionCall(call, record.grant); this.workspace(call.workspaceId); return record;
  }
  private isCurrent(call: ExtensionCall): boolean { try { this.check(call); return true; } catch { return false; } }
  private match(record: ExtensionRecord, hash: string, generation: number): void { if (record.artifactHash !== hash || record.grant.generation !== generation) throw stale(); }
  private async probe(artifact: ExtensionArtifact): Promise<void> {
    const runtime = new ExtensionRuntime(async () => { throw new Error("Host imports are unavailable during activation validation"); });
    try { await runtime.start(artifact.manifest.id, this.registry.verify(artifact)); }
    finally { await runtime.close(); }
  }
  private async begin(call: ExtensionCall): Promise<Owned> {
    const record = this.check(call); const directory = this.registry.verify(record);
    const run: ExtensionRun = { id: randomUUID(), extensionId: call.extensionId, artifactHash: call.artifactHash,
      grantGeneration: call.grantGeneration, workspaceId: call.workspaceId, capability: call.capability, contributionId: call.contributionId,
      status: "running", startedAt: Date.now(), finishedAt: null, error: null };
    const runtime = new ExtensionRuntime(extensionBroker({ call, currentGrant: () => this.registry.get(call.extensionId).grant,
      workspace: () => this.workspace(call.workspaceId), authorizeWrite: this.authorizeWrite }));
    const owned = { call: structuredClone(call), runtime, run }; this.owned.set(run.id, owned); this.registry.recordRun(run);
    try { await runtime.start(call.extensionId, directory); this.check(call); return owned; }
    catch (error) { this.finish(owned, this.isCurrent(call) ? "failed" : "cancelled", errorText(error)); this.owned.delete(run.id); await runtime.close(); throw error; }
  }
  private finish(owned: Owned, status: ExtensionRun["status"], error: string | null): ExtensionRun {
    if (owned.run.status !== "running") return structuredClone(owned.run);
    owned.run = { ...owned.run, status, error, finishedAt: Date.now() }; this.registry.recordRun(owned.run); return structuredClone(owned.run);
  }
  private async stopOwned(id: string): Promise<void> {
    await Promise.all([...this.owned.values()].filter(owned => owned.call.extensionId === id).map(async owned => { this.finish(owned, "cancelled", "Extension grant changed"); await owned.runtime.close(); this.owned.delete(owned.run.id); }));
  }
  private clearScreens(id: string): void { for (const [nonce, ticket] of this.screens) if (ticket.extensionId === id) this.screens.delete(nonce); }
  private artifact(record: ExtensionRecord): ExtensionArtifact { return { manifest: record.manifest, artifactHash: record.artifactHash, installedAt: record.installedAt, files: record.files }; }
  private catalog(connection: ProviderConnection, cwd: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID(); const timer = setTimeout(() => { off(); reject(new Error("Extension provider catalog deadline exceeded")); }, 5000);
      const off = connection.onEvent((event: ProviderEvent) => {
        if (!("requestId" in event) || event.requestId !== requestId) return;
        if (event.type === "catalog") { clearTimeout(timer); off(); resolve(event.catalog); }
        if (event.type === "request.failed") { clearTimeout(timer); off(); reject(new Error(event.error.message)); }
      });
      void connection.send({ type: "catalog", requestId, cwd }).catch(error => { clearTimeout(timer); off(); reject(error); });
    });
  }
}
