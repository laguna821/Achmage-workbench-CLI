import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { HttpError } from "./errors.ts";
import { gatewayOnly, gatewayTicket } from "./gateway-env.ts";

export const OFFICE_SEALED_PREFIX = "sealed:v1:workbench:";
export type OfficeVaultKey = { id: string; key: Buffer };
export type OfficeVaultLoader = (create: boolean) => Promise<OfficeVaultKey | null>;
export type OfficeVaultCodec = { seal(plain: string): string; open(sealed: string): string };
const unavailable = () => new HttpError(503, "office_vault_unavailable", "운영체제의 보안 저장소를 사용할 수 없습니다. 저장소 잠금을 해제한 뒤 다시 시도해 주세요. 키를 평문으로 저장하지 않았습니다.");
const legacy = () => new HttpError(409, "office_legacy_secret", "이전 Electron 앱에서 봉인한 키입니다. 기존 값은 보존했으며 키를 다시 입력하거나 이행 절차를 사용해야 합니다.");

/**
 * What else the same master key seals, besides Office AI keys: the messenger channel's tokens and
 * the credential store. The purpose is part of the envelope and of what the seal authenticates, so
 * a value sealed for one use does not open as another (nor as an Office key, nor the reverse).
 */
export type VaultPurpose = "channel" | "cred";
const label = (entry: OfficeVaultKey, purpose?: VaultPurpose) => `${OFFICE_SEALED_PREFIX}${entry.id}${purpose ? `:${purpose}` : ""}`;
/** What the seal authenticates: the envelope's label, and where the value belongs (`bind`, never written into the envelope). */
const aad = (entry: OfficeVaultKey, purpose?: VaultPurpose, bind?: string) => Buffer.from(`${label(entry, purpose)}${bind ? `\n${bind}` : ""}`);

