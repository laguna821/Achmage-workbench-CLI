import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { HubRelationshipController, normalizeHubUrl } from "@workbench/paseo-server-transport/hub/relationship-controller";
import { DirectHubRelationshipRemote } from "@workbench/paseo-server-transport/hub/relationship-remote";
import { ensurePrivateDirectory } from "@workbench/paseo-server-transport/private-files";
import type { HubRelationshipConnect, HubRelationshipSelection, HubRelationshipSnapshot } from "@workbench/contracts";
import type { Store } from "../store.ts";
import type { SessionManager } from "../sessions.ts";
import type { EventBus } from "../bus.ts";
import { OfficeVault } from "../office-vault.ts";
import { HttpError } from "../errors.ts";
import { loadOrCreateKeyPair } from "../devices/transport.ts";
import { hubExecutionHistory, WorkbenchHubExecutions, type HubExecutionGrant } from "./executions.ts";
import { HubSession } from "./session.ts";

type Config = { enabled: boolean; allowExecution: boolean; hubUrl: string | null; daemonId?: string | null; grant: HubExecutionGrant | null };
const CONFIG = "hub.outbound.relationship:v1";
const bad = (message: string) => new HttpError(400, "hub_relationship_input", message);

/** Original Paseo relationship lifecycle plus Workbench's explicit local grant.
 * Construction/state reads never enroll or connect to an external account. */
