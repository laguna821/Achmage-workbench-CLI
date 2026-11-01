import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeImageHostConfig, uploadImageToHost } from "../../../vendor/ieumoffice/apps/markdown/src/main/image-host.ts";
import { normalizeMarkdownTheme } from "../../../vendor/ieumoffice/apps/markdown/src/shared/markdown-theme.ts";
import { EXPORT_IMAGE_EXTS, remoteExportImageMime } from "../../../vendor/ieumoffice/apps/markdown/src/shared/export-image-mime.ts";
import { fetchRemoteImage, readBodyCapped, MAX_REMOTE_IMAGE_BYTES } from "../../../vendor/ieumoffice/packages/electron-utils/src/remote-image.ts";
import { OfficeVault } from "./office-vault.ts";
import { HttpError } from "./errors.ts";

const SECRET_FIELDS = ["accessKeyId", "secretAccessKey", "token"], REF = "__wb_markdown_secret_";
const object = value => value && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (message, status = 409) => new HttpError(status, "office_markdown", message);
const clone = value => JSON.parse(JSON.stringify(value));
const secrets = (value, map) => {
  if (!object(value)) return value;
  const next = { ...value };
  for (const key of SECRET_FIELDS) if (typeof next[key] === "string" && next[key]) next[key] = map(next[key]);
  return next;
};

/** Legacy import selects only the two original Markdown fields; never executes or rewrites it. */
export function importedMarkdownSettings(raw) {
  const patch = {}, warnings = [];
  if (!object(raw)) return { patch, warnings };
  if (Object.hasOwn(raw, "markdownTheme")) patch.markdownTheme = normalizeMarkdownTheme(raw.markdownTheme);
  if (Object.hasOwn(raw, "imageHost")) {
    const secretValues = SECRET_FIELDS.map(key => raw.imageHost?.[key]).filter(v => typeof v === "string");
    if (secretValues.some(v => v.startsWith("sealed:") || v.startsWith(REF))) warnings.push("Markdown 이미지 호스트의 봉인된 키는 직접 다시 입력해 주세요. 기존 설정을 보존합니다.");
    else {
      const host = normalizeImageHostConfig(raw.imageHost);
      if (host || raw.imageHost === null) patch.imageHost = host;
      else warnings.push("Markdown 이미지 호스트 설정이 불완전하여 가져오기에서 제외했습니다.");
    }
  }
  return { patch, warnings };
}

