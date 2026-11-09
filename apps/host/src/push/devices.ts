import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import webpush from "web-push";
import { createPushNotifications, type PushNotifications, type PushPayload } from "@workbench/paseo-push";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "@workbench/paseo-server-transport/private-files";
import type { DeviceGrant, AttentionEvent, AttentionPayload } from "@workbench/contracts";
import type { PushConfiguration, PushDeviceState, PushOpenResult, PushSettings, PushStatus, PushSubscriptionInput, WebPushSubscription } from "../../../../packages/contracts/src/push.ts";
import type { DeviceRegistry } from "../devices.ts";
import type { Notifications } from "../notifications.ts";
import { OfficeVault } from "../office-vault.ts";
import { HttpError } from "../errors.ts";

type Device = PushDeviceState & { subscription: WebPushSubscription; appUrl: string; keyVersion: number; leaseExpiresAt: number };
type Link = { digest: string; deviceId: string; credentialVersion: number; attentionId: string; expiresAt: number };
type Receipt = { id: string; at: number; status: "pending" | "sent" | "unknown" | "rejected" };
type Saved = { version: 1; config: PushConfiguration; publicKey: string; sealedPrivateKey: string; keyVersion: number; devices: Device[]; links: Link[]; receipts: Receipt[] };
type Options = { dataDir: string; registry: DeviceRegistry; notifications: Notifications; hostId: string };
const leaseMs = 48 * 60 * 60 * 1000, linkMs = 7 * 24 * 60 * 60 * 1000;
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const bad = (message: string) => new HttpError(400, "push_input", message);
const conflict = (message: string) => new HttpError(409, "push_state", message);
const publicDevice = ({ deviceId, enabled, updatedAt, expiresAt, credentialVersion, lastDeliveryAt, lastDelivery, error }: Device): PushDeviceState => ({ deviceId, enabled, updatedAt, expiresAt, credentialVersion, lastDeliveryAt, lastDelivery, error });
function subscription(input: unknown): WebPushSubscription {
  if (!input || typeof input !== "object") throw bad("이 브라우저의 푸시 구독을 선택해 주세요.");
  const value = input as WebPushSubscription;
  let url: URL; try { url = new URL(value.endpoint); } catch { throw bad("푸시 서비스 주소가 올바르지 않습니다."); }
  const supported = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(url.hostname) || url.hostname.endsWith(".notify.windows.com");
  if (!supported || url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash || url.href.length > 4096) throw bad("이 브라우저의 푸시 서비스는 현재 지원하지 않습니다.");
  if (!value.keys || !/^[\w-]{87}$/.test(value.keys.p256dh) || !/^[\w-]{22}$/.test(value.keys.auth)) throw bad("브라우저 구독 키를 다시 등록해 주세요.");
  if (value.expirationTime != null && (!Number.isFinite(value.expirationTime) || value.expirationTime <= Date.now())) throw bad("브라우저 구독이 만료되었습니다.");
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth }, expirationTime: value.expirationTime ?? null };
}
function applicationUrl(input: unknown) {
  if (typeof input !== "string" || input.length > 4096) throw bad("알림을 열 앱 주소가 필요합니다.");
  let url: URL; try { url = new URL(input); } catch { throw bad("앱 주소를 확인해 주세요."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw bad("인증정보 없는 HTTPS 앱 주소가 필요합니다.");
  return url.href;
}

/** Original Paseo leases + standard Web Push encryption. Workbench supplies grant and attention adapters. */
export class PushDevices {
  private readonly options: Options;
  private readonly file: string;
  private readonly vault: OfficeVault;
  private readonly lease: PushNotifications;
  private readonly releases: (() => void)[];
  private saved: Saved = { version: 1, config: { enabled: false, subject: "" }, publicKey: "", sealedPrivateKey: "", keyVersion: 0, devices: [], links: [], receipts: [] };
  private closed = false;
  private changing: Promise<unknown> = Promise.resolve();
  constructor(options: Options) {
    this.options = options; const directory = join(options.dataDir, "web-push"); ensurePrivateDirectory(directory);
    this.file = join(directory, "devices.json"); this.vault = new OfficeVault(options.dataDir);
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
      if (saved.version !== 1 || !Array.isArray(saved.devices) || !Array.isArray(saved.links) || !Array.isArray(saved.receipts)) throw conflict("저장된 푸시 설정을 읽지 못했습니다. 기존 설정은 보존했습니다.");
      this.saved = saved;
      for (const receipt of this.saved.receipts) if (receipt.status === "pending") receipt.status = "unknown";
    }
    this.lease = createPushNotifications({ logger: pino({ level: "silent" }), filePath: join(directory, "leases.json"), deliver: (ids, payload) => this.deliver(ids, payload) });
    this.releases = [options.notifications.subscribeDelivery((row, payload) => this.produce(row, payload)), options.registry.subscribe(event => {
      if (!event.deviceId || !["revoked", "expired", "rotated", "updated"].includes(event.type)) return;
      const grant = options.registry.get(event.deviceId), device = this.saved.devices.find(entry => entry.deviceId === event.deviceId);
      if (device && (!grant || !this.activeGrant(grant, device) || !grant.permissions.includes("read"))) this.revoke(event.deviceId);
    })];
    this.persist();
  }
  private persist() {
    const now = Date.now(); this.saved.links = this.saved.links.filter(link => link.expiresAt > now).slice(-4000);
    this.saved.receipts = this.saved.receipts.filter(row => row.at > now - linkMs).slice(-4000);
    writePrivateFileAtomicSync(this.file, JSON.stringify(this.saved));
  }
  private activeGrant(grant: DeviceGrant, device: Device) { return grant.hostId === this.options.hostId && grant.activatedAt !== null && grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > Date.now()) && grant.credentialVersion === device.credentialVersion; }
  private serial<T>(run: () => Promise<T>) { const change = this.changing.then(run, run); this.changing = change; return change; }
  status(deviceId?: string): PushStatus {
    const device = this.saved.devices.find(entry => entry.deviceId === deviceId);
    return { hostId: this.options.hostId, enabled: this.saved.config.enabled, configured: Boolean(this.saved.publicKey && this.saved.sealedPrivateKey), publicKey: this.saved.publicKey || null, keyVersion: this.saved.keyVersion, leaseHours: 48,
      device: device ? { ...publicDevice(device), enabled: device.enabled && device.expiresAt > Date.now() } : null, verification: "NOT_RUN_DEVICE" };
  }
  settings(): PushSettings { return { ...this.status(), config: { ...this.saved.config }, devices: this.saved.devices.map(device => ({ ...publicDevice(device), enabled: device.enabled && device.expiresAt > Date.now() })) }; }
  configure(input: PushConfiguration) {
    return this.serial(async () => {
      if (!input || typeof input.enabled !== "boolean" || typeof input.subject !== "string" || input.subject.length > 512) throw bad("푸시 설정을 확인해 주세요.");
      const subject = input.subject.trim();
      if (subject && !(/^mailto:[^\s@]+@[^\s@]+$/.test(subject) || /^https:\/\/[^\s]+$/.test(subject))) throw bad("푸시 발송자 연락처를 mailto:이메일 또는 HTTPS 주소로 입력해 주세요.");
      if (input.enabled && !subject) throw bad("푸시 서비스에 전달할 발송자 연락처가 필요합니다.");
      if (input.enabled && !this.saved.sealedPrivateKey) {
        const pair = webpush.generateVAPIDKeys(), sealed = await this.vault.seal(pair.privateKey);
        this.saved.publicKey = pair.publicKey; this.saved.sealedPrivateKey = sealed; this.saved.keyVersion++;
      } else if (input.enabled) await this.vault.open(this.saved.sealedPrivateKey);
      this.saved.config = { enabled: input.enabled, subject }; this.persist(); return this.settings();
    });
  }
  rotate() {
    return this.serial(async () => {
      const pair = webpush.generateVAPIDKeys(), sealed = await this.vault.seal(pair.privateKey);
      for (const device of this.saved.devices) this.lease.revoke(device.deviceId);
      this.saved.publicKey = pair.publicKey; this.saved.sealedPrivateKey = sealed; this.saved.keyVersion++;
      for (const device of this.saved.devices) { device.enabled = false; device.error = "발송 키가 바뀌었습니다. 이 기기에서 알림을 다시 등록해 주세요."; }
      this.saved.links = []; this.persist(); return this.settings();
    });
  }
  revoke(deviceId: string) {
    const device = this.saved.devices.find(entry => entry.deviceId === deviceId);
    this.lease.revoke(deviceId);
    if (device) { device.enabled = false; device.updatedAt = Date.now(); }
    this.saved.links = this.saved.links.filter(link => link.deviceId !== deviceId); this.persist(); return this.settings();
  }
  private register(grant: DeviceGrant, input: PushSubscriptionInput) {
    if (!this.saved.config.enabled || !this.saved.publicKey) throw conflict("이 호스트에서 푸시를 먼저 설정해 주세요.");
    if (!input || input.keyVersion !== this.saved.keyVersion) throw conflict("발송 키가 바뀌었습니다. 브라우저 구독을 새로 등록해 주세요.");
    if (!grant.workIds.length) throw new HttpError(403, "push_scope", "읽을 수 있는 프로젝트가 승인되어야 합니다.");
    const selected = subscription(input.subscription), appUrl = applicationUrl(input.appUrl), now = Date.now();
    const previous = this.saved.devices.find(entry => entry.deviceId === grant.deviceId);
    if (this.saved.devices.length >= 128 && !previous) throw conflict("푸시 기기가 너무 많습니다. 사용하지 않는 기기의 알림을 해제해 주세요.");
    if (this.saved.devices.some(entry => entry.deviceId !== grant.deviceId && entry.enabled && entry.subscription.endpoint === selected.endpoint)) throw conflict("이 브라우저 구독이 다른 기기에 연결되어 있습니다. 이전 기기 알림을 해제해 주세요.");
    const changed = !previous || previous.subscription.endpoint !== selected.endpoint || JSON.stringify(previous.subscription.keys) !== JSON.stringify(selected.keys) || previous.credentialVersion !== grant.credentialVersion;
    // Paseo only extends a lease in its final half. Report that same deadline, including a shorter grant/subscription limit.
    if (changed || !previous?.enabled || !previous.leaseExpiresAt) this.lease.revoke(grant.deviceId);
    const leaseExpiresAt = !changed && previous?.enabled && previous.leaseExpiresAt - now > leaseMs / 2 ? previous.leaseExpiresAt : now + leaseMs;
    const device: Device = { deviceId: grant.deviceId, enabled: true, updatedAt: now, expiresAt: Math.min(leaseExpiresAt, selected.expirationTime ?? Infinity, grant.expiresAt ?? Infinity), credentialVersion: grant.credentialVersion,
      subscription: selected, appUrl, keyVersion: this.saved.keyVersion, leaseExpiresAt, lastDeliveryAt: previous?.lastDeliveryAt ?? null, lastDelivery: previous?.lastDelivery ?? null, error: null };
    this.lease.renew(device.deviceId);
    this.saved.devices = [...this.saved.devices.filter(entry => entry.deviceId !== device.deviceId), device];
    if (changed) this.saved.links = this.saved.links.filter(link => link.deviceId !== device.deviceId);
    this.persist(); return this.status(device.deviceId);
  }
  /** Called only by the protected device gateway. A body-supplied deviceId has no authority. */
  handle(credential: string, method: string, path: string, body: unknown = {}): PushStatus | PushOpenResult {
    const grant = this.options.registry.authorize(credential, "read");
    if (method === "GET" && path === "/api/push") return this.status(grant.deviceId);
    if (method === "PUT" && path === "/api/push/subscription") return this.register(grant, body as PushSubscriptionInput);
    if (method === "DELETE" && path === "/api/push/subscription") { this.revoke(grant.deviceId); return this.status(grant.deviceId); }
    if (method === "POST" && path === "/api/push/links/resolve") {
      const token = (body as { token?: unknown })?.token;
      if (typeof token !== "string" || !/^[\w-]{43}$/.test(token)) throw bad("알림 링크를 확인해 주세요.");
      const link = this.saved.links.find(entry => entry.digest === digest(token));
      if (!link || link.deviceId !== grant.deviceId || link.credentialVersion !== grant.credentialVersion || link.expiresAt <= Date.now()) throw new HttpError(410, "push_link_expired", "알림 링크가 만료되었거나 이 기기의 권한이 바뀌었습니다. 앱의 알림 목록에서 확인해 주세요.");
      const target = this.options.notifications.target(link.attentionId);
      this.options.registry.authorize(credential, "read", target.workId);
      if (target.hostId !== this.options.hostId) throw new HttpError(403, "push_host", "알림의 호스트가 다릅니다.");
      return { attentionId: link.attentionId, target };
    }
    throw new HttpError(404, "push_route", "이 기기에서 사용할 수 없는 푸시 설정입니다.");
  }
  private produce(row: AttentionEvent, payload: AttentionPayload) {
    if (this.closed || !this.saved.config.enabled) return;
    void this.lease.send({ title: payload.title, body: payload.body, data: { attentionId: row.id } }).catch(() => { /* Delivery receipts and generic errors are persisted per device. */ });
  }
  private async deliver(ids: string[], payload: PushPayload) {
    const attentionId = payload.data?.attentionId;
    if (typeof attentionId !== "string" || !/^[a-f0-9]{64}$/.test(attentionId) || this.closed || !this.saved.config.enabled) return;
    for (const deviceId of ids) {
      const device = this.saved.devices.find(entry => entry.deviceId === deviceId), grant = this.options.registry.get(deviceId);
      if (!device?.enabled || !grant || !this.activeGrant(grant, device) || device.expiresAt <= Date.now() || device.keyVersion !== this.saved.keyVersion || !grant.permissions.includes("read")) continue;
      let workId: string; try { if (!this.options.notifications.deliverable(attentionId)) continue; workId = this.options.notifications.target(attentionId).workId; } catch { continue; }
      if (!grant.workIds.includes(workId)) continue;
      const receiptId = `${deviceId}:${grant.credentialVersion}:${attentionId}`;
      if (this.saved.receipts.some(entry => entry.id === receiptId)) continue;
      const receipt: Receipt = { id: receiptId, at: Date.now(), status: "pending" };
      this.saved.receipts.push(receipt); this.persist(); // Never repeat an uncertain network submission.
      try {
        const privateKey = await this.vault.open(this.saved.sealedPrivateKey), latest = this.options.registry.get(deviceId);
        if (this.closed || !this.saved.config.enabled || !device.enabled || !latest || !this.activeGrant(latest, device) || !latest.permissions.includes("read") || !latest.workIds.includes(workId) || !this.options.notifications.deliverable(attentionId)) { receipt.status = "rejected"; this.persist(); continue; }
        const token = randomBytes(32).toString("base64url"), link = new URL(device.appUrl);
        link.hash = new URLSearchParams({ pushHost: this.options.hostId, pushLink: token }).toString();
        this.saved.links.push({ digest: digest(token), deviceId, credentialVersion: latest.credentialVersion, attentionId, expiresAt: Date.now() + linkMs }); this.persist();
        await webpush.sendNotification(device.subscription, JSON.stringify({ type: "workbench.attention", title: "Achmage Workbench", body: payload.body, link: link.href }), {
          vapidDetails: { subject: this.saved.config.subject, publicKey: this.saved.publicKey, privateKey }, TTL: 86400, timeout: 10000, contentEncoding: "aes128gcm", urgency: "normal", topic: digest(receiptId).slice(0, 32),
        });
        receipt.status = "sent"; device.lastDelivery = "sent"; device.error = null;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        receipt.status = status && status >= 400 && status < 500 ? "rejected" : "unknown";
        device.lastDelivery = receipt.status;
        device.error = status === 404 || status === 410 ? "브라우저 구독이 만료되었습니다. 알림을 다시 등록해 주세요." : "푸시 요청 결과를 확인하지 못했습니다. 설정과 보안 저장소를 확인해 주세요. 자동 재전송하지 않았습니다.";
        if (status === 404 || status === 410) { device.enabled = false; this.lease.revoke(deviceId); }
      }
      device.lastDeliveryAt = Date.now(); this.persist();
    }
  }
  close() { this.closed = true; for (const release of this.releases) release(); this.vault.close(); }
}
