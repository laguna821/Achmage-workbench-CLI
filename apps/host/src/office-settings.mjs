import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mapAiSecrets, normalizeAiSettings, sanitizeAiSettings } from "../../../vendor/ieumoffice/packages/ai-provider/src/index.ts";
import { HttpError } from "./errors.ts";
import { OfficeVault, OFFICE_SEALED_PREFIX } from "./office-vault.ts";

export const OFFICE_SECRET_PLACEHOLDER = "__workbench_saved_secret__";
const REFERENCE = "__workbench_secret_ref_";
const LIMIT = 2_000_000;
const copy = (value) => JSON.parse(JSON.stringify(value));
const error = (code, message, status = 422) => new HttpError(status, code, message);
const revisionOf = (raw) => createHash("sha256").update(raw === null ? "missing" : `file:${raw}`).digest("hex");
// The original map predates migration of the oldest top-level apiKey shape.
const mapSecrets = (settings, fn) => {
  const next = mapAiSecrets(settings, fn);
  if (next && typeof next.apiKey === "string") next.apiKey = fn(next.apiKey);
  return next;
};

/** Original settings normalization, with opaque renderer references and a native secret vault.
 * Reads never rewrite/migrate files. Every write compares the exact bytes the caller read. */
export class OfficeSettings {
  constructor(dataDir, vault = new OfficeVault(dataDir)) {
    this.directory = join(dataDir, "office"); this.path = join(this.directory, "ai-settings.json");
    this.vault = vault; this.cached = undefined; this.queue = Promise.resolve(); this.closed = false;
  }
  raw() {
    if (!existsSync(this.path)) return null;
    try {
      if (statSync(this.path).size > LIMIT) throw new Error("size");
      const raw = readFileSync(this.path, "utf8");
      if (Buffer.byteLength(raw) > LIMIT) throw new Error("size");
      return raw;
    } catch { throw error("office_settings_read", "Office AI 설정을 읽지 못했습니다. 기존 파일은 변경하지 않았습니다.", 500); }
  }
  current() {
    const raw = this.raw();
    if (this.cached && this.cached.raw === raw) return this.cached;
    let parsed;
    try { parsed = raw === null ? {} : JSON.parse(raw); } catch { throw error("office_settings_read", "Office AI 설정 파일이 올바른 JSON이 아닙니다. 기존 파일은 변경하지 않았습니다.", 500); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw error("office_settings_read", "Office AI 설정 형식이 올바르지 않습니다. 기존 파일은 변경하지 않았습니다.", 500);
    const refs = new Map(), byValue = new Map();
    const masked = mapSecrets(parsed, (value) => {
      if (!value) return "";
      let ref = byValue.get(value);
      if (!ref) { ref = `${REFERENCE}${randomUUID()}__`; refs.set(ref, value); byValue.set(value, ref); }
      return ref;
    });
    this.cached = { raw, revision: revisionOf(raw), settings: normalizeAiSettings(masked), refs };
    return this.cached;
  }
  snapshot() {
    const current = this.current();
    return { revision: current.revision, settings: copy(current.settings), legacySecrets: [...current.refs.values()].filter((v) => v.startsWith("sealed:v1:") && !v.startsWith(OFFICE_SEALED_PREFIX)).length };
  }
  publicSettings() { return mapAiSecrets(this.snapshot().settings, (v) => v ? OFFICE_SECRET_PLACEHOLDER : ""); }
  async openSecret(value) {
    if (typeof value !== "string" || value.length > 200_000) throw error("office_settings_secret_invalid", "키 형식이 올바르지 않습니다.");
    if (value.startsWith(REFERENCE)) {
      const raw = this.current().refs.get(value);
      if (raw === undefined) throw error("office_settings_secret_changed", "보관된 키가 변경되었습니다. 설정을 다시 읽어 주세요.", 409);
      return raw.startsWith("sealed:v1:") ? this.vault.open(raw) : raw;
    }
    if (value.startsWith("sealed:v1:") || value === OFFICE_SECRET_PLACEHOLDER) throw error("office_settings_secret_invalid", "설정을 다시 읽어 주세요.");
    return value;
  }
  /** A trusted settings connection test may use its unsaved draft; never writes it. */
  async draftSettings(draft) {
    const safe = sanitizeAiSettings(draft);
    if (!safe) throw error("office_settings_invalid", "AI 설정 형식이 올바르지 않습니다.");
    const normalized = normalizeAiSettings(safe), values = new Map();
    mapAiSecrets(normalized, (value) => { values.set(value, undefined); return value; });
    for (const value of values.keys()) {
      try { values.set(value, await this.openSecret(value)); }
      catch (error) {
        // An unrelated legacy key must not prevent testing a new provider. Like
        // executionSettings, leave unavailable legacy credentials empty in memory.
        if (error.code !== "office_legacy_secret") throw error;
        values.set(value, "");
      }
    }
    return mapAiSecrets(normalized, (value) => values.get(value));
  }
  async executionSettings() {
    return (await this.executionContext()).settings;
  }
  /** Original file-based Office tools use their codec synchronously. Open only in
   * the host, and keep this map scoped to the one request; never write plaintext. */
  async executionContext() {
    const current = this.current(), opened = new Map();
    const secrets = new Map();
    for (const [ref, raw] of current.refs) {
      // An old Electron envelope remains on disk, but cannot become an HTTP header.
      const value = raw.startsWith(OFFICE_SEALED_PREFIX) ? await this.vault.open(raw) : raw.startsWith("sealed:v1:") ? "" : raw;
      opened.set(ref, value); secrets.set(raw, value);
    }
    if (this.current().revision !== current.revision) throw error("office_settings_changed", "AI 설정이 바뀌었습니다. 다시 요청해 주세요.", 409);
    return { settings: mapAiSecrets(copy(current.settings), (v) => opened.get(v) ?? v), secrets };
  }
  write(settings, expectedRevision, options = {}) {
    const job = this.queue.then(() => this.save(settings, expectedRevision, options));
    this.queue = job.catch(() => {}); return job;
  }
  async save(settings, expectedRevision, { metered = false, signal } = {}) {
    if (this.closed) throw error("office_settings_closed", "앱을 종료하고 있습니다.", 503);
    const current = this.current();
    if (expectedRevision !== current.revision) throw error("office_settings_changed", "다른 창에서 AI 설정을 변경했습니다. 현재 설정을 다시 읽어 주세요.", 409);
    const sanitized = sanitizeAiSettings(settings);
    if (!sanitized) throw error("office_settings_invalid", "AI 설정 형식이 올바르지 않습니다.");
    let next = normalizeAiSettings(sanitized);
    // Only the original subscription service may record consent and its login fingerprint.
    if (!metered) next.meteredAccepted = copy(current.settings.meteredAccepted ?? {});
    for (const provider of ["codex", "claude-code"]) {
      if ((next.providers[provider]?.cliPath?.trim() ?? "") !== (current.settings.providers[provider]?.cliPath?.trim() ?? "")) {
        next.meteredAccepted[provider] = false;
      }
    }
    const resolved = new Map();
    mapAiSecrets(next, (v) => {
      if (v.startsWith(REFERENCE)) {
        if (!current.refs.has(v)) throw error("office_settings_secret_changed", "보관된 키 참조가 만료되었습니다. 설정을 다시 읽어 주세요.", 409);
        resolved.set(v, current.refs.get(v));
      } else if (v === OFFICE_SECRET_PLACEHOLDER || v.startsWith("sealed:v1:")) {
        throw error("office_settings_secret_invalid", "이 화면에서 보관된 키를 확인할 수 없습니다. 설정을 다시 읽어 주세요.");
      } else resolved.set(v, v);
      return v;
    });
    // Also seal old plaintext values preserved through an opaque reference, on an explicit save.
    const sealed = new Map();
    for (const value of new Set(resolved.values())) sealed.set(value, await this.vault.seal(value));
    next = mapAiSecrets(next, (value) => sealed.get(resolved.get(value)));
    const output = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(output) > LIMIT) throw error("office_settings_large", "AI 설정이 너무 큽니다.");
    // Keyring access can wait for an unlock. Re-check after it, immediately before atomic replace.
    if (revisionOf(this.raw()) !== expectedRevision) throw error("office_settings_changed", "저장하는 동안 AI 설정이 변경되었습니다. 현재 설정을 다시 읽어 주세요.", 409);
    if (signal?.aborted) throw error("office_settings_cancelled", "설정 연결을 취소했습니다.", 499);
    if (this.closed) throw error("office_settings_closed", "앱을 종료하고 있습니다.", 503);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.ai-settings-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, output); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
    } catch { throw error("office_settings_write", "AI 설정을 저장하지 못했습니다. 다시 시도해 주세요."); }
    finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
    this.cached = undefined;
    return this.snapshot();
  }
  async setMeteredAccepted(provider, accepted) {
    const current = this.snapshot();
    await this.write({ ...current.settings, meteredAccepted: { ...current.settings.meteredAccepted, [provider]: accepted } }, current.revision, { metered: true });
  }
  close() { this.closed = true; this.cached = undefined; this.vault.close(); }
}
