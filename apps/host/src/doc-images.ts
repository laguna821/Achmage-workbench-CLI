import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Artifact, DocImageResult, ImageUploadCheck, ImageUploadInput, ImageUploadView } from "@workbench/contracts";

/** What the settings form sends, as it arrives (each field checked here). */
type Input = { [K in keyof ImageUploadInput]?: unknown };
import { WORKBENCH_DIR, type Documents } from "./artifacts.ts";
import { clipboardPicture } from "./clipboard-picture.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";

// Images pasted or dropped into Markdown documents (Word, PowerPoint and Excel embed theirs in the
// file, apps/office). With the user's Cloudflare R2 bucket set up, the image goes there through the
// S3 API — signed here with SigV4, no SDK — and the document links its public address, the way the
// user's Obsidian plugin (CMDS Eagle) does. Otherwise, or when the upload fails, the image is kept in
// the work folder's assets/ under its content hash and linked relatively. The R2 keys stay on this
// machine: a 0600 file in the gateway's data folder, never sent back whole and never logged.

const SETTINGS_FILE = "image-upload.json";
/** Signing region of R2's S3 API. */
const R2_REGION = "auto";

const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

// ── SigV4 ──────────────────────────────────────────────────────────────

/** RFC 3986 encoding as SigV4 wants it: everything but A–Z a–z 0–9 - _ . ~ is escaped. */
export function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A path with each segment encoded once (S3 does not double-encode) and its slashes kept. */
export function encodePath(path: string) {
  return path.split("/").map(awsEncode).join("/");
}

