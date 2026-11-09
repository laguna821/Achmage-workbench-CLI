import { createHash } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import pino from "pino";
import QRCode from "qrcode";
import { writePrivateFileAtomicSync, ensurePrivateDirectory } from "@workbench/paseo-server-transport/private-files";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { DeviceApproval, RemoteOffer } from "@workbench/contracts";
import { DeviceRegistry } from "../devices.ts";
import type { SessionManager } from "../sessions.ts";
import type { EventBus } from "../bus.ts";
import { HttpError } from "../errors.ts";
import { sendJson, readBody, serveStatic } from "../http.ts";
import { DeviceGateway } from "./gateway.ts";
import { attachProtectedSocket, loadOrCreateKeyPair, startProtectedRelayTransport, type DaemonKeyPairBundle } from "./transport.ts";

type DeviceConfig = { enabled: boolean; label?: string; relayUrl?: string; publicUrl?: string; listenHost?: string; port?: number };
export class DeviceService {
  readonly registry: DeviceRegistry;
  private readonly options: { dataDir: string; manager: SessionManager; bus: EventBus; localOrigin: () => string | null; localToken: string; webDir: string | null; voice?: import("../voice.ts").VoiceService; eventIngress?: (req: IncomingMessage, res: ServerResponse) => Promise<void> };
  private readonly gateway: DeviceGateway;
  private readonly dir: string;
  private readonly logger = pino({ level: "silent" });
  private config: DeviceConfig = { enabled: false, listenHost: "127.0.0.1", port: 0 };
  private keys: DaemonKeyPairBundle | null = null;
  private server: Server | null = null;
  private ws: WebSocketServer | null = null;
  private relay: ReturnType<typeof startProtectedRelayTransport> | null = null;
  private endpoint = "";
  private problem = "";
  private change: Promise<unknown> = Promise.resolve();
  constructor(options: DeviceService["options"]) {
    this.options = options; this.dir = join(options.dataDir, "remote-devices");
    ensurePrivateDirectory(this.dir);
    this.registry = new DeviceRegistry(options.dataDir, options.manager.snapshot().hostId);
    this.gateway = new DeviceGateway({ registry: this.registry, ...options });
    const file = join(this.dir, "config.json");
    if (existsSync(file)) {
      try { this.config = this.validate(JSON.parse(readFileSync(file, "utf8"))); }
      catch { this.problem = "저장된 연결 설정을 확인해 주세요."; }
    }
  }
  private validate(input: unknown): DeviceConfig {
    if (!input || typeof input !== "object") throw new HttpError(400, "device_config", "연결 설정을 확인해 주세요.");
    const c = input as DeviceConfig;
    if (typeof c.enabled !== "boolean") throw new HttpError(400, "device_config", "원격 연결 여부를 선택해 주세요.");
    const listenHost = c.listenHost?.trim() || "127.0.0.1", port = c.port ?? 0;
    if (!["127.0.0.1", "::1", "0.0.0.0", "::"].includes(listenHost) || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new HttpError(400, "device_address", "연결 주소와 포트를 확인해 주세요.");
    const relayUrl = c.relayUrl?.trim() || "", publicUrl = c.publicUrl?.trim() || "";
    for (const [value, schemes] of [[relayUrl, ["wss:"]], [publicUrl, ["https:", "http:"]]] as const) {
      if (!value) continue; const url = new URL(value);
      if (!schemes.includes(url.protocol as never) || url.username || url.password || url.search || url.hash || (value === relayUrl && url.pathname !== "/")) throw new HttpError(400, "device_address", "인증정보 없는 연결 주소를 입력해 주세요.");
    }
    return { enabled: c.enabled, listenHost, port, relayUrl, publicUrl, label: c.label?.trim().slice(0, 100) || this.options.manager.snapshot().hostLabel };
  }
  async start() {
    this.keys = await loadOrCreateKeyPair(this.dir, this.logger);
    if (this.config.enabled) try { await this.open(); } catch (error) { this.problem = error instanceof Error ? error.message : "원격 연결을 시작하지 못했습니다."; }
  }
  private async open() {
    if (!this.keys || !this.config.enabled) return;
    const keys = this.keys;
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path.startsWith("/hub/events/") && this.options.eventIngress) { void this.options.eventIngress(req, res); return; }
      if (path.startsWith("/api/")) return sendJson(res, 404, { code: "protected_channel_required", message: "보호된 기기 연결이 필요합니다." });
      if (!this.options.webDir) return sendJson(res, 503, { code: "web_missing", message: "웹 화면이 포함된 설치본에서 열어 주세요." });
      try { serveStatic(res, this.options.webDir, path); }
      catch { sendJson(res, 404, { code: "not_found", message: "화면을 찾지 못했습니다." }); }
    });
    const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      if (!this.config.enabled || new URL(req.url ?? "/", "http://localhost").pathname !== "/workbench") { socket.destroy(); return; }
      ws.handleUpgrade(req, socket, head, raw => { void attachProtectedSocket(raw, { keyPair: keys.keyPair, logger: this.logger }, this.gateway.attach); });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.config.port ?? 0, this.config.listenHost ?? "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    } catch (error) { ws.close(); server.close(); throw error; }
    this.server = server; this.ws = ws;
    const address = server.address(), port = typeof address === "object" && address ? address.port : 0;
    const publicUrl = this.config.publicUrl ? new URL(this.config.publicUrl) : null;
    this.endpoint = publicUrl
      ? (publicUrl.protocol === "https:" ? "wss://" : "ws://") + publicUrl.host + "/workbench"
      : "ws://127.0.0.1:" + port + "/workbench";
    if (this.config.relayUrl) {
      const url = new URL(this.config.relayUrl);
      const relayEndpoint = url.host;
      this.relay = startProtectedRelayTransport({
        serverId: this.options.manager.snapshot().hostId, relayEndpoint, relayUseTls: true,
        keyPair: keys.keyPair, logger: this.logger, onSecured: this.gateway.attach,
      });
      this.endpoint = buildRelayWebSocketUrl({ endpoint: relayEndpoint, serverId: this.options.manager.snapshot().hostId, role: "client", useTls: true });
    }
    this.problem = "";
  }
  hubIngressState() {
    const enabled = !!this.server && this.config.enabled && !!this.config.publicUrl?.startsWith("https://");
    return { enabled, url: enabled ? new URL("/hub/events/", this.config.publicUrl).href : null,
      message: enabled ? "각 연결의 서명 검증을 통과한 사건만 접수합니다." : "기기 연결에서 공개 HTTPS 주소를 등록해야 외부 사건을 받을 수 있습니다." };
  }
  state() {
    return { config: this.config, hostId: this.options.manager.snapshot().hostId,
      hostFingerprint: this.keys ? createHash("sha256").update(this.keys.publicKeyB64).digest("hex").match(/.{1,8}/g)!.join(" ") : "",
      pending: this.registry.listPending(), devices: this.registry.list(),
      workspaces: this.options.manager.snapshot().works.map(work => ({ workId: work.id, label: work.title })),
      status: this.problem ? "error" : this.server ? "listening" : "disabled", ...(this.problem ? { error: this.problem } : {}) };
  }
  configure(input: unknown) {
    const config = this.validate(input);
    const changed = this.change.then(async () => {
      this.stopNetwork(); this.config = config;
      writePrivateFileAtomicSync(join(this.dir, "config.json"), JSON.stringify(config, null, 2));
      if (config.enabled) try { await this.open(); } catch (error) { this.problem = error instanceof Error ? error.message : "연결을 시작하지 못했습니다."; throw error; }
      return this.state();
    });
    this.change = changed.catch(() => {}); return changed;
  }
  async createOffer() {
    if (!this.config.enabled || !this.server || !this.keys) throw new HttpError(409, "remote_disabled", "먼저 이 PC의 원격 연결을 켜 주세요.");
    const offer = this.registry.createOffer({});
    const data: RemoteOffer = { v: 2, serverId: offer.hostId, daemonPublicKeyB64: this.keys.publicKeyB64,
      relay: { endpoint: new URL(this.config.relayUrl || this.endpoint).host, useTls: new URL(this.config.relayUrl || this.endpoint).protocol === "wss:" }, minimumSecurityMode: "protected",
      workbench: { version: 1, endpoint: this.endpoint, offerId: offer.offerId, token: offer.token, expiresAt: offer.expiresAt, label: this.config.label ?? offer.hostId } };
    const base = this.config.publicUrl || "workbench://connect/";
    const url = base.replace(/\/$/, "") + "/#offer=" + Buffer.from(JSON.stringify(data)).toString("base64url");
    return { ...offer, url, qrDataUrl: await QRCode.toDataURL(url, { width: 320, margin: 2 }), hostFingerprint: this.state().hostFingerprint };
  }
  private stopNetwork() {
    void this.relay?.stop().catch(() => {}); this.relay = null; this.gateway.close();
    for (const socket of this.ws?.clients ?? []) socket.close(1000, "remote configuration changed");
    this.ws?.close(); this.ws = null; this.server?.close(); this.server = null;
  }
  close() { this.stopNetwork(); this.registry.close(); }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!url.pathname.startsWith("/api/devices")) return false;
    const method = req.method ?? "GET", parts = url.pathname.split("/").filter(Boolean);
    const body = async () => JSON.parse((await readBody(req, 32_000)).toString("utf8") || "{}") as Record<string, unknown>;
    let value: unknown;
    if (method === "GET" && url.pathname === "/api/devices") value = this.state();
    else if (method === "PUT" && parts[2] === "config") value = await this.configure(await body());
    else if (method === "POST" && parts[2] === "offers") value = await this.createOffer();
    else if (method === "POST" && parts[2] === "enrollments" && parts[3]) {
      if (parts[4] === "approve") {
        const approval = await body() as unknown as DeviceApproval;
        if (!Array.isArray(approval.workIds) || approval.workIds.some(id => !this.options.manager.view.works.has(id))) throw new HttpError(400, "work_scope", "승인할 프로젝트를 다시 선택해 주세요.");
        value = this.registry.approve(decodeURIComponent(parts[3]), approval);
      } else if (parts[4] === "reject") { this.registry.reject(decodeURIComponent(parts[3])); value = { ok: true }; }
      else throw new HttpError(404, "not_found", "기기 관리 요청을 찾지 못했습니다.");
    } else if (method === "POST" && parts[2] && ["revoke", "rotate"].includes(parts[3] ?? "")) {
      this.registry.revoke(decodeURIComponent(parts[2]));
      value = parts[3] === "rotate" ? await this.createOffer() : { ok: true };
    } else throw new HttpError(404, "not_found", "기기 관리 요청을 찾지 못했습니다.");
    sendJson(res, 200, value ?? { ok: true }); return true;
  }
}