function sealOfficeSecret(plain: string, entry: OfficeVaultKey, purpose?: VaultPurpose, bind?: string) {
  // An Office key that is already sealed stays as it is. For another purpose every value is sealed,
  // whatever it looks like (a person's secret may begin with any text).
  if (!plain || (!purpose && plain.startsWith("sealed:v1:"))) return plain;
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", entry.key, nonce);
  cipher.setAAD(aad(entry, purpose, bind));
  const bytes = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${label(entry, purpose)}:${nonce.toString("base64url")}.${bytes.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

/** The same codec serves the gateway and the original CLI's synchronous reveal contract. */
export function openOfficeSecret(sealed: string, entry: OfficeVaultKey | null, purpose?: VaultPurpose, bind?: string) {
  if (!sealed.startsWith(OFFICE_SEALED_PREFIX)) throw legacy();
  const match = (purpose
    ? new RegExp(`^([a-f0-9]{32}):${purpose}:([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$`)
    : /^([a-f0-9]{32}):([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/).exec(sealed.slice(OFFICE_SEALED_PREFIX.length));
  if (!match || sealed.length > 200_000) throw new HttpError(422, "office_secret_invalid", "보관된 키의 형식이 올바르지 않습니다. 기존 값은 변경하지 않았습니다.");
  if (!entry || entry.id !== match[1]) throw unavailable();
  try {
    const nonce = Buffer.from(match[2]!, "base64url"), body = Buffer.from(match[3]!, "base64url"), tag = Buffer.from(match[4]!, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", entry.key, nonce);
    decipher.setAAD(aad(entry, purpose, bind)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch { throw new HttpError(422, "office_secret_invalid", "보관된 키를 확인하지 못했습니다. 기존 값은 변경하지 않았습니다."); }
}

/**
 * Why the vault helper refused this gateway (sec-vault round 2, review I3): the codes the helper
 * answers with, each with what the person can do. Never a secret, a path or a pid.
 */
export const VAULT_REFUSALS: Record<string, string> = {
  gateway_not_registered: "이 Workbench 실행이 운영체제 키링에 등록되지 않았습니다(시작할 때 키링이 잠겨 있었거나 등록 항목이 지워졌습니다). 키링 잠금을 푼 뒤 ‘다시 시도’를 누르세요. 그래도 안 되면 앱을 완전히 종료한 뒤 다시 여세요.",
  caller_not_gateway: "운영체제 키링에 등록된 Workbench가 이 Workbench와 다릅니다(같은 데이터 폴더로 다른 Workbench가 실행 중이거나 다른 프로그램이 등록을 바꿨습니다). 앱을 완전히 종료한 뒤 다시 여세요. 계속되면 컴퓨터를 다시 시작해 주세요.",
  vault_unavailable: "운영체제의 비밀번호 저장소(키링)를 열 수 없습니다. 키링 잠금을 푼 뒤 ‘다시 시도’를 누르세요.",
  vault_key_missing: "보관함의 열쇠가 운영체제 키링에 없습니다(지워졌거나 다른 컴퓨터의 데이터 폴더입니다). 저장했던 값(메신저 토큰, 비밀 보관함 항목, 이음오피스 AI 키)은 다시 넣어야 합니다.",
  vault_folder_mismatch: "이 데이터 폴더는 보관함 열쇠가 묶인 폴더가 아닙니다(폴더를 옮겼거나 복사했습니다). 원래 폴더로 앱을 열거나, 저장했던 값을 다시 넣어 주세요.",
  vault_folder_unbound: "보관함 열쇠가 이 데이터 폴더에 묶여 있지 않습니다. 기본 데이터 폴더로 앱을 연 뒤 다시 시도해 주세요.",
  // Not a helper code: this gateway holds no ticket (check F3) — '다시 시도' cannot help it.
  gateway_without_launcher: "이 Workbench가 앱을 거치지 않고 시작되어(오래된 로그인 항목이거나 앱 실행 파일을 찾지 못했습니다) 비밀 보관함을 열어 주지 않습니다. 트레이의 ‘작업까지 모두 종료’로 끈 뒤 앱을 다시 여세요. ‘컴퓨터를 켜면 자동으로 시작’을 쓰고 있다면 설정에서 껐다가 다시 켜 로그인 항목을 다시 등록하세요.",
};
const refusalText = (code: string) => VAULT_REFUSALS[code] ?? VAULT_REFUSALS.vault_unavailable!;
/** The helper's answer was a refusal: carries the helper's code (one of `VAULT_REFUSALS`). */
export class VaultRefused extends HttpError {
  readonly reason: string;
  constructor(reason: string) { super(503, "office_vault_unavailable", `비밀 보관함을 열지 못했습니다. ${refusalText(reason)} 키를 평문으로 저장하지 않았습니다.`); this.reason = VAULT_REFUSALS[reason] ? reason : "vault_unavailable"; }
}

/**
 * This gateway's vault, as the helper answered it: `open` (answered), `refused` (with the code), or
 * `unknown` before the first answer. One per gateway process (every OfficeVault shares the helper).
 */
export type VaultState = { state: "unknown" | "open" | "refused"; reason: string | null; message: string | null };
let vaultState: VaultState = { state: "unknown", reason: null, message: null };
const stateListeners = new Set<(state: VaultState) => void>();
export function vaultStatus(): VaultState { return vaultState; }
export function onVaultStatus(listener: (state: VaultState) => void) { stateListeners.add(listener); return () => stateListeners.delete(listener); }
function setVaultState(next: VaultState) {
  const changed = next.state !== vaultState.state || next.reason !== vaultState.reason;
  vaultState = next;
  if (changed) for (const listener of stateListeners) listener(next);
}
/** Refusals that the next call cannot change by itself: further calls fail at once until `retryVault`. */
const STANDING = new Set(["gateway_not_registered", "caller_not_gateway", "vault_folder_mismatch", "vault_folder_unbound", "gateway_without_launcher"]);
/** Set once this gateway wrote the key back where earlier builds look (the way back): later calls leave it there. */
let legacyKept = false;

type HelperRequest = { create: boolean; restore_legacy?: boolean };
async function askHelper(binary: string | undefined, dataDir: string, request: HelperRequest): Promise<Record<string, unknown>> {
  const ticket = gatewayTicket();
  // Started without the app's binary (no ticket): the helper cannot answer this gateway — say that,
  // not "unlock the keyring" (check F3).
  if (!binary) throw ticket ? unavailable() : new VaultRefused("gateway_without_launcher");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ["--office-secret-key"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let stdout = "", ended = false;
    const fail = () => { if (!ended) { ended = true; clearTimeout(timer); child.kill(); reject(unavailable()); } };
    const timer = setTimeout(fail, 15_000);
    child.once("error", fail); child.stdin.once("error", fail);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 4_096) fail(); });
    child.once("close", () => { clearTimeout(timer); if (ended) return; ended = true; resolve(stdout); });
    // The ticket goes only here: the helper's stdin.
    child.stdin.end(JSON.stringify({ directory: dataDir, ...request, ...(ticket ? { ticket } : {}), ...(legacyKept ? { keep_legacy: true } : {}) }));
  });
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(output); } catch { throw unavailable(); }
  if (!parsed || typeof parsed !== "object") throw unavailable();
  if (parsed.ok !== true) throw new VaultRefused(!ticket ? "gateway_without_launcher" : typeof parsed.error === "string" ? parsed.error : "vault_unavailable");
  return parsed;
}

/** One bounded request to our own Rust executable; no keys in arguments, environment or logs. */
export function nativeOfficeVault(dataDir: string, binary = gatewayOnly("WORKBENCH_SECRET_BIN")): OfficeVaultLoader {
  return async (create) => {
    const parsed = await askHelper(binary, dataDir, { create });
    if (parsed.missing === true && !create) return null;
    if (typeof parsed.id !== "string" || !/^[a-f0-9]{32}$/.test(parsed.id) || typeof parsed.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(parsed.key)) throw unavailable();
    const key = Buffer.from(parsed.key, "base64");
    if (key.length !== 32 || key.toString("base64") !== parsed.key) throw unavailable();
    return { id: parsed.id, key };
  };
}

/**
 * The way back to a build from before sec-vault round 2 (INSTALL-NOTE): the helper writes the key
 * again where those builds look. Only this gateway (its ticket) can ask; done right before the
 * service is stopped for the rollback.
 */
export async function restoreLegacyVault(dataDir: string, binary = gatewayOnly("WORKBENCH_SECRET_BIN")) {
  const parsed = await askHelper(binary, dataDir, { create: false, restore_legacy: true });
  if (parsed.restored !== true) throw unavailable();
  legacyKept = true;
}

/** Ask the launcher (this gateway's parent, the app's binary) to write the registration again. */
export function askToRegisterAgain(write: (line: string) => void = (line) => process.stdout.write(line)) {
  // host_runtime.rs REREGISTER: acted on by the launcher, never forwarded to the log.
  write("WORKBENCH_VAULT_REGISTER\n");
}

/** AES-256-GCM protects every value with a fresh nonce. The OS vault owns the master key.
 * Reading old Electron ciphertext never calls its codec or replaces it with an empty value. */
export class OfficeVault {
  private readonly load: OfficeVaultLoader;
  private cached: OfficeVaultKey | null = null;
  private pending: Promise<OfficeVaultKey | null> | null = null;
  private closed = false;
  readonly dataDir: string;
  constructor(dataDir: string, load = nativeOfficeVault(dataDir)) { this.dataDir = dataDir; this.load = load; }
  private async key(create: boolean): Promise<OfficeVaultKey | null> {
    if (this.closed) throw unavailable();
    if (this.cached) return this.cached;
    // A standing refusal is not asked again on every use (no loop of refused calls): `retryVault`.
    if (vaultState.state === "refused" && vaultState.reason && STANDING.has(vaultState.reason)) throw new VaultRefused(vaultState.reason);
    if (this.pending) { await this.pending; if (this.cached) return this.cached; }
    // The registration gone (deleted, or the keyring refused the launcher's write at start): ask the
    // launcher once to write it again and try once more — one retry, never a loop.
    const loadOnce = () => this.load(create).catch(async (error: unknown) => {
      if (!(error instanceof VaultRefused) || error.reason !== "gateway_not_registered" || !gatewayTicket()) throw error;
      askToRegisterAgain();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.load(create);
    });
    const pending = loadOnce().then((value) => {
      if (value && (!/^[a-f0-9]{32}$/.test(value.id) || value.key.length !== 32)) throw unavailable();
      if (this.closed) { value?.key.fill(0); throw unavailable(); }
      this.cached = value; return value;
    });
    this.pending = pending;
    try {
      const value = await pending;
      setVaultState({ state: "open", reason: null, message: null });
      return value;
    } catch (error) {
      if (error instanceof VaultRefused) setVaultState({ state: "refused", reason: error.reason, message: refusalText(error.reason) });
      throw error;
    } finally { if (this.pending === pending) this.pending = null; }
  }
  /**
   * The gateway's FIRST act after reading its ticket, before it starts anything else: ask the helper
   * once, so a refusal (another registration, a locked keyring, a missing item) is known and SAID at
   * start (review I3) — one line in service.log, the app's standing notice, the messenger's status.
   */
  async register(): Promise<VaultState> {
    try { await this.key(false); }
    catch (error) {
      if (!(error instanceof VaultRefused)) setVaultState({ state: "refused", reason: "vault_unavailable", message: refusalText("vault_unavailable") });
      console.error(`Vault: refused (${vaultState.reason}). ${vaultState.message}`);
    }
    return vaultState;
  }
  /**
   * 다시 시도: ask the launcher to write this gateway's registration again (harmless when it is there:
   * the same gateway, the same ticket hash), then ask the helper once, fresh (not from the cache).
   */
  async retry(wait = 1000): Promise<VaultState> {
    askToRegisterAgain();
    await new Promise((resolve) => setTimeout(resolve, wait));
    setVaultState({ state: "unknown", reason: null, message: null });
    try {
      const value = await this.load(false);
      if (value && !this.cached && !this.closed) this.cached = value; else value?.key.fill(0);
      setVaultState({ state: "open", reason: null, message: null });
    } catch (error) {
      const reason = error instanceof VaultRefused ? error.reason : "vault_unavailable";
      setVaultState({ state: "refused", reason, message: refusalText(reason) });
      console.error(`Vault: refused (${reason}). ${vaultState.message}`);
    }
    return vaultState;
  }
  async seal(plain: string) {
    if (!plain) return "";
    if (plain.startsWith("sealed:v1:")) return plain;
    const entry = await this.key(true); if (!entry) throw unavailable();
    return sealOfficeSecret(plain, entry);
  }
  async open(sealed: string) {
    if (!sealed.startsWith(OFFICE_SEALED_PREFIX)) throw legacy();
    return openOfficeSecret(sealed, await this.key(false));
  }
  /**
   * Seal for another use of the same master key (see `VaultPurpose`); never returns the plain value.
   * `bind` (a credential's entry and field) is authenticated with it, so the sealed value opens only
   * where it was sealed for.
   */
  async sealFor(purpose: VaultPurpose, plain: string, bind?: string) {
    if (!plain) return "";
    const entry = await this.key(true); if (!entry) throw unavailable();
    return sealOfficeSecret(plain, entry, purpose, bind);
  }
  async openFor(purpose: VaultPurpose, sealed: string, bind?: string) {
    if (!sealed.startsWith(OFFICE_SEALED_PREFIX)) throw new HttpError(422, "office_secret_invalid", "보관된 값의 형식이 올바르지 않습니다. 기존 값은 변경하지 않았습니다.");
    return openOfficeSecret(sealed, await this.key(false), purpose, bind);
  }
  /** Prepare once for upstream controllers whose durable record port is synchronous. */
  async prepareCodec(create: boolean): Promise<OfficeVaultCodec> {
    const entry = await this.key(create); if (!entry) throw unavailable();
    return {
      seal: plain => { if (this.closed) throw unavailable(); return sealOfficeSecret(plain, entry); },
      open: sealed => { if (this.closed) throw unavailable(); return openOfficeSecret(sealed, entry); },
    };
  }
  close() { this.closed = true; this.cached?.key.fill(0); this.cached = null; }
}