/** `20130524T000000Z` */
export function amzDate(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

export function signingKey(secret: string, day: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
}

export type SignInput = {
  method: string;
  /** The path as it is (not encoded), e.g. `/bucket/key.png`. */
  path: string;
  query?: [string, string][];
  /** Every header that is signed, including host and x-amz-date. */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
};

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** AWS Signature Version 4 of one request (header form). */
export function signV4(input: SignInput) {
  const headers = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => byCode(a, b));
  const date = headers.find(([name]) => name === "x-amz-date")?.[1];
  if (!date) throw new Error("x-amz-date must be signed");
  const day = date.slice(0, 8);
  const signedHeaders = headers.map(([name]) => name).join(";");
  const query = (input.query ?? [])
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([ak, av], [bk, bv]) => byCode(ak, bk) || byCode(av, bv))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = [input.method, encodePath(input.path), query, headers.map(([name, value]) => `${name}:${value}\n`).join(""), signedHeaders, input.payloadHash].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, day, input.region, input.service)).update(stringToSign, "utf8").digest("hex");
  return {
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ── settings ───────────────────────────────────────────────────────────

type Settings = {
  version: 1;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
  keyPrefix: string;
  updatedAt: number;
};

const ACCOUNT = /^[0-9a-f]{32}(\.(eu|fedramp))?$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The account ID, also from the S3 API address the dashboard shows (`https://<id>[.eu].r2.cloudflarestorage.com/<bucket>`). */
export function parseAccount(value: string): { accountId: string; bucket: string | null } {
  const text = value.trim();
  const found = /^(?:https?:\/\/)?([0-9a-f]{32})(\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com(?:\/([^/?#]+))?/i.exec(text);
  if (found) return { accountId: `${found[1]!.toLowerCase()}${found[2]?.toLowerCase() ?? ""}`, bucket: found[3] ? decodeURIComponent(found[3]) : null };
  return { accountId: text.toLowerCase(), bucket: null };
}

/** `workbench` → `workbench/`; only plain characters, so keys and addresses need no care. */
export function normalizePrefix(value: string) {
  const prefix = value.trim().replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!prefix) return "";
  if (!/^[A-Za-z0-9._\-/]+$/.test(prefix) || prefix.split("/").some((part) => part === "." || part === "..") || prefix.length > 200) {
    throw new HttpError(400, "invalid_prefix", "키 앞부분에는 영문·숫자와 . _ - / 만 쓸 수 있습니다.");
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export function normalizePublicUrl(value: string) {
  const text = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, "invalid_public_url", "공개 주소는 https://로 시작하는 주소입니다(r2.dev 주소나 연결한 도메인).");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash || url.username || url.password) {
    throw new HttpError(400, "invalid_public_url", "공개 주소는 https://로 시작하는 주소입니다(r2.dev 주소나 연결한 도메인).");
  }
  // The S3 API address needs the keys; links in documents need the bucket's public address.
  if (/\.r2\.cloudflarestorage\.com$/i.test(url.hostname)) {
    throw new HttpError(400, "invalid_public_url", "이 주소는 S3 API 주소입니다. 공개 주소는 버킷 설정의 r2.dev 주소(https://pub-….r2.dev)나 연결한 도메인입니다.");
  }
  return text;
}

/** Settings that are complete and well formed, or the reason they are not. */
function validate(settings: Omit<Settings, "version" | "updatedAt">): string | null {
  if (!ACCOUNT.test(settings.accountId)) return "계정 ID는 Cloudflare 대시보드에 있는 32자리 계정 ID(또는 S3 API 주소)입니다.";
  if (!/^[A-Za-z0-9]{8,128}$/.test(settings.accessKeyId)) return "액세스 키 ID를 확인해 주세요(R2 API 토큰을 만들 때 나온 값).";
  if (!/^\S{8,256}$/.test(settings.secretAccessKey)) return "비밀 액세스 키를 입력해 주세요(R2 API 토큰을 만들 때 한 번만 보이는 값).";
  if (!BUCKET.test(settings.bucket)) return "버킷 이름은 소문자·숫자·하이픈으로 된 3~63자입니다.";
  if (!settings.publicBaseUrl) return "공개 주소를 입력해 주세요(버킷 설정의 r2.dev 주소나 연결한 도메인).";
  return null;
}

const hint = (accessKeyId: string) => (accessKeyId.length > 10 ? `${accessKeyId.slice(0, 4)}…${accessKeyId.slice(-4)}` : "…");

// ── images ─────────────────────────────────────────────────────────────

type ImageType = { ext: string; mime: string };

/** What an image really is, from its first bytes (the name and the browser's type are only hints). */
export function imageType(data: Buffer): ImageType | null {
  const text = (from: number, to: number) => data.subarray(from, to).toString("latin1");
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) return { ext: ".png", mime: "image/png" };
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { ext: ".jpg", mime: "image/jpeg" };
  if (data.length > 6 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a")) return { ext: ".gif", mime: "image/gif" };
  if (data.length > 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return { ext: ".webp", mime: "image/webp" };
  if (data.length > 12 && text(4, 8) === "ftyp" && /^avi[fs]$/.test(text(8, 12))) return { ext: ".avif", mime: "image/avif" };
  if (data.length > 26 && text(0, 2) === "BM") return { ext: ".bmp", mime: "image/bmp" };
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(data.subarray(0, 4096).toString("utf8"))) return { ext: ".svg", mime: "image/svg+xml" };
  return null;
}

const SHOWN = new Map(
  Object.entries({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  }),
);

/** Alt text from the file name: `강의 도식.png` → `강의 도식`; a clipboard image is just "image". */
export function altText(name: string) {
  const stem = basename(name, extname(name))
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return stem || "image";
}

const within = (root: string, path: string) => {
  const inside = relative(root, path);
  return Boolean(inside) && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
};

/**
 * The image file a Markdown `src` points at: relative to the document, inside `root` (its work
 * folder), not under `.workbench`, an image by its extension, and still inside after links are
 * followed.
 */
export function resolveDocImage(root: string, docPath: string, src: string): { file: string; type: string } {
  let path = src.trim();
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) throw new HttpError(400, "image_src", "작업 폴더 안의 그림 경로가 아닙니다.");
  path = path.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    throw new HttpError(400, "image_src", "그림 경로를 읽지 못했습니다.");
  }
  if (!path || isAbsolute(path) || path.includes("\0")) throw new HttpError(400, "image_src", "작업 폴더 안의 그림 경로가 아닙니다.");
  const file = resolve(dirname(docPath), path);
  if (!within(root, file) || relative(root, file).split(sep).includes(WORKBENCH_DIR)) throw new HttpError(403, "outside", "작업 폴더 밖의 파일은 보여 주지 않습니다.");
  const type = SHOWN.get(extname(file).toLowerCase());
  if (!type) throw new HttpError(415, "not_image", "그림 파일이 아닙니다.");
  if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "image_missing", `그림 파일이 없습니다: ${path}`);
  const real = realpathSync(file);
  if (!within(realpathSync(root), real)) throw new HttpError(403, "outside", "작업 폴더 밖의 파일은 보여 주지 않습니다.");
  return { file: real, type };
}

// ── R2 ─────────────────────────────────────────────────────────────────

/** A refusal or failure of R2, already said in the user's words. */
export class R2Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function r2Message(status: number, code: string, bucket: string) {
  switch (code) {
    case "InvalidAccessKeyId":
      return "액세스 키 ID가 맞지 않습니다.";
    case "SignatureDoesNotMatch":
      return "비밀 액세스 키가 맞지 않습니다.";
    case "NoSuchBucket":
      return `버킷이 없습니다: ${bucket}`;
    case "AccessDenied":
    case "Unauthorized":
      return "이 키로는 버킷에 쓸 수 없습니다. R2 API 토큰 권한(객체 읽기·쓰기)과 버킷을 확인해 주세요.";
    case "RequestTimeTooSkewed":
      return "이 컴퓨터의 시계가 맞지 않아 R2가 거절했습니다.";
    case "EntityTooLarge":
      return "그림이 너무 커서 올리지 못했습니다.";
  }
  return `R2가 거절했습니다(HTTP ${status}${code ? ` ${code}` : ""}).`;
}

function networkMessage(error: unknown) {
  const cause = (error as { cause?: { code?: string } })?.cause?.code ?? "";
  if (error instanceof Error && error.name === "TimeoutError") return "R2가 응답하지 않아 시간이 지났습니다.";
  if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") return "R2 주소를 찾지 못했습니다. 계정 ID와 인터넷 연결을 확인해 주세요.";
  return "R2에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.";
}

export type DocImagesOptions = {
  dataDir: string;
  documents: Documents;
  /** The folder a work runs in. */
  workCwd: (workId: string) => string;
  /** Another S3 endpoint instead of `https://<account>.r2.cloudflarestorage.com` (checks with a local stand-in). */
  endpoint?: string | null;
};

export class DocImages {
  private readonly options: DocImagesOptions;
  constructor(options: DocImagesOptions) {
    this.options = options;
  }

  private get file() {
    return join(this.options.dataDir, SETTINGS_FILE);
  }

  private read(): Settings | null {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Settings>;
      if (saved.version !== 1) return null;
      return {
        version: 1,
        accountId: String(saved.accountId ?? ""),
        accessKeyId: String(saved.accessKeyId ?? ""),
        secretAccessKey: String(saved.secretAccessKey ?? ""),
        bucket: String(saved.bucket ?? ""),
        publicBaseUrl: String(saved.publicBaseUrl ?? ""),
        keyPrefix: String(saved.keyPrefix ?? ""),
        updatedAt: Number(saved.updatedAt ?? 0),
      };
    } catch {
      return null;
    }
  }

  /** Readable only by this user, written whole or not at all. */
  private write(settings: Settings) {
    mkdirSync(this.options.dataDir, { recursive: true });
    const temporary = `${this.file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }

  /** The settings without the secret. */
  view(): ImageUploadView {
    const saved = this.read();
    return {
      configured: Boolean(saved && !validate(saved)),
      accountId: saved?.accountId ?? "",
      accessKeyHint: saved?.accessKeyId ? hint(saved.accessKeyId) : null,
      secretSet: Boolean(saved?.secretAccessKey),
      bucket: saved?.bucket ?? "",
      publicBaseUrl: saved?.publicBaseUrl ?? "",
      keyPrefix: saved?.keyPrefix ?? "",
      updatedAt: saved?.updatedAt ?? null,
    };
  }

  /** The saved settings with what the form changed; an empty secret or access key keeps the saved one. */
  private merge(input: Input): Omit<Settings, "version" | "updatedAt"> {
    const saved = this.read();
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    const account = input.accountId === undefined ? { accountId: saved?.accountId ?? "", bucket: null } : parseAccount(text(input.accountId));
    return {
      accountId: account.accountId,
      accessKeyId: text(input.accessKeyId) || saved?.accessKeyId || "",
      secretAccessKey: text(input.secretAccessKey) || saved?.secretAccessKey || "",
      bucket: (input.bucket === undefined ? (saved?.bucket ?? "") : text(input.bucket)) || account.bucket || "",
      publicBaseUrl: input.publicBaseUrl === undefined ? (saved?.publicBaseUrl ?? "") : text(input.publicBaseUrl) ? normalizePublicUrl(text(input.publicBaseUrl)) : "",
      keyPrefix: input.keyPrefix === undefined ? (saved?.keyPrefix ?? "") : normalizePrefix(text(input.keyPrefix)),
    };
  }

  save(input: Input): ImageUploadView {
    const merged = this.merge(input);
    const problem = validate(merged);
    if (problem) throw new HttpError(400, "invalid_settings", problem);
    this.write({ version: 1, ...merged, updatedAt: Date.now() });
    return this.view();
  }

  clear(): ImageUploadView {
    rmSync(this.file, { force: true });
    return this.view();
  }

  private publicUrl(settings: Pick<Settings, "publicBaseUrl">, key: string) {
    return `${settings.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** One signed request to the bucket's S3 API. */
  private async s3(settings: Omit<Settings, "version" | "updatedAt">, method: "PUT" | "DELETE", key: string, body?: Buffer, extra: Record<string, string> = {}) {
    const endpoint = new URL(this.options.endpoint || `https://${settings.accountId}.r2.cloudflarestorage.com`);
    const path = `/${settings.bucket}/${key}`;
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
    const headers: Record<string, string> = { host: endpoint.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate(new Date()), ...extra };
    const { authorization } = signV4({
      method,
      path,
      headers,
      payloadHash,
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      region: R2_REGION,
      service: "s3",
    });
    // fetch sends the same Host itself.
    const { host: _host, ...sent } = headers;
    let response: Response;
    try {
      response = await fetch(`${endpoint.origin}${encodePath(path)}`, {
        method,
        headers: { ...sent, authorization },
        body: body ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new R2Error(0, "network", networkMessage(error));
    }
    if (!response.ok) {
      const xml = await response.text().catch(() => "");
      const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] ?? "";
      throw new R2Error(response.status, code, r2Message(response.status, code, settings.bucket));
    }
    await response.arrayBuffer().catch(() => undefined);
    return response;
  }

  /** "연결 확인": the keys can write, the public address shows what was written, and it is removed again. */
  async check(input: Input = {}): Promise<ImageUploadCheck> {
    let settings: Omit<Settings, "version" | "updatedAt">;
    try {
      settings = this.merge(input);
    } catch (error) {
      return { ok: false, steps: [{ step: "settings", ok: false, message: error instanceof Error ? error.message : String(error) }] };
    }
    const problem = validate(settings);
    if (problem) return { ok: false, steps: [{ step: "settings", ok: false, message: problem }] };
    const steps: ImageUploadCheck["steps"] = [];
    const key = `${settings.keyPrefix}.workbench-check-${randomBytes(6).toString("hex")}.txt`;
    const body = Buffer.from(`Achmage Workbench 연결 확인 ${new Date().toISOString()}\n`);
    try {
      await this.s3(settings, "PUT", key, body, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      steps.push({ step: "upload", ok: true, message: `키로 버킷 ${settings.bucket}에 올렸습니다.` });
    } catch (error) {
      steps.push({ step: "upload", ok: false, message: error instanceof Error ? error.message : String(error) });
      return { ok: false, steps };
    }
    const url = this.publicUrl(settings, key);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const same = response.ok && Buffer.from(await response.arrayBuffer()).equals(body);
      steps.push(
        same
          ? { step: "public", ok: true, message: "공개 주소에서 열립니다." }
          : {
              step: "public",
              ok: false,
              message: `공개 주소에서 열리지 않습니다(HTTP ${response.status}). 버킷의 공개 접근(r2.dev)을 켰는지, 연결한 도메인이 이 버킷인지 확인해 주세요.`,
            },
      );
    } catch (error) {
      steps.push({ step: "public", ok: false, message: `공개 주소에 연결하지 못했습니다: ${new URL(url).host}${error instanceof Error && error.name === "TimeoutError" ? " (시간 초과)" : ""}` });
    }
    try {
      await this.s3(settings, "DELETE", key);
      steps.push({ step: "cleanup", ok: true, message: "확인용 파일을 지웠습니다." });
    } catch (error) {
      steps.push({ step: "cleanup", ok: false, message: `확인용 파일(${key})을 지우지 못했습니다: ${error instanceof Error ? error.message : String(error)}` });
    }
    return { ok: steps.every((step) => step.ok || step.step === "cleanup"), steps };
  }

  /** The folder whose images a document may show: its work folder, or its own folder when it lives elsewhere. */
  private rootOf(artifact: Artifact) {
    const cwd = resolve(this.options.workCwd(artifact.workId));
    const doc = resolve(artifact.path);
    return within(cwd, doc) ? cwd : dirname(doc);
  }

  private markdownDoc(artifactId: string) {
    const artifact = this.options.documents.get(artifactId);
    if (artifact.format !== "markdown") throw new HttpError(415, "not_markdown", "그림 링크는 마크다운 문서에만 넣습니다.");
    return artifact;
  }

  /** Keep the image in the work folder's assets/ (named by its content) and link it from the document. */
  private saveLocal(artifact: Artifact, data: Buffer, name: string) {
    const root = this.rootOf(artifact);
    const folder = join(root, "assets");
    try {
      mkdirSync(folder, { recursive: true });
    } catch {
      throw new HttpError(500, "assets_folder", "작업 폴더에 assets 폴더를 만들지 못했습니다.");
    }
    if (!within(realpathSync(root), realpathSync(folder))) throw new HttpError(403, "outside", "assets 폴더가 작업 폴더 밖을 가리켜 저장하지 않았습니다.");
    const target = join(folder, name);
    if (!existsSync(target)) {
      try {
        writeFileSync(target, data, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return relative(dirname(artifact.path), target).split(sep).join("/");
  }

  /** An image for a Markdown document: uploaded to R2 when set up, otherwise (or when that fails) kept in the work folder. */
  async upload(artifactId: string, data: Buffer, name: string): Promise<DocImageResult> {
    const artifact = this.markdownDoc(artifactId);
    if (!data.length) throw new HttpError(400, "image_empty", "빈 그림입니다.");
    const type = imageType(data);
    if (!type) throw new HttpError(415, "image_type", "그림 파일(PNG·JPG·GIF·WebP·AVIF·BMP·SVG)만 넣을 수 있습니다.");
    const file = `${sha256Hex(data).slice(0, 16)}${type.ext}`;
    const alt = altText(name);
    const settings = this.read();
    let fallback: string | undefined;
    if (settings && !validate(settings)) {
      const key = `${settings.keyPrefix}${file}`;
      try {
        // Named by content, so the object never changes: it may be cached for good.
        await this.s3(settings, "PUT", key, data, { "content-type": type.mime, "cache-control": "public, max-age=31536000, immutable" });
        const url = this.publicUrl(settings, key);
        return { markdown: `![${alt}](${url})`, url, alt, stored: "r2" };
      } catch (error) {
        fallback = error instanceof Error ? error.message : String(error);
      }
    }
    const url = this.saveLocal(artifact, data, file);
    return { markdown: `![${alt}](${url})`, url, alt, stored: "local", ...(fallback ? { fallback } : {}) };
  }

  /** The file behind an image of a Markdown document, for its preview. */
  image(artifactId: string, src: string) {
    const artifact = this.markdownDoc(artifactId);
    return resolveDocImage(this.rootOf(artifact), artifact.path, src);
  }

  isMarkdown(artifactId: string) {
    return this.options.documents.get(artifactId).format === "markdown";
  }
}

async function readInput(req: IncomingMessage): Promise<Input> {
  const body = await readBody(req, 100_000);
  try {
    const parsed = body.length ? (JSON.parse(body.toString("utf8")) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Input) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "JSON 형식이 아닙니다.");
  }
}

const decodedName = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * The gateway's routes for pictures in documents (after its token check): the R2 settings and
 * "연결 확인", an image pasted into a Markdown document, the pictures its preview shows, and the
 * desktop clipboard's picture for a paste the page cannot see. False for any other request.
 */
export async function routeDocImages(images: DocImages, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  const [, scope, id, action] = path.split("/").filter(Boolean);
  if (path === "/api/clipboard/picture" && method === "GET") {
    const picture = await clipboardPicture();
    res.writeHead(picture ? 200 : 204, { "cache-control": "no-store", "x-content-type-options": "nosniff", ...(picture ? { "content-type": picture.type } : {}) });
    res.end(picture?.data);
    return true;
  }
  if (path === "/api/image-upload" || path === "/api/image-upload/check") {
    const answer =
      path.endsWith("/check") && method === "POST"
        ? await images.check(await readInput(req))
        : method === "GET"
          ? images.view()
          : method === "PUT"
            ? images.save(await readInput(req))
            : method === "DELETE"
              ? images.clear()
              : null;
    if (!answer) return false;
    sendJson(res, 200, answer);
    return true;
  }
  if (scope !== "artifacts" || !id) return false;
  if (action === "images" && method === "POST") {
    const data = await readBody(req, 50_000_000);
    sendJson(res, 201, await images.upload(id, data, decodedName(String(req.headers["x-file-name"] ?? ""))));
    return true;
  }
  // Designs keep their own asset route (artifacts.ts); Markdown pictures come from the work folder.
  if (action === "asset" && method === "GET" && images.isMarkdown(id)) {
    const image = images.image(id, url.searchParams.get("src") ?? "");
    res.writeHead(200, {
      "content-type": image.type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    });
    createReadStream(image.file).pipe(res);
    return true;
  }
  return false;
}
