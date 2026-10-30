import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { HttpError } from "./errors.ts";

export const OFFICE_SEALED_PREFIX = "sealed:v1:workbench:";
export type OfficeVaultKey = { id: string; key: Buffer };
export type OfficeVaultLoader = (create: boolean) => Promise<OfficeVaultKey | null>;
const unavailable = () => new HttpError(503, "office_vault_unavailable", "운영체제의 보안 저장소를 사용할 수 없습니다. 저장소 잠금을 해제한 뒤 다시 시도해 주세요. 키를 평문으로 저장하지 않았습니다.");

/** One bounded request to our own Rust executable; no keys in arguments, environment or logs. */
export function nativeOfficeVault(dataDir: string, binary = process.env.WORKBENCH_SECRET_BIN): OfficeVaultLoader {
  return async (create) => {
    if (!binary) throw unavailable();
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, ["--office-secret-key"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      let stdout = "", ended = false;
      const fail = () => { if (!ended) { ended = true; clearTimeout(timer); child.kill(); reject(unavailable()); } };
      const timer = setTimeout(fail, 15_000);
      child.once("error", fail); child.stdin.once("error", fail);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 4_096) fail(); });
      child.once("close", (code) => {
        clearTimeout(timer); if (ended) return; ended = true;
        if (code === 0) resolve(stdout); else reject(unavailable());
      });
      child.stdin.end(JSON.stringify({ directory: dataDir, create }));
    });
    let parsed: { ok?: unknown; missing?: unknown; id?: unknown; key?: unknown };
    try { parsed = JSON.parse(output); } catch { throw unavailable(); }
    if (!parsed || parsed.ok !== true) throw unavailable();
    if (parsed.missing === true && !create) return null;
    if (typeof parsed.id !== "string" || !/^[a-f0-9]{32}$/.test(parsed.id) || typeof parsed.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(parsed.key)) throw unavailable();
    const key = Buffer.from(parsed.key, "base64");
    if (key.length !== 32 || key.toString("base64") !== parsed.key) throw unavailable();
    return { id: parsed.id, key };
  };
}

/** AES-256-GCM protects every value with a fresh nonce. The OS vault owns the master key.
 * Reading old Electron ciphertext never calls its codec or replaces it with an empty value. */
export class OfficeVault {
  private readonly load: OfficeVaultLoader;
  private cached: OfficeVaultKey | null = null;
  private pending: Promise<OfficeVaultKey | null> | null = null;
  private closed = false;
  constructor(dataDir: string, load = nativeOfficeVault(dataDir)) { this.load = load; }
  private async key(create: boolean): Promise<OfficeVaultKey | null> {
    if (this.closed) throw unavailable();
    if (this.cached) return this.cached;
    if (this.pending) { await this.pending; if (this.cached) return this.cached; }
    const pending = this.load(create).then((value) => {
      if (value && (!/^[a-f0-9]{32}$/.test(value.id) || value.key.length !== 32)) throw unavailable();
      if (this.closed) { value?.key.fill(0); throw unavailable(); }
      this.cached = value; return value;
    });
    this.pending = pending;
    try { return await pending; } finally { if (this.pending === pending) this.pending = null; }
  }
  async seal(plain: string) {
    if (!plain) return "";
    if (plain.startsWith("sealed:v1:")) return plain;
    const entry = await this.key(true); if (!entry) throw unavailable();
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", entry.key, nonce);
    cipher.setAAD(Buffer.from(`${OFFICE_SEALED_PREFIX}${entry.id}`));
    const bytes = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${OFFICE_SEALED_PREFIX}${entry.id}:${nonce.toString("base64url")}.${bytes.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }
  async open(sealed: string) {
    if (!sealed.startsWith(OFFICE_SEALED_PREFIX)) throw new HttpError(409, "office_legacy_secret", "이전 Electron 앱에서 봉인한 키입니다. 기존 값은 보존했으며 키를 다시 입력하거나 이행 절차를 사용해야 합니다.");
    const match = /^([a-f0-9]{32}):([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(sealed.slice(OFFICE_SEALED_PREFIX.length));
    if (!match || sealed.length > 200_000) throw new HttpError(422, "office_secret_invalid", "보관된 키의 형식이 올바르지 않습니다. 기존 값은 변경하지 않았습니다.");
    const entry = await this.key(false); if (!entry || entry.id !== match[1]) throw unavailable();
    try {
      const nonce = Buffer.from(match[2]!, "base64url"), body = Buffer.from(match[3]!, "base64url"), tag = Buffer.from(match[4]!, "base64url");
      if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", entry.key, nonce);
      decipher.setAAD(Buffer.from(`${OFFICE_SEALED_PREFIX}${entry.id}`)); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch { throw new HttpError(422, "office_secret_invalid", "보관된 키를 확인하지 못했습니다. 기존 값은 변경하지 않았습니다."); }
  }
  close() { this.closed = true; this.cached?.key.fill(0); this.cached = null; }
}
