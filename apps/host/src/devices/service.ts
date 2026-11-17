import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import pino from "pino";
import QRCode from "qrcode";
import { writePrivateFileAtomicSync, ensurePrivateDirectory } from "@workbench/paseo-server-transport/private-files";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { DeviceApproval, RemoteOffer, TailscaleView } from "@workbench/contracts";
import { DeviceRegistry } from "../devices.ts";
import type { SessionManager } from "../sessions.ts";
import type { EventBus } from "../bus.ts";
import { HttpError } from "../errors.ts";
import { sendJson, readBody, serveStatic } from "../http.ts";
import { DeviceGateway } from "./gateway.ts";
import { commandLine, detectTailscale, endLeftoverServe, parseServe, readServe, serveOnArgv, tailscaleProgram, TailscaleNotRunnable, writeServeChildFile,
  type TailscaleRecord, type TailscaleRun, type TailscaleSpawn } from "./tailscale.ts";
import { attachProtectedSocket, loadOrCreateKeyPair, startProtectedRelayTransport, type DaemonKeyPairBundle } from "./transport.ts";

type DeviceConfig = { enabled: boolean; label?: string; relayUrl?: string; publicUrl?: string; listenHost?: string; port?: number };
/** A page address a phone can open: the configured one, unless it names this PC itself. */
function phoneUrl(config: DeviceConfig): string | null {
  if (!config.publicUrl) return null;
  const host = new URL(config.publicUrl).hostname;
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" ? null : config.publicUrl;
}
/** host:port for a wss relay address; a URL on the default port has none in `host` (M01: the relay start lost it). */
export function relayEndpointOf(relayUrl: string): string {
  const url = new URL(relayUrl);
  return url.port ? url.host : url.hostname + ":" + (url.protocol === "wss:" ? 443 : 80);
}
/** Funnel (Tailscale's public-internet mode) marks what it forwards; such a request is never let in. */
const viaFunnel = (req: IncomingMessage) => req.headers["tailscale-funnel-request"] !== undefined;
/** The name a device used to reach this listener (Serve passes the tailnet name on). */
const reachedAs = (req: IncomingMessage) => {
  const raw = req.headers["x-forwarded-host"] ?? req.headers.host;
  return (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim().toLowerCase().replace(/:443$/, "") ?? "";
};
/** The gateway's one foreground `tailscale serve` child (M3): it lives only while the gateway and the listener do. */
type ServeChild = { child: ChildProcess; port: number; argv: string[]; startedAt: number; confirmed: boolean; stopping: boolean; last: string; lastError: string; exited: Promise<void> };
/** A line the CLI printed, as plain bounded text (it is shown in the panel as text). */
const cleanLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
/** The CLI's answer with, when it is about rights, what to run and what that allows (L2). */
function failedLine(head: string, said: string) {
  // On Linux a normal user may change Serve only as the node's operator (to confirm with the real CLI).
  const rights = /access denied|operator|permission denied|must be root|sudo/i.test(said)
    ? " 이 PC에서 테일스케일 설정을 바꿀 권한이 없습니다. 터미널에서 ‘sudo tailscale set --operator=$USER’를 한 번 실행한 뒤 다시 켜기를 누르세요. 그러면 이 PC에서 내 계정으로 실행되는 모든 프로그램(AI 엔진 포함)이 테일스케일의 Serve와 Funnel 설정을 바꿀 수 있게 됩니다." : "";
  return `${head}${rights}${said ? ` (테일스케일의 답: ${said})` : ""}`;
}
export class DeviceService {
  readonly registry: DeviceRegistry;
  private readonly options: { dataDir: string; manager: SessionManager; bus: EventBus; localOrigin: () => string | null; localToken: string; webDir: string | null; push?: () => import("../push/devices.ts").PushDevices | undefined; voice?: import("../voice.ts").VoiceService; servicePreviews?: import("../service-previews.ts").ServicePreviews; eventIngress?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    /** The `tailscale` CLI (tests pass a stand-in). */ tailscale?: TailscaleRun;
    /** Starts the foreground serve child (tests pass a stand-in). */ tailscaleSpawn?: TailscaleSpawn;
    /** First back-off step before a closed serve child is started again (ms; the steps grow to 60×). */ serveRetryMs?: number;
    /** How often and how many times `serve status` is read after the child starts (L1). */ serveConfirm?: { tries: number; everyMs: number };
    /** How long to wait before trying a busy kept port again (M01). */ portRetryMs?: number };
  private readonly gateway: DeviceGateway;
  private readonly dir: string;
  private readonly logger = pino({ level: "silent" });
  private config: DeviceConfig = { enabled: false, listenHost: "127.0.0.1", port: 0 };
  private keys: DaemonKeyPairBundle | null = null;
  private server: Server | null = null;
  private ws: WebSocketServer | null = null;
  private relay: ReturnType<typeof startProtectedRelayTransport> | null = null;
  private endpoint = "";
  private port: number | null = null;
  private problem = "";
  private change: Promise<unknown> = Promise.resolve();
  private retry: NodeJS.Timeout | null = null;
  /** A free port picked for the 켜기 preview when none is kept yet; the listener then binds exactly it. */
  private proposedPort = 0;
  /** When a device last signed in through the Tailscale address (this run of the gateway). */
  private tailscaleSeenAt: number | null = null;
  private readonly tailscale: TailscaleRun;
  private readonly spawnTailscale: TailscaleSpawn;
  private serve: ServeChild | null = null;
  /** Why the road closed last (shown while the person's 켜기 stands), how often in a row, and the back-off timer. */
  private serveWhy = "";
  private serveFailures = 0;
  private serveRetry: NodeJS.Timeout | null = null;
  constructor(options: DeviceService["options"]) {
    this.options = options; this.dir = join(options.dataDir, "remote-devices");
    ensurePrivateDirectory(this.dir);
    this.registry = new DeviceRegistry(options.dataDir, options.manager.snapshot().hostId);
    this.gateway = new DeviceGateway({ registry: this.registry, ...options, onAuthenticated: (origin) => this.noteDevice(origin) });
    // The CLI runs from absolute places only, in the app's data folder (M1).
    const program = tailscaleProgram(options.dataDir);
    this.tailscale = options.tailscale ?? program.run;
    this.spawnTailscale = options.tailscaleSpawn ?? program.spawn;
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
    // Before anything else: a serve child left running by a hard-killed gateway is ended (M3).
    await endLeftoverServe(this.serveFile(), process.platform, this.options.dataDir).catch(() => "none");
    this.keys = await loadOrCreateKeyPair(this.dir, this.logger);
    await this.startOrRetry(0);
  }
  /** At start a kept port can still be held by the previous run or another program: try again for a while (M01). */
  private async startOrRetry(attempt: number) {
    this.retry = null;
    if (!this.config.enabled || this.server) return;
    try { await this.open(); }
    catch (error) {
      this.problem = error instanceof Error ? error.message : "원격 연결을 시작하지 못했습니다.";
      if ((error as { code?: string }).code === "device_port_in_use" && attempt < 60) {
        this.problem += " 포트가 비면 저절로 다시 시도합니다.";
        this.retry = setTimeout(() => { this.change = this.change.then(() => this.startOrRetry(attempt + 1)).catch(() => {}); }, this.options.portRetryMs ?? 5_000);
        this.retry.unref?.();
      }
    }
  }
  private async open() {
    if (!this.keys || !this.config.enabled) return;
    const keys = this.keys;
    const server = createServer((req, res) => {
      if (viaFunnel(req)) return sendJson(res, 403, { code: "funnel_refused", message: "인터넷 공개 주소(Funnel)로는 이 PC에 연결할 수 없습니다." });
      if (this.options.servicePreviews?.handle(req, res, "device")) return;
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path.startsWith("/hub/events/") && this.options.eventIngress) { void this.options.eventIngress(req, res); return; }
      if (path.startsWith("/api/")) return sendJson(res, 404, { code: "protected_channel_required", message: "보호된 기기 연결이 필요합니다." });
      if (!this.options.webDir) return sendJson(res, 503, { code: "web_missing", message: "웹 화면이 포함된 설치본에서 열어 주세요." });
      // Pages a device opens are never shown inside another site's frame, load no plugins and take no
      // <base>; the design page is framed by the app itself from this same address. There is no script
      // rule: the app's bundles load as built. Nothing served here is type-guessed.
      res.setHeader("x-content-type-options", "nosniff");
      try {
        serveStatic(res, this.options.webDir, path, { "content-security-policy": `frame-ancestors ${/^\/design(\/|$)/.test(path) ? "'self'" : "'none'"}; object-src 'none'; base-uri 'none'`, "referrer-policy": "no-referrer" }, req);
      }
      catch { sendJson(res, 404, { code: "not_found", message: "화면을 찾지 못했습니다." }); }
    });
    const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      if (viaFunnel(req)) { socket.destroy(); return; }
      if (this.options.servicePreviews?.handleUpgrade(req, socket, head, "device")) return;
      if (!this.config.enabled || new URL(req.url ?? "/", "http://localhost").pathname !== "/workbench") { socket.destroy(); return; }
      const origin = { host: reachedAs(req) };
      ws.handleUpgrade(req, socket, head, raw => { void attachProtectedSocket(raw, { keyPair: keys.keyPair, logger: this.logger }, secured => this.gateway.attach(secured, origin)); });
    });
    // Devices save this address. Port 0 means "choose once": the port bound the first time is kept
    // for later starts, and a kept port that is taken is reported rather than replaced by another.
    const wanted = this.config.port || this.keptPort() || this.proposedPort;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(wanted, this.config.listenHost ?? "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    } catch (error) {
      ws.close(); server.close();
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && wanted) throw new HttpError(409, "device_port_in_use", `원격 연결 포트 ${wanted}번을 다른 프로그램이 쓰고 있어 기기 연결을 받지 못합니다. 그 프로그램을 닫고 ‘설정 저장’을 다시 누르거나, 연결 주소 설정에서 다른 포트를 정해 주세요. 포트를 바꾸면 이미 연결한 기기의 주소도 새 포트로 바뀝니다.`);
      throw error;
    }
    this.server = server; this.ws = ws;
    const address = server.address(), port = typeof address === "object" && address ? address.port : 0;
    this.port = port;
    if (!this.config.port && port !== this.keptPort()) writePrivateFileAtomicSync(join(this.dir, "port"), String(port));
    this.proposedPort = 0;
    const publicUrl = this.config.publicUrl ? new URL(this.config.publicUrl) : null;
    this.endpoint = publicUrl
      ? (publicUrl.protocol === "https:" ? "wss://" : "ws://") + publicUrl.host + "/workbench"
      : "ws://127.0.0.1:" + port + "/workbench";
    if (this.config.relayUrl) {
      const relayEndpoint = relayEndpointOf(this.config.relayUrl);
      this.relay = startProtectedRelayTransport({
        serverId: this.options.manager.snapshot().hostId, relayEndpoint, relayUseTls: true,
        keyPair: keys.keyPair, logger: this.logger, onSecured: secured => this.gateway.attach(secured),
      });
      this.endpoint = buildRelayWebSocketUrl({ endpoint: relayEndpoint, serverId: this.options.manager.snapshot().hostId, role: "client", useTls: true });
    }
    this.problem = "";
    // The listener really holds its port now: the person's standing 켜기 opens the road to it (after this step).
    if (this.tailscaleRecord()) this.change = this.change.then(() => this.bringServeUp()).catch(() => {});
  }
  hubIngressState() {
    const enabled = !!this.server && this.config.enabled && !!this.config.publicUrl?.startsWith("https://");
    return { enabled, url: enabled ? new URL("/hub/events/", this.config.publicUrl).href : null,
      message: enabled ? "각 연결의 서명 검증을 통과한 사건만 접수합니다." : "기기 연결에서 공개 HTTPS 주소를 등록해야 외부 사건을 받을 수 있습니다." };
  }
  private keptPort(): number {
    try {
      const saved = Number(readFileSync(join(this.dir, "port"), "utf8").trim());
      return Number.isInteger(saved) && saved > 1024 && saved < 65536 ? saved : 0;
    } catch { return 0; }
  }
  state() {
    return { config: this.config, hostId: this.options.manager.snapshot().hostId,
      // The port in use, and the page address a phone can open (none: this PC cannot be reached from one yet).
      port: this.server ? this.port : null, phoneUrl: phoneUrl(this.config),
      hostFingerprint: this.keys ? createHash("sha256").update(this.keys.publicKeyB64).digest("hex").match(/.{1,8}/g)!.join(" ") : "",
      pending: this.registry.listPending(), devices: this.registry.list(),
      workspaces: this.options.manager.snapshot().works.map(work => ({ workId: work.id, label: work.title })),
      status: this.problem ? "error" : this.server ? "listening" : "disabled", ...(this.problem ? { error: this.problem } : {}) };
  }
  configure(input: unknown) {
    const config = this.validate(input);
    const changed = this.change.then(async () => {
      this.stopNetwork(); this.config = config; this.problem = "";
      writePrivateFileAtomicSync(join(this.dir, "config.json"), JSON.stringify(config, null, 2));
      if (config.enabled) try { await this.open(); } catch (error) { this.problem = error instanceof Error ? error.message : "연결을 시작하지 못했습니다."; throw error; }
      return this.state();
    });
    this.change = changed.catch(() => {}); return changed;
  }
  async createOffer() {
    if (!this.config.enabled || !this.server || !this.keys) throw new HttpError(409, "remote_disabled", "먼저 이 PC의 원격 연결을 켜 주세요.");
    const offer = this.registry.createOffer({});
    // The device's parser needs host:port; a URL on its scheme's default port has none in `host`.
    const route = new URL(this.config.relayUrl || this.endpoint), secure = route.protocol === "wss:";
    const data: RemoteOffer = { v: 2, serverId: offer.hostId, daemonPublicKeyB64: this.keys.publicKeyB64,
      relay: { endpoint: route.port ? route.host : route.hostname + ":" + (secure ? 443 : 80), useTls: secure }, minimumSecurityMode: "protected",
      workbench: { version: 1, endpoint: this.endpoint, offerId: offer.offerId, token: offer.token, expiresAt: offer.expiresAt, label: this.config.label ?? offer.hostId } };
    const base = this.config.publicUrl || "workbench://connect/";
    const url = base.replace(/\/$/, "") + "/#offer=" + Buffer.from(JSON.stringify(data)).toString("base64url");
    // A QR is for a phone's camera. Without a page address a phone can open, the link is only for pasting into another Workbench.
    return { ...offer, url, qrDataUrl: phoneUrl(this.config) ? await QRCode.toDataURL(url, { width: 320, margin: 2 }) : null, hostFingerprint: this.state().hostFingerprint };
  }
  previewEndpointState() { return { enabled: this.config.enabled && this.server !== null, appOrigin: this.config.publicUrl || null }; }
  private stopNetwork() {
    // The listener goes: the serve child goes first (it is started again only once a listener is up).
    this.clearServeRetry(); void this.stopServe();
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.options.servicePreviews?.closeRemote();
    void this.relay?.stop().catch(() => {}); this.relay = null; this.gateway.close();
    for (const socket of this.ws?.clients ?? []) socket.close(1000, "remote configuration changed");
    this.ws?.close(); this.ws = null; this.server?.close(); this.server = null; this.port = null;
  }
  close() { this.stopNetwork(); this.registry.close(); }

  // ── 테일스케일로 연결 ───────────────────────────────────────────────────────────────────────────
  private recordFile() { return join(this.dir, "tailscale.json"); }
  private serveFile() { return join(this.dir, "tailscale-serve.json"); }
  /** The person's standing 켜기 (until 끄기), with what to put back. */
  private tailscaleRecord(): TailscaleRecord | null {
    try {
      const value = JSON.parse(readFileSync(this.recordFile(), "utf8")) as TailscaleRecord;
      return value && typeof value.address === "string" && value.previous && typeof value.port === "number" ? value : null;
    } catch { return null; }
  }
  private noteDevice(origin: { host?: string } | undefined) {
    const record = this.tailscaleRecord();
    if (record && origin?.host && "https://" + origin.host === record.address) this.tailscaleSeenAt = Date.now();
  }
  /** The device port Serve is to reach: the one listening, the chosen or kept one, else a free one picked now. */
  private async servedPort(): Promise<number> {
    const known = this.port ?? (this.config.port || this.keptPort() || this.proposedPort);
    if (known) return known;
    const probe = createNetServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const at = probe.address(); await new Promise<void>(resolve => probe.close(() => resolve()));
    this.proposedPort = typeof at === "object" && at ? at.port : 0;
    return this.proposedPort;
  }
  async tailscaleState(): Promise<TailscaleView & { port: number; commandLine?: string }> {
    const port = await this.servedPort();
    const view = await detectTailscale(this.tailscale, { port, record: this.tailscaleRecord(), seenAt: this.tailscaleSeenAt,
      listening: !!this.server && this.config.listenHost === "127.0.0.1", publicUrl: this.config.publicUrl ?? "",
      serving: this.serve ? (this.serve.confirmed ? "running" : "opening") : "off", why: this.serveWhy, retrying: !!this.serveRetry });
    return { ...view, port, ...("command" in view ? { commandLine: commandLine(view.command) } : {}) };
  }

  // The foreground serve child (M3): started only while the listener holds its port, ended with it,
  // with the gateway, and by 끄기; tried again with a growing back-off only while 켜기 stands.
  private clearServeRetry() { if (this.serveRetry) { clearTimeout(this.serveRetry); this.serveRetry = null; } }
  private async startServe(port: number): Promise<ServeChild> {
    const argv = serveOnArgv(port);
    let started: ReturnType<TailscaleSpawn>;
    try { started = this.spawnTailscale(argv); }
    catch (error) { throw error instanceof TailscaleNotRunnable ? new HttpError(409, "tailscale_not_runnable", error.message) : error; }
    if (!started) throw new HttpError(409, "tailscale_missing", "이 PC에서 테일스케일을 찾지 못했습니다. 설치한 뒤 다시 확인을 누르세요.");
    const { child, program } = started;
    const entry: ServeChild = { child, port, argv, startedAt: Date.now(), confirmed: false, stopping: false, last: "", lastError: "", exited: Promise.resolve() };
    const take = (error: boolean) => (chunk: Buffer | string) => {
      // The CLI's own banner ("Press Ctrl+C to exit.") says nothing about why it ended.
      const line = String(chunk).split(/\r?\n/).map(cleanLine).filter(text => text && !/ctrl\+c/i.test(text)).at(-1);
      if (line) { entry.last = line; if (error) entry.lastError = line; }
    };
    child.stdout?.on("data", take(false)); child.stderr?.on("data", take(true));
    entry.exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    try { await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw new HttpError(409, "tailscale_not_runnable", new TailscaleNotRunnable(program).message);
      throw new HttpError(409, "tailscale_failed", failedLine("테일스케일 Serve를 시작하지 못했습니다.", cleanLine(String((error as Error).message ?? ""))));
    }
    child.on("error", () => {});
    this.serve = entry;
    writeServeChildFile(this.serveFile(), child.pid!, argv, process.platform, this.options.dataDir, program);
    void entry.exited.then(() => this.serveExited(entry));
    return entry;
  }
  private serveExited(entry: ServeChild) {
    try { if ((JSON.parse(readFileSync(this.serveFile(), "utf8")) as { pid?: number }).pid === entry.child.pid) rmSync(this.serveFile(), { force: true }); } catch { /* none */ }
    if (this.serve === entry) this.serve = null;
    // A road that was open closed by itself (logged out, HTTPS off, Tailscale stopped). One that never
    // opened is reported by its confirmation instead.
    // The back-off starts over only after a road that stayed open for a minute; a road that keeps closing waits longer each time.
    if (!entry.stopping && entry.confirmed) {
      if (Date.now() - entry.startedAt >= 60_000) this.serveFailures = 0;
      this.serveFailed(failedLine("테일스케일 Serve가 끝났습니다.", entry.lastError || entry.last));
    }
  }
  private serveFailed(why: string) {
    this.serveWhy = why; this.serveFailures++;
    if (this.serveRetry || !this.tailscaleRecord() || !this.server) return;
    const steps = [1, 3, 6, 12, 24, 60];
    const delay = (this.options.serveRetryMs ?? 5_000) * steps[Math.min(this.serveFailures, steps.length) - 1]!;
    this.serveRetry = setTimeout(() => { this.serveRetry = null; this.change = this.change.then(() => this.bringServeUp()).catch(() => {}); }, delay);
    this.serveRetry.unref?.();
  }
  /** Ends the child (SIGTERM; on Windows the process is terminated) and resolves once it is gone. */
  private stopServe(entry = this.serve): Promise<void> {
    if (!entry) return Promise.resolve();
    if (this.serve === entry) this.serve = null;
    entry.stopping = true;
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      entry.child.kill("SIGTERM");
      const hard = setTimeout(() => { if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGKILL"); }, 3_000);
      hard.unref?.(); void entry.exited.then(() => clearTimeout(hard));
    }
    return entry.exited;
  }
  /**
   * L1: after starting, read `serve status` a few times (the first certificate can take a while; the
   * panel says 여는 중 meanwhile) — "on" only once 443 really points at this app's port in a foreground
   * session. Otherwise the child is ended and the reason kept.
   */
  private async confirmServe(entry: ServeChild): Promise<{ ok: boolean; why: string }> {
    const { tries, everyMs } = this.options.serveConfirm ?? { tries: 12, everyMs: 1_500 };
    const gone = () => entry.stopping || this.serve !== entry;
    const closedBySelf = () => ({ ok: false, why: entry.stopping ? "" : failedLine("테일스케일 Serve를 켜지 못했습니다.", entry.lastError || entry.last) });
    for (let i = 0; i < tries; i++) {
      if (gone()) return closedBySelf();
      const serve = parseServe(await this.tailscale(["serve", "status", "--json"]).catch(() => null));
      if (gone()) return closedBySelf();
      if (serve && readServe(serve, entry.port).use === "ours") {
        entry.confirmed = true; this.serveWhy = "";
        // The command line is read again now that the program runs (a script's interpreter has started by now).
        writeServeChildFile(this.serveFile(), entry.child.pid!, entry.argv, process.platform, this.options.dataDir);
        return { ok: true, why: "" };
      }
      await new Promise(resolve => setTimeout(resolve, everyMs));
    }
    if (gone()) return closedBySelf();
    const said = entry.lastError || entry.last;
    await this.stopServe(entry);
    return { ok: false, why: failedLine("테일스케일이 이 앱의 길을 열지 않았습니다.", said) };
  }
  /** At gateway start, after the listener moved, and on each back-off step: the person's standing 켜기. */
  private async bringServeUp() {
    this.clearServeRetry();
    const record = this.tailscaleRecord();
    if (!record || !this.server || !this.port || this.serve) return;
    if (record.port !== this.port) writePrivateFileAtomicSync(this.recordFile(), JSON.stringify({ ...record, port: this.port }, null, 2));
    let entry: ServeChild;
    try { entry = await this.startServe(this.port); }
    catch (error) { this.serveFailed(error instanceof Error ? error.message : "테일스케일 Serve를 시작하지 못했습니다."); return; }
    // Not awaited inside the change chain: a configure or 끄기 meanwhile simply ends this child.
    void this.confirmServe(entry).then(result => { if (!result.ok && result.why) this.serveFailed(result.why); });
  }
  /** 켜기: only the command the person saw, only from the ready state; listener on 127.0.0.1, address from the CLI. */
  tailscaleOn(input: unknown) {
    const run = this.change.then(async () => {
      const view = await this.tailscaleState();
      const shown = (input as { command?: unknown } | null)?.command;
      if (view.state !== "ready") throw new HttpError(409, "tailscale_not_ready", "테일스케일 상태가 바뀌었습니다. 다시 확인을 누른 뒤 보이는 안내를 따라 주세요.");
      if (!Array.isArray(shown) || shown.length !== view.command.length || shown.some((part, index) => part !== view.command[index])) throw new HttpError(409, "tailscale_command_changed", "실행할 명령이 화면에 보인 것과 달라졌습니다. 다시 확인을 누른 뒤 새 명령을 보고 눌러 주세요.");
      if (this.tailscaleRecord()) {
        // 켜기 already stands and the road is closed: open it now instead of waiting for the back-off.
        if (!this.server || this.port !== view.port) throw new HttpError(409, "tailscale_listener_off", "작업실의 연결 받기가 꺼져 있어 테일스케일 길을 열 수 없습니다. 연결 설정을 확인해 주세요.");
        this.clearServeRetry();
        let entry: ServeChild;
        try { entry = await this.startServe(view.port); }
        catch (error) { this.serveFailed(error instanceof Error ? error.message : ""); throw error; }
        const result = await this.confirmServe(entry);
        if (!result.ok) { this.serveFailed(result.why); throw new HttpError(409, "tailscale_failed", result.why || "테일스케일 Serve를 켜지 못했습니다."); }
        return this.tailscaleState();
      }
      const previous = { enabled: this.config.enabled, publicUrl: this.config.publicUrl ?? "", listenHost: this.config.listenHost ?? "127.0.0.1", port: this.config.port ?? 0 };
      const record: TailscaleRecord = { previous, address: view.address, port: view.port, at: Date.now() };
      // Remote access on, listening on this PC only at the very port the command names; the phone's address is the CLI's name.
      const next = this.validate({ ...this.config, enabled: true, listenHost: "127.0.0.1", publicUrl: view.address, port: this.config.port ?? 0 });
      this.stopNetwork(); this.config = next; this.problem = "";
      if (!next.port) this.proposedPort = view.port;
      try {
        await this.open();
        if (this.port !== view.port) throw new HttpError(409, "tailscale_port_moved", "이 PC의 연결 포트가 바뀌었습니다. 다시 확인을 누르세요.");
        writePrivateFileAtomicSync(join(this.dir, "config.json"), JSON.stringify(next, null, 2));
        writePrivateFileAtomicSync(this.recordFile(), JSON.stringify(record, null, 2));
        this.serveWhy = ""; this.serveFailures = 0;
        const entry = await this.startServe(view.port);
        const result = await this.confirmServe(entry);
        if (!result.ok) throw new HttpError(409, "tailscale_failed", result.why || "테일스케일 Serve를 켜지 못했습니다.");
      } catch (error) {
        // Nothing half-done is left: no child, no standing choice, the connection settings as they were.
        rmSync(this.recordFile(), { force: true });
        this.serveWhy = ""; this.serveFailures = 0;
        this.stopNetwork(); this.config = this.validate({ ...next, ...previous });
        writePrivateFileAtomicSync(join(this.dir, "config.json"), JSON.stringify(this.config, null, 2));
        if (this.config.enabled) await this.open().catch(() => {});
        throw error;
      }
      return this.tailscaleState();
    });
    this.change = run.catch(() => {}); return run;
  }
  /**
   * 끄기: the standing choice goes, the child is ended (its foreground session goes with it), and the
   * connection settings are put back as they were. No Tailscale command is run and nothing is written
   * into Tailscale's own configuration.
   */
  tailscaleOff() {
    const run = this.change.then(async () => {
      const record = this.tailscaleRecord();
      if (!record) throw new HttpError(409, "tailscale_not_ours", "이 앱이 켠 테일스케일 연결이 없습니다. 직접 켠 설정은 테일스케일에서 끄세요.");
      rmSync(this.recordFile(), { force: true });
      this.clearServeRetry(); this.serveWhy = ""; this.serveFailures = 0;
      await this.stopServe();
      if (this.config.publicUrl === record.address) {
        this.stopNetwork();
        this.config = this.validate({ ...this.config, ...record.previous });
        writePrivateFileAtomicSync(join(this.dir, "config.json"), JSON.stringify(this.config, null, 2));
        if (this.config.enabled) await this.open().catch(error => { this.problem = error instanceof Error ? error.message : "연결을 시작하지 못했습니다."; });
      }
      this.tailscaleSeenAt = null;
      return this.tailscaleState();
    });
    this.change = run.catch(() => {}); return run;
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!url.pathname.startsWith("/api/devices")) return false;
    const method = req.method ?? "GET", parts = url.pathname.split("/").filter(Boolean);
    const body = async () => JSON.parse((await readBody(req, 32_000)).toString("utf8") || "{}") as Record<string, unknown>;
    let value: unknown;
    if (method === "GET" && url.pathname === "/api/devices") value = this.state();
    else if (method === "GET" && url.pathname === "/api/devices/tailscale") value = await this.tailscaleState();
    else if (method === "POST" && url.pathname === "/api/devices/tailscale/on") value = await this.tailscaleOn(await body());
    else if (method === "POST" && url.pathname === "/api/devices/tailscale/off") value = await this.tailscaleOff();
    else if (method === "PUT" && parts[2] === "config") value = await this.configure(await body());
    else if (method === "POST" && parts[2] === "offers") value = await this.createOffer();
    else if (method === "POST" && parts[2] === "enrollments" && parts[3]) {
      if (parts[4] === "approve") {
        const approval = await body() as unknown as DeviceApproval;
        if (!Array.isArray(approval.workIds) || approval.workIds.some(id => !this.options.manager.view.works.has(id))) throw new HttpError(400, "work_scope", "승인할 프로젝트를 다시 선택해 주세요.");
        value = this.registry.approve(decodeURIComponent(parts[3]), approval);
      } else if (parts[4] === "reject") { this.registry.reject(decodeURIComponent(parts[3])); value = { ok: true }; }
      else throw new HttpError(404, "not_found", "기기 관리 요청을 찾지 못했습니다.");
    } else if (method === "POST" && parts[2] && parts[3] === "remove") {
      this.registry.remove(decodeURIComponent(parts[2])); value = { ok: true };
    } else if (method === "POST" && parts[2] && ["revoke", "rotate"].includes(parts[3] ?? "")) {
      this.registry.revoke(decodeURIComponent(parts[2]));
      value = parts[3] === "rotate" ? await this.createOffer() : { ok: true };
    } else throw new HttpError(404, "not_found", "기기 관리 요청을 찾지 못했습니다.");
    sendJson(res, 200, value ?? { ok: true }); return true;
  }
}
