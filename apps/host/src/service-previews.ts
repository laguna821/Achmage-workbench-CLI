import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import express from "express";
import pino from "pino";
import { createServiceProxySubsystem } from "@workbench/paseo-terminal/service-proxy";
import type { WorkspaceServicePreview, WorkspaceServicePreviewSettings } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { WorkspaceServices } from "./workspace-services.ts";
import { HttpError } from "./errors.ts";

const cookieName = "workbench_service_preview", openPath = "/__workbench_preview/open";
const settingsKey = "service-preview-settings:v1", lifetime = 60 * 60_000;
type Audience = "local" | "device";
type Options = {
  store: Store; services: WorkspaceServices; localOrigin: () => string | null;
  remote: () => { enabled: boolean; appOrigin: string | null };
};
type Binding = {
  id: string; serviceId: string; workspaceId: string; owner: string; audience: Audience; port: number;
  origin: URL; expiresAt: number; bootstrapUntil: number; bootstrap: string | null;
  cookieHash: Buffer | null; check: () => void; sockets: Set<Duplex>;
};
const hash = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: Buffer | null, b: Buffer) => a !== null && a.length === b.length && timingSafeEqual(a, b);
const bootstrapScript = `const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);fetch(location.pathname,{method:'POST',headers:{'content-type':'text/plain'},body:token,credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error(await r.text());location.replace('/')}).catch(e=>{document.getElementById('status').textContent=e.message})`;
const bootstrapCsp = "default-src 'none'; script-src 'sha256-" + createHash("sha256").update(bootstrapScript).digest("base64") + "'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Original Paseo streaming HTTP/WebSocket proxy, behind a separate origin and one owned execution. */
export class ServicePreviews {
  private readonly proxy = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
  private readonly app = express();
  private readonly upgrade = this.proxy.upgradeHandler({ passthroughUnknown: false });
  private readonly bindings = new Map<string, Binding>();
  private readonly watch: ReturnType<typeof setInterval>;
  private publicBaseUrl: string | null = null;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    const saved = options.store.getMeta(settingsKey);
    if (saved) try { this.publicBaseUrl = this.validateBase(JSON.parse(saved).publicBaseUrl); } catch { /* Invalid configuration stays disabled. */ }
    this.app.disable("x-powered-by");
    this.app.use(this.proxy.middleware());
    this.app.use((_req, res) => { res.status(404).end("Service preview expired"); });
    this.watch = setInterval(() => {
      for (const binding of this.bindings.values()) try { this.check(binding); } catch { this.remove(binding); }
    }, 1000);
    this.watch.unref();
  }
  private validateBase(value: unknown): string | null {
    if (value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 2048) throw new HttpError(400, "service_preview_address", "서비스 미리보기 전용 HTTPS 주소를 입력해 주세요.");
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new HttpError(400, "service_preview_address", "HTTPS 주소를 확인해 주세요."); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes(".") || url.hostname.endsWith(".localhost") || /^[\d.]+$/.test(url.hostname)) throw new HttpError(400, "service_preview_address", "경로·인증정보 없는 별도 HTTPS 도메인을 입력해 주세요.");
    return url.origin;
  }
  private checkPublicOrigin() {
    const appOrigin = this.options.remote().appOrigin;
    if (!appOrigin || !this.publicBaseUrl) return;
    const app = new URL(appOrigin).hostname, preview = new URL(this.publicBaseUrl).hostname;
    if (app === preview || app.endsWith("." + preview) || preview.endsWith("." + app)) throw new HttpError(400, "service_preview_origin", "Workbench 접속 주소와 별도의 미리보기 도메인을 사용해 주세요.");
  }
  settings(): WorkspaceServicePreviewSettings {
    const enabled = this.options.remote().enabled;
    let message = !enabled ? "이 PC의 기기 연결을 켜면 휴대폰에서도 서비스 화면을 열 수 있습니다." : !this.publicBaseUrl ? "서비스 미리보기 전용 HTTPS 주소를 등록해 주세요." : "등록한 도메인의 하위 주소를 이 PC의 기기 연결 포트로 전달하도록 설정해 주세요.";
    try { this.checkPublicOrigin(); } catch (error) { message = (error as Error).message; }
    return { publicBaseUrl: this.publicBaseUrl, remoteEnabled: enabled, message };
  }
  configure(input: { publicBaseUrl?: unknown }): WorkspaceServicePreviewSettings {
    const next = this.validateBase(input?.publicBaseUrl ?? null), before = this.publicBaseUrl;
    this.publicBaseUrl = next;
    try { this.checkPublicOrigin(); } catch (error) { this.publicBaseUrl = before; throw error; }
    this.options.store.setMeta(settingsKey, JSON.stringify({ publicBaseUrl: next }));
    for (const binding of this.bindings.values()) if (binding.audience === "device") this.remove(binding);
    return this.settings();
  }
  create(serviceId: string, audience: Audience, owner: string, authorize: (workId: string) => void = () => {}): WorkspaceServicePreview {
    for (const binding of this.bindings.values()) try { this.check(binding); } catch { this.remove(binding); }
    if (this.bindings.size >= 128) throw new HttpError(429, "service_preview_limit", "열어 둔 서비스 화면의 연결을 종료한 뒤 다시 열어 주세요.");
    const target = this.options.services.proxyTarget(serviceId, authorize);
    const localOrigin = this.options.localOrigin();
    if (!localOrigin) throw new HttpError(503, "service_preview_starting", "호스트를 시작하고 있습니다.");
    if (audience === "device" && (!this.options.remote().enabled || !this.publicBaseUrl)) throw new HttpError(409, "service_preview_setup", "호스트의 서버·실행 관리에서 휴대폰 미리보기 주소를 먼저 설정해 주세요.");
    if (audience === "device") this.checkPublicOrigin();
    const id = randomBytes(16).toString("hex");
    const identity = { workspaceId: target.service.workspaceId, projectSlug: "workbench", branchName: null, scriptName: id };
    this.proxy.registerWorkspaceService({ ...identity, port: target.service.port!, ...(audience === "device" ? { publicBaseUrl: this.publicBaseUrl } : {}) });
    const urls = this.proxy.projectUrls({ ...identity, daemonPort: Number(new URL(localOrigin).port), ...(audience === "device" ? { publicBaseUrl: this.publicBaseUrl } : {}) });
    const origin = new URL(audience === "device" ? urls.publicProxyUrl! : urls.localProxyUrl!);
    const secret = randomBytes(32).toString("base64url"), expiresAt = Date.now() + lifetime;
    const base = this.publicBaseUrl;
    const binding: Binding = { id, serviceId, workspaceId: target.service.workspaceId, owner, audience, port: target.service.port!, origin, expiresAt,
      bootstrapUntil: Date.now() + 2 * 60_000, bootstrap: secret, cookieHash: null, sockets: new Set(), check: () => {
        target.check();
        if (audience === "device" && (!this.options.remote().enabled || base !== this.publicBaseUrl)) throw new Error("Remote preview disabled");
        if (audience === "device") this.checkPublicOrigin();
      } };
    this.bindings.set(origin.host, binding);
    return { id, serviceId, workspaceId: binding.workspaceId, url: origin.origin, openUrl: origin.origin + openPath + "#" + secret, expiresAt };
  }
  revoke(serviceId: string, id: string, owner: string) {
    for (const binding of this.bindings.values()) if (binding.id === id && binding.serviceId === serviceId && (owner === "local" || binding.owner === owner)) this.remove(binding);
    return { ok: true as const };
  }
  private check(binding: Binding) {
    if (Date.now() >= binding.expiresAt || (!binding.cookieHash && Date.now() >= binding.bootstrapUntil)) throw new Error("Service preview expired");
    binding.check();
  }
  private remove(binding: Binding) {
    this.bindings.delete(binding.origin.host);
    this.proxy.removeWorkspaceService({ workspaceId: binding.workspaceId, scriptName: binding.id });
    for (const socket of binding.sockets) socket.destroy();
    binding.sockets.clear(); binding.bootstrap = null; binding.cookieHash = null;
  }
  closeRemote() { for (const binding of this.bindings.values()) if (binding.audience === "device") this.remove(binding); }
  close() { clearInterval(this.watch); for (const binding of this.bindings.values()) this.remove(binding); }
  private host(req: IncomingMessage) { return (req.headers.host ?? "").toLowerCase(); }
  private isPreview(req: IncomingMessage) { return /^[a-f0-9]{32}--workbench\./.test(this.host(req)); }
  private binding(req: IncomingMessage, audience: Audience): Binding {
    const binding = this.bindings.get(this.host(req));
    if (!binding || binding.audience !== audience) throw new Error("Service preview expired");
    this.check(binding); return binding;
  }
  private authenticate(req: IncomingMessage, binding: Binding) {
    const cookies = (req.headers.cookie ?? "").split(";").map(value => value.trim());
    const secret = cookies.find(value => value.startsWith(cookieName + "="))?.slice(cookieName.length + 1) ?? "";
    if (!secret || !equal(binding.cookieHash, hash(secret))) throw new Error("Open this service from Workbench again");
    if (req.headers.origin && req.headers.origin !== binding.origin.origin) throw new Error("Preview origin does not match");
    req.headers.cookie = cookies.filter(value => !value.startsWith(cookieName + "=")).join("; ");
    for (const key of Object.keys(req.headers)) if (key === "forwarded" || key.startsWith("x-forwarded-") || key.startsWith("x-workbench-")) delete req.headers[key];
    req.headers.host = binding.origin.host;
    req.headers["x-forwarded-port"] = binding.origin.port || (binding.origin.protocol === "https:" ? "443" : "80");
    Object.defineProperty(req, "protocol", { value: binding.origin.protocol.slice(0, -1), configurable: true });
  }
  private track(binding: Binding, socket: Duplex) {
    if (binding.sockets.has(socket)) return;
    binding.sockets.add(socket); socket.once("close", () => binding.sockets.delete(socket));
  }
  /** Called before Workbench static/API routes. No project script shares the Workbench origin. */
  handle(req: IncomingMessage, res: ServerResponse, audience: Audience): boolean {
    if (!this.isPreview(req)) return false;
    try {
      const binding = this.binding(req, audience);
      res.setHeader("referrer-policy", "no-referrer");
      const path = new URL(req.url ?? "/", binding.origin).pathname;
      if (path === openPath) {
        res.setHeader("cache-control", "no-store");
        res.setHeader("content-security-policy", bootstrapCsp);
        if (req.method === "GET") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>서비스 열기</title><p id="status">서비스 화면을 여는 중…</p><script>' + bootstrapScript + '</script>');
        } else if (req.method === "POST") { void this.bootstrap(req, res, binding); }
        else { res.writeHead(405).end(); }
        return true;
      }
      if (path.startsWith("/__workbench_preview/")) throw new Error("Unknown preview route");
      this.authenticate(req, binding); this.track(binding, req.socket);
      // Project cookies stay host-only and cannot replace the HttpOnly preview grant.
      const writeHead = res.writeHead;
      res.writeHead = ((status: number, ...args: unknown[]) => {
        const index = typeof args[0] === "string" ? 1 : 0, input = args[index];
        if (input && typeof input === "object" && !Array.isArray(input)) {
          const filtered: import("node:http").OutgoingHttpHeaders = { ...input, "referrer-policy": "no-referrer" };
          const cookies = filtered["set-cookie"];
          if (cookies) filtered["set-cookie"] = (Array.isArray(cookies) ? cookies : [String(cookies)]).filter(value => !value.trim().startsWith(cookieName + "=")).map(value => value.replace(/;\s*domain=[^;]*/gi, ""));
          if (typeof filtered.location === "string") try {
            const destination = new URL(filtered.location, binding.origin);
            if (["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname) && Number(destination.port || 80) === binding.port) filtered.location = binding.origin.origin + destination.pathname + destination.search + destination.hash;
          } catch { /* Preserve the project's invalid redirect as received. */ }
          args[index] = filtered;
        }
        return Reflect.apply(writeHead, res, [status, ...args]);
      }) as ServerResponse["writeHead"];
      this.app(req, res);
    } catch (error) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end((error as Error).message); }
    return true;
  }
  private async bootstrap(req: IncomingMessage, res: ServerResponse, binding: Binding) {
    try {
      if (binding.cookieHash) { this.authenticate(req, binding); res.writeHead(204).end(); return; }
      if (req.headers.origin !== binding.origin.origin || !binding.bootstrap || Date.now() >= binding.bootstrapUntil) throw new Error("Open this service from Workbench again");
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const data = Buffer.from(chunk); size += data.length; if (size > 256) throw new Error("Invalid preview ticket"); chunks.push(data); }
      this.check(binding);
      if (!binding.bootstrap || !equal(hash(binding.bootstrap), hash(Buffer.concat(chunks).toString("utf8")))) throw new Error("Invalid preview ticket");
      binding.bootstrap = null;
      const secret = randomBytes(32).toString("base64url"); binding.cookieHash = hash(secret);
      res.setHeader("set-cookie", `${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((binding.expiresAt - Date.now()) / 1000))}${binding.origin.protocol === "https:" ? "; Secure" : ""}`);
      res.writeHead(204).end();
    } catch (error) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end((error as Error).message); }
  }
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, audience: Audience): boolean {
    if (!this.isPreview(req)) return false;
    try {
      const binding = this.binding(req, audience);
      if (req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers.origin !== binding.origin.origin) throw new Error("Invalid service WebSocket");
      this.authenticate(req, binding); this.track(binding, socket);
      this.upgrade(req, socket as Socket, head);
    } catch { socket.destroy(); }
    return true;
  }
}
