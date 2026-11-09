import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensurePrivateDirectory, ensurePrivateFile, writePrivateFileAtomicSync,
} from "@workbench/paseo-server-transport/private-files";
import {
  DEVICE_PERMISSIONS,
  type DeviceApproval, type DeviceCredential, type DeviceErrorCode, type DeviceGrant,
  type DevicePermission, type DeviceRegistryEvent, type PairingCredentialClaim,
  type PairingCredentialResult, type PairingOffer, type PairingRequest,
  type PairingRequestInput, type PairingRequestTicket,
} from "@workbench/contracts";

const DEFAULT_OFFER_TTL = 5 * 60_000;
const MAX_OFFER_TTL = 10 * 60_000;
const DEFAULT_GRANT_TTL = 30 * 24 * 60 * 60_000;
const MAX_DEVICES = 1024;
const MAX_PENDING = 64;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
type StoredDevice = { grant: DeviceGrant; credentialHash: string | null };
type StoredOffer = { offerId: string; tokenHash: string; createdAt: number; expiresAt: number; consumedAt: number | null };
type StoredRequest = PairingRequest & { claimHash: string | null; connectionHash: string; claimedAt: number | null };
type RegistryState = { version: 1; hostId: string; devices: StoredDevice[]; offers: StoredOffer[]; requests: StoredRequest[] };