export class PaseoHubRelationship {
  private readonly options: { dataDir: string; store: Store; manager: SessionManager; bus: EventBus };
  private readonly dir: string;
  private readonly logger = pino({ level: "silent" });
  private readonly vault: OfficeVault;
  private config: Config = { enabled: false, allowExecution: false, hubUrl: null, grant: null };
  private controller: HubRelationshipController | null = null;
  private sessions = new Map<string, HubSession>();
  private problem: string | null = null;
  private locked = false;
  private stopped = false;
  private operation: Promise<unknown> = Promise.resolve();
  constructor(options: PaseoHubRelationship["options"]) {
    this.options = options; this.dir = join(options.dataDir, "event-hub", "paseo");
    this.vault = new OfficeVault(options.dataDir);
    const stored = options.store.getMeta(CONFIG);
    if (stored) try { this.config = JSON.parse(stored) as Config; }
    catch { this.problem = "저장한 Hub 설정을 읽지 못했습니다. 새 연결을 설정해 주세요."; }
  }
  private save() { this.options.store.setMeta(CONFIG, JSON.stringify(this.config)); }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.then(run); this.operation = next.catch(() => undefined); return next;
  }
  private grant(): HubExecutionGrant | null {
    return !this.stopped && this.config.enabled && this.config.allowExecution && this.controller?.status().permissions.includes("hub.execute") ? this.config.grant : null;
  }
  private async initialize(create: boolean): Promise<HubRelationshipController> {
    if (this.stopped) throw new HttpError(503, "hub_stopping", "호스트가 종료 중입니다.");
    if (this.controller) return this.controller;
    ensurePrivateDirectory(this.dir);
    let codec: Awaited<ReturnType<OfficeVault["prepareCodec"]>>;
    try {
      codec = await this.vault.prepareCodec(create);
      // Reject locked/unreadable ciphertext before upstream's malformed-record quarantine.
      const file = join(this.dir, "hub-relationship.json");
      if (existsSync(file)) JSON.parse(codec.open(readFileSync(file, "utf8")));
      this.locked = false;
    } catch (error) { this.locked = true; this.problem = error instanceof Error ? error.message : "운영체제 보안 저장소를 열지 못했습니다."; throw error; }
    const keys = await loadOrCreateKeyPair(join(this.options.dataDir, "remote-devices"), this.logger);
    const snapshot = this.options.manager.snapshot();
    this.controller = new HubRelationshipController({ paseoHome: this.dir, hostname: snapshot.hostLabel,
      serverId: snapshot.hostId, daemonPublicKey: keys.publicKeyB64, logger: this.logger, remote: new DirectHubRelationshipRemote(),
      recordCodec: { encode: record => codec.seal(JSON.stringify(record)), decode: text => JSON.parse(codec.open(text)) },
      createExecutionAgents: daemonId => new WorkbenchHubExecutions({ ...this.options, daemonId,
        generation: this.config.grant?.generation ?? 0, grant: () => this.grant() }),
      attachSocket: async (socket, options) => {
        try {
          if (this.stopped || !this.config.enabled || !(options.agents instanceof WorkbenchHubExecutions)) { socket.close(); return; }
          this.sessions.get(options.principalId)?.close();
          const session = new HubSession(socket, { ...options, serverId: snapshot.hostId, hostname: snapshot.hostLabel, agents: options.agents });
          this.sessions.set(options.principalId, session);
          socket.once("close", () => { if (this.sessions.get(options.principalId) === session) this.sessions.delete(options.principalId); });
        } catch (error) { this.problem = error instanceof Error ? error.message : "Hub 세션을 열지 못했습니다."; socket.close(1011, "Hub session unavailable"); }
      },
      updateAttachedPermissions: (principalId, permissions) => this.sessions.get(principalId)?.updatePermissions(this.config.allowExecution ? permissions : []),
    });
    return this.controller;
  }
  state(): HubRelationshipSnapshot {
    const status = this.controller?.status();
    return { enabled: this.config.enabled, state: this.locked ? "credential_locked" : !this.config.enabled ? "disabled" : status?.state ?? "not_connected",
      daemonId: status ? status.daemonId : this.config.daemonId ?? null, hubOrigin: status?.hubOrigin ?? this.config.hubUrl,
      permissions: this.config.allowExecution ? status?.permissions ?? [] : [], connectedAt: status?.connectedAt ?? null, lastError: this.problem ?? status?.lastError ?? null,
      selection: this.config.grant?.selection ?? null, grantGeneration: this.config.grant?.generation ?? 0,
      approvedSettings: this.config.grant ? { provider: this.config.grant.settings.provider, model: this.config.grant.settings.model,
        effort: this.config.grant.settings.effort, access: this.config.grant.settings.access, profileName: this.config.grant.settings.profileName } : null,
      credentialStorage: "os_vault", executions: hubExecutionHistory(this.options.store, this.options.manager) };
  }
  start() {
    if (!this.config.enabled) return;
    void this.serialize(async () => {
      try { const controller = await this.initialize(false); await controller.start(); }
      catch (error) { this.problem = error instanceof Error ? error.message : "저장한 Hub 연결을 시작하지 못했습니다."; }
    });
  }
  private selection(input: HubRelationshipSelection): HubExecutionGrant {
    if (!input || typeof input.sessionId !== "string" || typeof input.workspaceId !== "string" || (input.profileId !== null && typeof input.profileId !== "string")) throw bad("작업공간과 대화 템플릿, 역할을 선택해 주세요.");
    if (!Number.isSafeInteger(input.minIntervalSeconds) || input.minIntervalSeconds < 1 || input.minIntervalSeconds > 86400) throw bad("요청 간격은 1~86400초로 지정해 주세요.");
    if (input.expiresAt !== null && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())) throw bad("실행 권한의 만료 시각을 확인해 주세요.");
    const session = this.options.manager.view.sessions.get(input.sessionId);
    if (!session || session.archivedAt || session.workspaceId !== input.workspaceId || session.hostId !== this.options.manager.snapshot().hostId || session.documentAgent || session.pageAgent) throw bad("이 PC의 일반 대화와 작업공간을 선택해 주세요.");
    this.options.manager.workspaces.requireActive(input.workspaceId, session.workId);
    // Preserve the user's existing session/profile authority. The local connect action
    // explicitly grants this captured configuration; remote requests cannot broaden it.
    const settings = this.options.manager.profiles.resolve(session, this.options.manager.accessOf(session), input.profileId ?? session.profileId);
    return { generation: (this.config.grant?.generation ?? 0) + 1,
      selection: { sessionId: session.id, workspaceId: input.workspaceId, profileId: settings.profileId, minIntervalSeconds: input.minIntervalSeconds, expiresAt: input.expiresAt }, settings };
  }
  connect(input: HubRelationshipConnect) {
    return this.serialize(async () => {
      if (!input || input.confirmExternalConnection !== true || typeof input.allowExecution !== "boolean") throw bad("외부 Hub 연결과 결과 전송을 명시적으로 선택해 주세요.");
      if (typeof input.hubUrl !== "string" || typeof input.token !== "string" || !input.token.trim() || input.token.length > 16_384) throw bad("Hub 주소와 일회 등록 토큰을 입력해 주세요.");
      const hubUrl = normalizeHubUrl(input.hubUrl), url = new URL(hubUrl);
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw bad("외부 Hub 주소에는 HTTPS가 필요합니다.");
      const grant = this.selection(input.selection), controller = await this.initialize(true);
      if (controller.status().daemonId && controller.status().state !== "revoked") throw bad("기존 관계를 해제한 뒤 새 등록 토큰으로 연결해 주세요.");
      this.config = { enabled: true, allowExecution: input.allowExecution, hubUrl, grant }; this.save(); this.problem = null;
      try { await controller.connect({ hubUrl, token: input.token.trim(), permissions: input.allowExecution ? ["hub.execute"] : [] }); }
      catch (error) { this.problem = error instanceof Error ? error.message : "Hub 등록에 실패했습니다."; throw error; }
      finally { this.config.daemonId = controller.status().daemonId; this.save(); }
      return this.state();
    });
  }
  setEnabled(enabled: boolean) {
    return this.serialize(async () => {
      if (typeof enabled !== "boolean") throw bad("연결 여부를 선택해 주세요.");
      if (enabled && !this.config.hubUrl) throw bad("먼저 Hub를 등록해 주세요.");
      if (enabled) {
        const controller = await this.initialize(false), status = controller.status();
        if (!status.daemonId || status.state === "revoked") throw bad("기존 등록이 없거나 철회되었습니다. 새 등록 토큰으로 연결해 주세요.");
        this.config.enabled = true; this.config.daemonId = status.daemonId; this.save(); this.problem = null; await controller.start();
      } else {
        this.config.enabled = false; if (this.controller) this.config.daemonId = this.controller.status().daemonId;
        this.save(); this.problem = null; await this.controller?.stop(); for (const session of this.sessions.values()) session.close(); this.sessions.clear();
      }
      return this.state();
    });
  }
  permissions(allowExecution: boolean) {
    return this.serialize(async () => {
      if (typeof allowExecution !== "boolean" || !this.config.enabled) throw bad("연결을 켠 뒤 실행 권한을 변경해 주세요.");
      if (allowExecution && this.config.grant?.selection.expiresAt !== null && (this.config.grant?.selection.expiresAt ?? 0) <= Date.now()) throw bad("실행 권한이 만료되었습니다. 대상을 검토해 새로 연결해 주세요.");
      const controller = await this.initialize(false);
      // Local revocation happens before a potentially unavailable external API.
      const wasAllowed = this.config.allowExecution;
      if (!allowExecution) { this.config.allowExecution = false; this.save(); for (const session of this.sessions.values()) session.updatePermissions([]); }
      try { await controller.updatePermissions({ grant: allowExecution ? ["hub.execute"] : [], revoke: allowExecution ? [] : ["hub.execute"] }); }
      catch (error) { if (allowExecution) this.config.allowExecution = wasAllowed; throw error; }
      this.config.allowExecution = allowExecution; this.save();
      for (const session of this.sessions.values()) session.updatePermissions(allowExecution ? controller.status().permissions : []);
      return this.state();
    });
  }
  disconnect(force: boolean) {
    return this.serialize(async () => {
      if (typeof force !== "boolean") throw bad("관계 해제 방식을 선택해 주세요.");
      const controller = await this.initialize(false);
      this.config.enabled = false; this.config.allowExecution = false; this.save();
      const result = await controller.disconnect({ force });
      this.config.daemonId = null; this.save();
      for (const session of this.sessions.values()) session.close(); this.sessions.clear();
      this.problem = result.warning ?? null; return { relationship: this.state(), warning: result.warning ?? null };
    });
  }
  async close() {
    this.stopped = true;
    await this.operation;
    await this.controller?.stop();
    for (const session of this.sessions.values()) session.close(); this.sessions.clear(); this.vault.close();
  }
}