/** Original settings/uploader with encrypted storage and opaque saved-key references. */
export class OfficeMarkdown {
  constructor(dataDir, injected = {}) {
    this.directory = join(dataDir, "office"); this.path = join(this.directory, "markdown-settings.json");
    this.vault = injected.vault ?? new OfficeVault(dataDir); this.ownsVault = !injected.vault;
    this.fetch = injected.fetch ?? fetch; this.remote = injected.remote ?? fetchRemoteImage; this.cached = null; this.queue = Promise.resolve(); this.closed = false;
  }
  current() {
    let raw = null, parsed = {};
    if (existsSync(this.path)) {
      const info = lstatSync(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw fail("Markdown 설정 파일을 읽을 수 없습니다. 기존 파일을 보존했습니다.");
      raw = readFileSync(this.path, "utf8");
    }
    if (this.cached?.raw === raw) return this.cached;
    try { parsed = raw === null ? {} : JSON.parse(raw); } catch { throw fail("Markdown 설정 JSON을 읽지 못했습니다. 기존 파일을 보존했습니다."); }
    if (!object(parsed)) throw fail("Markdown 설정 형식을 확인해 주세요.");
    const refs = new Map(), masked = secrets(parsed.imageHost, value => { const ref = `${REF}${randomUUID()}__`; refs.set(ref, value); return ref; });
    return this.cached = { raw, parsed, refs, revision: hash(raw === null ? "missing" : `file:${raw}`), imageHost: normalizeImageHostConfig(masked) };
  }
  snapshot() {
    const c = this.current();
    return { revision: c.revision, imageHost: clone(c.imageHost), markdownTheme: normalizeMarkdownTheme(c.parsed.markdownTheme), themeConfigured: Object.hasOwn(c.parsed, "markdownTheme") };
  }
  write(patch, revision, options = {}) {
    const next = this.queue.then(() => this.save(patch, revision, options)); this.queue = next.catch(() => {}); return next;
  }
  async save(patch, revision, { backup = false, signal, beforeCommit } = {}) {
    const initial = this.current();
    const check = () => {
      signal?.throwIfAborted();
      if (this.closed || this.current().revision !== revision) throw fail("Markdown 설정이 바뀌었습니다. 설정을 다시 열어 주세요.");
      beforeCommit?.();
    };
    check();
    if (!object(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !["imageHost", "markdownTheme"].includes(key))) throw fail("Markdown 설정 항목을 확인해 주세요.", 400);
    const next = { ...initial.parsed };
    if (Object.hasOwn(patch, "markdownTheme")) next.markdownTheme = normalizeMarkdownTheme(patch.markdownTheme);
    if (Object.hasOwn(patch, "imageHost")) {
      const host = normalizeImageHostConfig(patch.imageHost);
      if (!host && patch.imageHost !== null) throw fail("이미지 호스트의 필수 항목을 입력해 주세요.", 400);
      next.imageHost = host;
      if (host) for (const key of SECRET_FIELDS) if (host[key]) {
        const value = host[key];
        if (value.startsWith(REF)) {
          const stored = initial.refs.get(value); if (stored === undefined) throw fail("보관된 키가 바뀌었습니다. 설정을 다시 열어 주세요.");
          host[key] = stored.startsWith("sealed:v1:") ? stored : await this.vault.seal(stored);
        } else {
          if (value.startsWith("sealed:")) throw fail("보관된 키는 설정 화면에서 다시 입력해 주세요.");
          host[key] = await this.vault.seal(value);
        }
      }
    }
    // A theme-only change retains any prior secrets byte-for-byte, including unavailable keys.
    let backupPath = null, backupBytes = null;
    if (backup && initial.raw !== null) {
      const bytes = Buffer.from(initial.raw), chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 6000) chunks.push(await this.vault.seal(bytes.subarray(offset, offset + 6000).toString("base64")));
      backupPath = join(this.directory, `markdown-settings.${randomUUID()}.sealed-backup.json`);
      backupBytes = JSON.stringify({ version: 1, encoding: "base64", sha256: hash(bytes), chunks });
    }
    check(); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      if (backupPath) writeFileSync(backupPath, backupBytes, { flag: "wx", mode: 0o600 });
      writeFileSync(temp, JSON.stringify(next, null, 2), { flag: "wx", mode: 0o600 });
      check(); renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
    return { snapshot: this.snapshot(), backup: backupPath };
  }
  async upload(data, signal, authorize = () => {}) {
    let plain = null;
    try {
      signal?.throwIfAborted();
      if (this.closed) throw fail("앱을 종료하고 있습니다.");
      if (!object(data) || typeof data.base64 !== "string" || !data.base64 || data.base64.length > Math.ceil(25 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64) || !EXPORT_IMAGE_EXTS.includes(data.ext)) throw fail("업로드할 그림의 형식이나 크기를 확인해 주세요.", 400);
      const initial = this.current(); if (!initial.imageHost) return { ok: false, error: "이미지 호스트를 먼저 설정해 주세요." };
      plain = clone(initial.imageHost);
      for (const key of SECRET_FIELDS) if (plain[key]) {
        const stored = initial.refs.get(plain[key]);
        plain[key] = stored.startsWith("sealed:v1:") ? await this.vault.open(stored) : stored;
      }
      signal?.throwIfAborted(); authorize();
      if (this.current().revision !== initial.revision) throw fail("이미지 호스트가 바뀌었습니다. 다시 시도해 주세요.");
      const result = await uploadImageToHost(plain, { bytes: Buffer.from(data.base64, "base64"), ext: data.ext,
        fetchImpl: (url, options) => this.fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal }) });
      if (result.ok && !/^https?:\/\//i.test(result.url ?? "")) return { ok: false, error: "이미지 호스트에서 웹 주소를 받지 못했습니다." };
      // Upstream abbreviates error bodies. Exact-value masking after that cut
      // could expose part of an echoed credential; return only a safe status.
      if (!result.ok) {
        const label = { s3: "S3", smms: "SM.MS", github: "GitHub" }[plain.kind];
        const status = /^(?:S3|SM\.MS|GitHub) (\d{3})(?::|$)/.exec(result.error ?? "")?.[1];
        return { ok: false, error: `${label} 업로드에 실패했습니다${status ? ` (HTTP ${status})` : ""}. 연결과 인증 설정을 확인해 주세요.` };
      }
      return result;
    } catch (error) {
      let message = error instanceof HttpError ? error.message : "그림을 업로드하지 못했습니다. 로컬 사본으로 저장합니다.";
      for (const key of SECRET_FIELDS) if (plain?.[key]) message = message.replaceAll(plain[key], "[보관된 키]");
      return { ok: false, error: message };
    }
  }
  async readImage(url, signal) {
    if (this.closed || typeof url !== "string" || url.length > 8192 || !/^https?:\/\//i.test(url)) return null;
    try {
      signal?.throwIfAborted();
      const response = await this.remote(url, { fetchImpl: (input, options = {}) => this.fetch(input, { ...options, signal: signal ? AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]) : options.signal }) });
      if (!response?.ok) return null;
      const bytes = await readBodyCapped(response, MAX_REMOTE_IMAGE_BYTES), mime = remoteExportImageMime(bytes, response.headers.get("content-type"), url);
      return mime ? { base64: Buffer.from(bytes).toString("base64"), mime } : null;
    } catch { return null; }
  }
  close() { this.closed = true; this.cached = null; if (this.ownsVault) this.vault.close(); }
}