export class DeviceRegistryError extends Error {
  readonly code: DeviceErrorCode;
  readonly status: number;
  constructor(code: DeviceErrorCode, status: number, message: string) {
    super(message);
    this.name = "DeviceRegistryError";
    this.code = code;
    this.status = status;
  }
}
function fail(code: DeviceErrorCode, status: number, message: string): never {
  throw new DeviceRegistryError(code, status, message);
}
function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    return fail("invalid_input", 400, `${field} 값이 올바르지 않습니다.`);
  }
  return value.trim();
}
function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nullableEpoch(value: unknown): value is number | null {
  return value === null || epoch(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid device registry record");
  return value as Record<string, unknown>;
}
function permission(value: unknown): value is DevicePermission {
  return typeof value === "string" && (DEVICE_PERMISSIONS as readonly string[]).includes(value);
}
function scopes(input: DeviceApproval, now: number, prior?: DeviceGrant): Pick<DeviceGrant, "permissions" | "workIds" | "expiresAt"> {
  if (!input || !Array.isArray(input.permissions) || input.permissions.length > DEVICE_PERMISSIONS.length || !input.permissions.every(permission)) {
    return fail("invalid_input", 400, "기기 권한 목록이 올바르지 않습니다.");
  }
  if (!Array.isArray(input.workIds) || input.workIds.length > 256) {
    return fail("invalid_input", 400, "프로젝트 범위가 올바르지 않습니다.");
  }
  const workIds = input.workIds.map((id) => text(id, "프로젝트", 256));
  if (workIds.some((id) => id.includes("*"))) fail("invalid_input", 400, "프로젝트는 개별 ID로 승인해야 합니다.");
  const expiresAt = input.expiresAt === undefined ? (prior ? prior.expiresAt : now + DEFAULT_GRANT_TTL) : input.expiresAt;
  if (!nullableEpoch(expiresAt) || (expiresAt !== null && expiresAt <= now)) {
    return fail("invalid_input", 400, "기기 만료 시각은 현재 이후여야 합니다.");
  }
  return { permissions: [...new Set(input.permissions)], workIds: [...new Set(workIds)], expiresAt };
}

/** The host instance lock owns this registry. All writes commit before authority changes.
 * Paseo owns private-file persistence and protected transport; this adapter owns Workbench grants.
 */
export class DeviceRegistry {
  readonly hostId: string;
  private readonly directory: string;
  private readonly file: string;
  private readonly now: () => number;
  private state: RegistryState;
  private readonly listeners = new Set<(event: DeviceRegistryEvent) => void>();
  private readonly expiredNotified = new Set<string>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(dataDir: string, hostId: string, options: { now?: () => number } = {}) {
    this.hostId = text(hostId, "호스트", 256);
    this.directory = join(dataDir, "devices");
    this.file = join(this.directory, "registry.json");
    this.now = options.now ?? Date.now;
    this.checkPath(this.directory, true, false);
    ensurePrivateDirectory(this.directory);
    this.checkPath(this.directory, true, true);
    this.checkPath(this.file, false, false);
    if (existsSync(this.file)) {
      ensurePrivateFile(this.file);
      this.checkPath(this.file, false, true);
      try { this.state = this.readState(JSON.parse(readFileSync(this.file, "utf8"))); }
      catch { throw new DeviceRegistryError("registry_unavailable", 500, "기기 등록 파일이 손상되었거나 다른 호스트 소유입니다. 원본 파일을 보존했습니다."); }
    } else {
      this.state = { version: 1, hostId: this.hostId, devices: [], offers: [], requests: [] };
      writePrivateFileAtomicSync(this.file, JSON.stringify(this.state) + "\n");
      this.checkPath(this.file, false, true);
    }
    this.scheduleExpiry();
  }

  list(): DeviceGrant[] {
    return this.state.devices.map((entry) => structuredClone(entry.grant)).sort((a, b) => b.approvedAt - a.approvedAt);
  }
  get(deviceId: string): DeviceGrant | null {
    const grant = this.state.devices.find((entry) => entry.grant.deviceId === deviceId)?.grant;
    return grant ? structuredClone(grant) : null;
  }
  listPending(): PairingRequest[] {
    const now = this.now();
    return this.state.requests.filter((request) => request.status === "pending" && request.expiresAt > now)
      .map((request) => this.publicRequest(request)).sort((a, b) => a.createdAt - b.createdAt);
  }
  subscribe(listener: (event: DeviceRegistryEvent) => void): () => void {
    this.requireOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  createOffer(input: { ttlMs?: number } = {}): PairingOffer {
    this.requireOpen();
    const ttlMs = input.ttlMs ?? DEFAULT_OFFER_TTL;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_OFFER_TTL) {
      fail("invalid_input", 400, "연결 제안의 유효시간은 1초에서 10분 사이여야 합니다.");
    }
    const now = this.now(), next = this.copyPruned(now);
    if (next.offers.filter((offer) => offer.consumedAt === null).length >= MAX_PENDING) {
      fail("registry_limit", 429, "사용하지 않은 연결 제안이 너무 많습니다.");
    }
    const offer: PairingOffer = { offerId: randomUUID(), hostId: this.hostId, token: this.secret(), createdAt: now, expiresAt: now + ttlMs };
    next.offers.push({ offerId: offer.offerId, tokenHash: this.digest("offer", offer.token), createdAt: now, expiresAt: offer.expiresAt, consumedAt: null });
    this.commit(next);
    return offer;
  }

  revokeOffer(offerId: string): void {
    this.requireOpen();
    const next = structuredClone(this.state);
    const offer = next.offers.find((entry) => entry.offerId === offerId);
    if (!offer) fail("invalid_offer", 404, "연결 제안을 찾을 수 없습니다.");
    offer.consumedAt ??= this.now();
    this.commit(next);
  }

  requestPairing(input: PairingRequestInput): PairingRequestTicket {
    this.requireOpen();
    const name = text(input.name, "기기 이름", 100);
    const platform = input.platform === undefined ? null : text(input.platform, "기기 종류", 100);
    const connection = this.connection(input.connectionId);
    const now = this.now();
    const offer = this.state.offers.find((entry) => entry.offerId === input.offerId);
    if (!offer || !this.matches(offer.tokenHash, "offer", input.token)) fail("invalid_offer", 401, "연결 제안이 올바르지 않습니다.");
    if (offer.expiresAt <= now) fail("offer_expired", 410, "연결 제안이 만료되었습니다.");
    if (offer.consumedAt !== null) fail("offer_used", 409, "이미 사용한 연결 제안입니다.");
    const next = this.copyPruned(now);
    if (next.requests.filter((request) => request.status === "pending").length >= MAX_PENDING) {
      fail("registry_limit", 429, "승인 대기 중인 기기가 너무 많습니다.");
    }
    next.offers.find((entry) => entry.offerId === offer.offerId)!.consumedAt = now;
    const claimToken = this.secret();
    const request: StoredRequest = {
      requestId: randomUUID(), hostId: this.hostId, name, platform,
      verificationCode: String(randomInt(1_000_000)).padStart(6, "0"),
      createdAt: now, expiresAt: offer.expiresAt, status: "pending", deviceId: null,
      claimHash: this.digest("claim", claimToken), connectionHash: this.digest("connection", connection), claimedAt: null,
    };
    next.requests.push(request);
    this.commit(next);
    this.emit({ type: "requested", requestId: request.requestId });
    return { requestId: request.requestId, hostId: this.hostId, claimToken, verificationCode: request.verificationCode, expiresAt: request.expiresAt };
  }

  approve(requestId: string, input: DeviceApproval): DeviceGrant {
    this.requireOpen();
    const now = this.now(), next = structuredClone(this.state);
    const request = this.pending(next, requestId, now);
    const approvedScopes = scopes(input, now);
    if (next.devices.length >= MAX_DEVICES) fail("registry_limit", 429, "등록 가능한 기기 수를 초과했습니다.");
    const grant: DeviceGrant = {
      deviceId: randomUUID(), hostId: this.hostId, name: request.name, platform: request.platform,
      ...approvedScopes, createdAt: request.createdAt, approvedAt: now, activatedAt: null,
      revokedAt: null, credentialVersion: 1, lastRotatedAt: null,
    };
    request.status = "approved";
    request.deviceId = grant.deviceId;
    next.devices.push({ grant, credentialHash: null });
    this.commit(next);
    this.emit({ type: "approved", requestId, deviceId: grant.deviceId });
    return structuredClone(grant);
  }

  reject(requestId: string): void {
    this.requireOpen();
    const next = structuredClone(this.state), request = this.pending(next, requestId, this.now());
    request.status = "rejected";
    request.claimHash = null;
    this.commit(next);
    this.emit({ type: "rejected", requestId });
  }

  claimCredential(input: PairingCredentialClaim): PairingCredentialResult {
    this.requireOpen();
    const now = this.now();
    const request = this.state.requests.find((entry) => entry.requestId === input.requestId);
    if (!request) fail("invalid_claim", 401, "이 연결의 기기 등록 요청을 확인할 수 없습니다.");
    if (request.claimedAt !== null) fail("pairing_used", 409, "기기 자격증명이 이미 전달되었습니다.");
    if (request.expiresAt <= now) fail("pairing_expired", 410, "기기 등록 요청이 만료되었습니다.");
    if (request.status === "rejected") fail("pairing_rejected", 403, "기기 등록이 거절되었습니다.");
    if (!request.claimHash || !this.matches(request.claimHash, "claim", input.claimToken)
      || !this.matches(request.connectionHash, "connection", this.connection(input.connectionId))) {
      fail("invalid_claim", 401, "이 연결의 기기 등록 요청을 확인할 수 없습니다.");
    }
    if (request.status === "pending") return { status: "pending", requestId: request.requestId, expiresAt: request.expiresAt };
    const next = structuredClone(this.state);
    const stored = next.devices.find((entry) => entry.grant.deviceId === request.deviceId);
    if (!stored || stored.grant.revokedAt !== null || (stored.grant.expiresAt !== null && stored.grant.expiresAt <= now)) {
      fail("invalid_claim", 403, "기기 승인이 더 이상 유효하지 않습니다.");
    }
    const credential = this.newCredential(stored.grant);
    stored.credentialHash = this.digest("credential", credential);
    stored.grant.activatedAt = now;
    const claimed = next.requests.find((entry) => entry.requestId === request.requestId)!;
    claimed.claimedAt = now;
    claimed.claimHash = null;
    this.commit(next);
    this.emit({ type: "updated", deviceId: stored.grant.deviceId });
    return { status: "approved", grant: structuredClone(stored.grant), credential };
  }

  /** A read without a workId returns scopes for filtering; it does not authorize every work. */
  authorize(credential: string, required: DevicePermission, workId?: string): DeviceGrant {
    if (!permission(required)) fail("invalid_input", 400, "알 수 없는 기기 권한입니다.");
    const grant = this.authenticate(credential);
    if (!grant) fail("invalid_credential", 401, "기기 자격증명이 만료되었거나 철회되었습니다.");
    if (!grant.permissions.includes(required)) fail("permission_denied", 403, "이 기기에 해당 권한이 없습니다.");
    if (workId === undefined && required !== "read") fail("work_scope_required", 403, "명령을 실행할 프로젝트 범위가 필요합니다.");
    if (workId !== undefined && !grant.workIds.includes(workId)) fail("work_scope_denied", 403, "승인하지 않은 프로젝트입니다.");
    return grant;
  }

  authenticate(credential: string): DeviceGrant | null {
    if (this.closed || typeof credential !== "string" || credential.length > 256) return null;
    const match = /^wbd\.([a-f0-9-]{36})\.([1-9][0-9]{0,9})\.([A-Za-z0-9_-]{43})$/.exec(credential);
    if (!match) return null;
    this.notifyExpired();
    const stored = this.state.devices.find((entry) => entry.grant.deviceId === match[1]);
    if (!stored || stored.grant.revokedAt !== null || stored.grant.activatedAt === null
      || stored.grant.credentialVersion !== Number(match[2])
      || (stored.grant.expiresAt !== null && stored.grant.expiresAt <= this.now())
      || !stored.credentialHash || !this.matches(stored.credentialHash, "credential", credential)) return null;
    return structuredClone(stored.grant);
  }

  update(deviceId: string, input: DeviceApproval): DeviceGrant {
    this.requireOpen();
    const now = this.now(), next = structuredClone(this.state), stored = this.device(next, deviceId);
    this.requireActiveGrant(stored.grant, now);
    Object.assign(stored.grant, scopes(input, now, stored.grant));
    this.commit(next);
    this.emit({ type: "updated", deviceId });
    return structuredClone(stored.grant);
  }

  revoke(deviceId: string): DeviceGrant {
    this.requireOpen();
    const next = structuredClone(this.state), stored = this.device(next, deviceId);
    if (stored.grant.revokedAt !== null) return structuredClone(stored.grant);
    stored.grant.revokedAt = this.now();
    stored.credentialHash = null;
    for (const request of next.requests) if (request.deviceId === deviceId) request.claimHash = null;
    this.commit(next);
    this.emit({ type: "revoked", deviceId });
    return structuredClone(stored.grant);
  }

  /** Only the authenticated device receives its replacement; local UI uses revoke + a new offer. */
  rotate(credential: string): DeviceCredential {
    this.requireOpen();
    const grant = this.authenticate(credential);
    if (!grant) fail("invalid_credential", 401, "기기 자격증명이 만료되었거나 철회되었습니다.");
    const next = structuredClone(this.state), stored = this.device(next, grant.deviceId);
    stored.grant.credentialVersion += 1;
    stored.grant.lastRotatedAt = this.now();
    const replacement = this.newCredential(stored.grant);
    stored.credentialHash = this.digest("credential", replacement);
    this.commit(next);
    this.emit({ type: "rotated", deviceId: grant.deviceId });
    return { grant: structuredClone(stored.grant), credential: replacement };
  }

  close(): void {
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.listeners.clear();
  }

  private publicRequest(request: StoredRequest): PairingRequest {
    const { requestId, hostId, name, platform, verificationCode, createdAt, expiresAt, status, deviceId } = request;
    return { requestId, hostId, name, platform, verificationCode, createdAt, expiresAt, status, deviceId };
  }
  private pending(state: RegistryState, requestId: string, now: number): StoredRequest {
    const request = state.requests.find((entry) => entry.requestId === requestId);
    if (!request) fail("invalid_claim", 404, "기기 등록 요청을 찾을 수 없습니다.");
    if (request.expiresAt <= now) fail("pairing_expired", 410, "기기 등록 요청이 만료되었습니다.");
    if (request.status !== "pending") fail("pairing_not_pending", 409, "이미 처리한 기기 등록 요청입니다.");
    return request;
  }
  private device(state: RegistryState, deviceId: string): StoredDevice {
    const stored = state.devices.find((entry) => entry.grant.deviceId === deviceId);
    if (!stored) fail("device_not_found", 404, "등록한 기기를 찾을 수 없습니다.");
    return stored;
  }
  private requireActiveGrant(grant: DeviceGrant, now: number): void {
    if (grant.revokedAt !== null) fail("device_revoked", 403, "철회한 기기입니다. 다시 등록해 주세요.");
    if (grant.expiresAt !== null && grant.expiresAt <= now) fail("device_expired", 410, "만료된 기기입니다. 다시 등록해 주세요.");
  }
  private requireOpen(): void {
    if (this.closed) fail("registry_unavailable", 503, "기기 등록 서비스가 종료되었습니다.");
  }
  private secret(): string { return randomBytes(32).toString("base64url"); }
  private newCredential(grant: DeviceGrant): string { return `wbd.${grant.deviceId}.${grant.credentialVersion}.${this.secret()}`; }
  private digest(purpose: string, value: string): string {
    return createHash("sha256").update(`workbench-device\0${this.hostId}\0${purpose}\0${value}`).digest("hex");
  }
  private matches(expected: string, purpose: string, value: unknown): boolean {
    if (typeof value !== "string" || value.length < 16 || value.length > 512 || !HEX_DIGEST.test(expected)) return false;
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(this.digest(purpose, value), "hex"));
  }
  private connection(value: unknown): string {
    if (typeof value !== "string" || value.length < 16 || value.length > 256) fail("invalid_input", 400, "보호된 연결 식별자가 필요합니다.");
    return value;
  }
  private copyPruned(now: number): RegistryState {
    const next = structuredClone(this.state);
    next.offers = next.offers.filter((offer) => offer.expiresAt > now && offer.consumedAt === null);
    next.requests = next.requests.filter((request) => request.expiresAt > now && request.status !== "rejected" && request.claimedAt === null);
    return next;
  }
  private commit(next: RegistryState): void {
    this.checkPath(this.directory, true, true);
    this.checkPath(this.file, false, true);
    writePrivateFileAtomicSync(this.file, JSON.stringify(next) + "\n");
    this.checkPath(this.file, false, true);
    this.state = next;
    this.scheduleExpiry();
  }
  private checkPath(path: string, directory: boolean, privateMode: boolean): void {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (!privateMode && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (privateMode && process.platform !== "win32" && (stat.mode & 0o777) !== (directory ? 0o700 : 0o600))) {
      fail("registry_unavailable", 500, "기기 등록 저장소는 호스트 소유의 비공개 일반 파일이어야 합니다.");
    }
  }
  private emit(event: DeviceRegistryEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* A notification cannot roll back committed authority. */ }
    }
  }
  private notifyExpired(): void {
    const now = this.now();
    for (const { grant, credentialHash } of this.state.devices) {
      const key = `device:${grant.deviceId}:${grant.expiresAt}`;
      if (credentialHash && grant.revokedAt === null && grant.expiresAt !== null && grant.expiresAt <= now && !this.expiredNotified.has(key)) {
        this.expiredNotified.add(key);
        this.emit({ type: "expired", deviceId: grant.deviceId });
      }
    }
    for (const request of this.state.requests) {
      const key = `request:${request.requestId}`;
      if (request.claimedAt === null && request.status !== "rejected" && request.expiresAt <= now && !this.expiredNotified.has(key)) {
        this.expiredNotified.add(key);
        this.emit({ type: "expired", requestId: request.requestId });
      }
    }
  }
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.closed) return;
    const now = this.now();
    const deadlines = [
      ...this.state.devices.filter((entry) => entry.credentialHash && entry.grant.revokedAt === null)
        .map((entry) => entry.grant.expiresAt),
      ...this.state.requests.filter((request) => request.claimedAt === null && request.status !== "rejected").map((request) => request.expiresAt),
    ].filter((deadline): deadline is number => deadline !== null && deadline > now);
    if (!deadlines.length) return;
    this.expiryTimer = setTimeout(() => { this.notifyExpired(); this.scheduleExpiry(); }, Math.min(Math.min(...deadlines) - now, 2_147_483_647));
    this.expiryTimer.unref();
  }

  private readState(value: unknown): RegistryState {
    const raw = record(value);
    if (raw.version !== 1 || raw.hostId !== this.hostId || !Array.isArray(raw.devices)
      || !Array.isArray(raw.offers) || !Array.isArray(raw.requests)
      || raw.devices.length > MAX_DEVICES || raw.offers.length > MAX_PENDING * 2 || raw.requests.length > MAX_DEVICES + MAX_PENDING) throw Error("Invalid registry");
    const devices = raw.devices.map((value): StoredDevice => {
      const row = record(value), item = record(row.grant);
      if (item.hostId !== this.hostId || typeof item.deviceId !== "string" || typeof item.name !== "string"
        || (item.platform !== null && typeof item.platform !== "string") || !Array.isArray(item.permissions)
        || !item.permissions.every(permission) || !Array.isArray(item.workIds)
        || !item.workIds.every((id) => typeof id === "string" && id.length > 0 && !id.includes("*"))
        || !epoch(item.createdAt) || !epoch(item.approvedAt) || !nullableEpoch(item.activatedAt)
        || !nullableEpoch(item.expiresAt) || !nullableEpoch(item.revokedAt) || !nullableEpoch(item.lastRotatedAt)
        || typeof item.credentialVersion !== "number" || !Number.isSafeInteger(item.credentialVersion) || item.credentialVersion < 1
        || (row.credentialHash !== null && (typeof row.credentialHash !== "string" || !HEX_DIGEST.test(row.credentialHash)))) throw Error("Invalid grant");
      const grant: DeviceGrant = {
        deviceId: item.deviceId, hostId: this.hostId, name: item.name, platform: item.platform,
        permissions: item.permissions, workIds: item.workIds, createdAt: item.createdAt, approvedAt: item.approvedAt,
        activatedAt: item.activatedAt, expiresAt: item.expiresAt, revokedAt: item.revokedAt,
        credentialVersion: item.credentialVersion, lastRotatedAt: item.lastRotatedAt,
      };
      return { grant, credentialHash: row.credentialHash as string | null };
    });
    const offers = raw.offers.map((value): StoredOffer => {
      const item = record(value);
      if (typeof item.offerId !== "string" || typeof item.tokenHash !== "string" || !HEX_DIGEST.test(item.tokenHash)
        || !epoch(item.createdAt) || !epoch(item.expiresAt) || !nullableEpoch(item.consumedAt)) throw Error("Invalid offer");
      return { offerId: item.offerId, tokenHash: item.tokenHash, createdAt: item.createdAt, expiresAt: item.expiresAt, consumedAt: item.consumedAt };
    });
    const requests = raw.requests.map((value): StoredRequest => {
      const item = record(value);
      if (item.hostId !== this.hostId || typeof item.requestId !== "string" || typeof item.name !== "string"
        || (item.platform !== null && typeof item.platform !== "string") || typeof item.verificationCode !== "string"
        || !/^[0-9]{6}$/.test(item.verificationCode) || !epoch(item.createdAt) || !epoch(item.expiresAt)
        || !["pending", "approved", "rejected"].includes(String(item.status))
        || (item.deviceId !== null && typeof item.deviceId !== "string")
        || (item.claimHash !== null && (typeof item.claimHash !== "string" || !HEX_DIGEST.test(item.claimHash)))
        || typeof item.connectionHash !== "string" || !HEX_DIGEST.test(item.connectionHash) || !nullableEpoch(item.claimedAt)) throw Error("Invalid pairing request");
      return {
        requestId: item.requestId, hostId: this.hostId, name: item.name, platform: item.platform,
        verificationCode: item.verificationCode, createdAt: item.createdAt, expiresAt: item.expiresAt,
        status: item.status as PairingRequest["status"], deviceId: item.deviceId,
        claimHash: item.claimHash as string | null, connectionHash: item.connectionHash, claimedAt: item.claimedAt,
      };
    });
    if (new Set(devices.map((entry) => entry.grant.deviceId)).size !== devices.length
      || new Set(offers.map((entry) => entry.offerId)).size !== offers.length
      || new Set(requests.map((entry) => entry.requestId)).size !== requests.length
      || requests.some((request) => request.deviceId !== null && !devices.some((entry) => entry.grant.deviceId === request.deviceId))) throw Error("Conflicting registry identity");
    return { version: 1, hostId: this.hostId, devices, offers, requests };
  }
}
