import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BUILT_IN_IMAGE_TEMPLATES,
  PROVIDER_LABEL,
  assembleImagePrompt,
  drawingInstruction,
  imageFileName,
  isImageAspect,
  type CreateSessionRequest,
  type DrawRequest,
  type DrawResult,
  type ImageInfo,
  type ImageTemplate,
  type ImageTemplates,
  type RequestDraw,
  type SendResult,
  type Session,
  type TranscriptItem,
  type Work,
} from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import type { EngineImage } from "./providers/types.ts";

// "그림": pictures drawn with GPT Image through Codex's built-in image tool, on the user's ChatGPT
// login (no API key). A drawing is one Codex turn told to call the tool once with a prompt built
// from a template, the request and standing rules. Codex saves the picture under its own home;
// the gateway copies it into the work folder (images/<date>-<slug>.png) and shows it as a card in
// the conversation that asked — also when that is a Claude conversation, which draws through a
// Codex session of the same work.

/** What drawing needs from the session manager (sessions.ts wires it). */
export type ImageHost = {
  session(id: string): Session | undefined;
  work(id: string): Work | undefined;
  sessions(): Session[];
  /** A new session that does not become the one the work shows. */
  createSession(workId: string, request: CreateSessionRequest): Session;
  /** A request whose engine text (the drawing instructions) differs from what the conversation shows. */
  send(sessionId: string, requestId: string, text: string, from: { sessionId: string; label: string } | null, options: { engineText: string; draw: RequestDraw }): Promise<SendResult>;
  upsertItem(sessionId: string, item: TranscriptItem): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
};

export type ImageKind = "png" | "jpg" | "webp" | "gif";

export const IMAGE_MIME: Record<ImageKind, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

const EXTENSIONS: Record<string, ImageKind> = { ".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".webp": "webp", ".gif": "gif" };

const JOBS_KEY = "imagegen.jobs";
const MAX_JOBS = 300;
const MAX_IMAGE_BYTES = 60_000_000;
/** Name of the Codex session that draws for a work's Claude conversations. */
export const HELPER_PURPOSE = "그림";

/** What the bytes are, by their first bytes (never by a name an engine chose). */
export function sniffImage(data: Buffer): ImageKind | null {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (data.length >= 10 && data.toString("latin1", 0, 4) === "GIF8") return "gif";
  return null;
}

/** Pixel size from the file header (no decoding). */
export function imageSize(data: Buffer, kind: ImageKind): { width: number; height: number } | null {
  try {
    if (kind === "png") return data.length >= 24 ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : null;
    if (kind === "gif") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (kind === "webp") {
      const chunk = data.toString("latin1", 12, 16);
      if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = data.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    // JPEG: the first start-of-frame segment.
    let at = 2;
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = data[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      }
      at += 2 + data.readUInt16BE(at + 2);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The picture's bytes: the file Codex saved (under its own home) when it is there and is an image,
 * else the base64 data it sent with the item (bare or as a data URL).
 */
export function engineImageBytes(image: Pick<EngineImage, "result" | "savedPath">): { data: Buffer; kind: ImageKind; source: "savedPath" | "result" } | null {
  if (image.savedPath && isAbsolute(image.savedPath)) {
    try {
      if (statSync(image.savedPath).size <= MAX_IMAGE_BYTES) {
        const data = readFileSync(image.savedPath);
        const kind = sniffImage(data);
        if (kind) return { data, kind, source: "savedPath" };
      }
    } catch {
      // Gone or unreadable: the data sent with the item is the other copy.
    }
  }
  const raw = image.result?.trim();
  if (raw) {
    const base64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
    if (/^[A-Za-z0-9+/=_-]+$/.test(base64.slice(0, 400).replace(/\s+/g, ""))) {
      const data = Buffer.from(base64, "base64");
      const kind = data.length <= MAX_IMAGE_BYTES ? sniffImage(data) : null;
      if (kind) return { data, kind, source: "result" };
    }
  }
  return null;
}

/** A free file in `<cwd>/images/`: `<date>-<slug>.<ext>`, then `-2`, `-3`, … (never overwrites). */
export function reserveImagePath(cwd: string, brief: string, at: number, kind: ImageKind) {
  const folder = join(cwd, "images");
  const name = imageFileName(brief, at, kind);
  const stem = name.slice(0, -(kind.length + 1));
  let path = join(folder, name);
  for (let index = 2; existsSync(path); index += 1) {
    if (index > 999) throw new HttpError(409, "name_taken", "같은 이름의 그림이 너무 많습니다.");
    path = join(folder, `${stem}-${index}.${kind}`);
  }
  return path;
}

/** A drawing request from the HTTP body, every field checked. */
export function parseDrawRequest(body: Record<string, unknown>): DrawRequest {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    requestId: text(body.requestId) ?? "",
    brief: typeof body.brief === "string" ? body.brief : "",
    templateId: text(body.templateId),
    aspect: isImageAspect(body.aspect) ? body.aspect : "auto",
    transparent: body.transparent === true,
    via: text(body.via),
    insertInto: text(body.insertInto),
  };
}

/** The user's own templates and rules, kept clean; `strict` rejects what it would otherwise drop. */
export function cleanTemplates(value: unknown, strict: boolean): { templates: ImageTemplate[]; rules: string } {
  const fail = (message: string) => {
    if (strict) throw new HttpError(400, "invalid_templates", message);
  };
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const builtIn = new Set(BUILT_IN_IMAGE_TEMPLATES.map((template) => template.id));
  const templates: ImageTemplate[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(record.templates) ? record.templates : []) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (raw.builtIn === true || (typeof raw.id === "string" && builtIn.has(raw.id))) continue;
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    if (!name || !prompt) {
      fail("템플릿에는 이름과 내용이 있어야 합니다.");
      continue;
    }
    if (prompt.length > 4000) {
      fail(`템플릿 「${name}」이(가) 너무 깁니다(4000자까지).`);
      continue;
    }
    let id = typeof raw.id === "string" && /^[\w-]{1,60}$/.test(raw.id) ? raw.id : "";
    if (!id || ids.has(id)) id = `tpl-${randomBytes(5).toString("hex")}`;
    ids.add(id);
    templates.push({ id, name, prompt });
  }
  if (templates.length > 50) {
    fail("템플릿은 50개까지 둘 수 있습니다.");
    templates.length = 50;
  }
  let rules = typeof record.rules === "string" ? record.rules.trim() : "";
  if (rules.length > 2000) {
    fail("항상 붙일 규칙이 너무 깁니다(2000자까지).");
    rules = rules.slice(0, 2000);
  }
  return { templates, rules };
}

function failureText(failure: EngineImage["failure"]) {
  if (failure?.type === "usageLimitExceeded") {
    const resets = failure.resetsAt ? (failure.resetsAt < 1e12 ? failure.resetsAt * 1000 : failure.resetsAt) : null;
    const when = resets ? ` ${new Date(resets).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}부터 다시 그릴 수 있습니다.` : "";
    return `이미지 생성 한도를 다 써서 그리지 못했습니다.${when}`;
  }
  return "Codex가 그림을 그리지 못했습니다.";
}

const firstLine = (text: string | null) => (text?.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 80);

export class ImageGen {
  private readonly host: ImageHost;
  private readonly templatesFile: string;
  private readonly jobs = new Map<string, ImageInfo>();
  /** workId -> the Codex session that draws for the work's Claude conversations */
  private readonly helpers = new Map<string, string>();
  /** Codex session -> the drawing its running turn is for */
  private readonly turns = new Map<string, string>();
  /** Image items of the engine already taken (a repeated notification draws no second card) */
  private readonly handled = new Set<string>();

  constructor(host: ImageHost, dataDir: string) {
    this.host = host;
    this.templatesFile = join(dataDir, "image-templates.json");
    try {
      const saved = JSON.parse(host.getMeta(JOBS_KEY) ?? "null") as { jobs?: ImageInfo[]; helpers?: Record<string, string> } | null;
      for (const job of saved?.jobs ?? []) this.jobs.set(job.id, job);
      for (const [workId, sessionId] of Object.entries(saved?.helpers ?? {})) this.helpers.set(workId, sessionId);
    } catch {
      // A damaged record starts over; the pictures stay in the work folders and conversations.
    }
  }

  /** After a restart nothing is drawing any more: both cards say so. */
  recover() {
    for (const job of [...this.jobs.values()]) {
      if (job.status === "drawing") this.finish(job.id, { status: "failed", error: "앱이 다시 시작되어 그림을 받지 못했습니다. 다시 그려 주세요." });
    }
  }

  /** Built-in templates, then the user's own (kept in the gateway's data folder), and the standing rules. */
  templates(): ImageTemplates {
    let saved = { templates: [] as ImageTemplate[], rules: "" };
    try {
      saved = cleanTemplates(JSON.parse(readFileSync(this.templatesFile, "utf8")), false);
    } catch {
      // No file yet, or one that cannot be read: built-ins only.
    }
    return { templates: [...BUILT_IN_IMAGE_TEMPLATES, ...saved.templates], rules: saved.rules };
  }

  /** Replace the user's templates and rules (built-ins are not stored and cannot be changed). */
  saveTemplates(value: unknown): ImageTemplates {
    const clean = cleanTemplates(value, true);
    const temporary = `${this.templatesFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...clean }, null, 2)}\n`);
    renameSync(temporary, this.templatesFile);
    return this.templates();
  }

  get(id: string): ImageInfo {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, "image_not_found", "그림을 찾지 못했습니다.");
    return job;
  }

  /**
   * Draw: Codex conversations draw themselves; Claude conversations through the work's drawing
   * session (or the Codex session the user picked). The card shows in the conversation that asked
   * at once, and in the drawing session after its request.
   */
  async draw(originId: string, request: DrawRequest): Promise<DrawResult> {
    const origin = this.host.session(originId);
    if (!origin) throw new HttpError(404, "session_not_found", "세션을 찾지 못했습니다.");
    const id = request.requestId.trim();
    const brief = request.brief.trim();
    if (!id) throw new HttpError(400, "missing_request_id", "requestId가 필요합니다.");
    if (!brief) throw new HttpError(400, "empty_brief", "무엇을 그릴지 적어 주세요.");
    if (brief.length > 4000) throw new HttpError(413, "brief_too_long", "그릴 내용이 너무 깁니다(4000자까지).");
    const existing = this.jobs.get(id);
    if (existing) {
      if (existing.originSessionId !== originId || existing.brief !== brief) throw new HttpError(409, "request_id_conflict", "같은 requestId로 다른 그림을 요청했습니다.");
      return { duplicate: true, image: existing };
    }
    const work = this.host.work(origin.workId);
    if (!work) throw new HttpError(404, "work_not_found", "작업을 찾지 못했습니다.");
    const { templates, rules } = this.templates();
    const template = request.templateId ? templates.find((entry) => entry.id === request.templateId) : null;
    if (request.templateId && !template) throw new HttpError(404, "template_not_found", "그림 템플릿을 찾지 못했습니다.");
    const aspect = isImageAspect(request.aspect) ? request.aspect : "auto";
    const transparent = Boolean(request.transparent);
    const drawer = this.drawerFor(origin, work, request.via ?? null);
    const prompt = assembleImagePrompt({ brief, template, rules, aspect });
    const info: ImageInfo = {
      id,
      workId: work.id,
      originSessionId: origin.id,
      drawSessionId: drawer.id,
      status: "drawing",
      brief,
      template: template?.name ?? null,
      aspect,
      transparent,
      prompt,
      revisedPrompt: null,
      path: null,
      relPath: null,
      width: null,
      height: null,
      bytes: null,
      insertInto: request.insertInto ?? null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.save(info);
    this.turns.set(drawer.id, id);
    if (drawer.id !== origin.id) this.host.upsertItem(origin.id, this.item(info));
    const from = drawer.id !== origin.id ? { sessionId: origin.id, label: `${work.title} · ${origin.purpose} (${PROVIDER_LABEL[origin.provider]})` } : null;
    try {
      const sent = await this.host.send(drawer.id, id, brief, from, { engineText: drawingInstruction({ prompt, transparent }), draw: { template: info.template, aspect } });
      if (sent.duplicate) throw new HttpError(409, "request_id_conflict", "같은 요청을 이미 보냈습니다.");
    } catch (error) {
      this.turns.delete(drawer.id);
      this.finish(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const after = this.host.session(drawer.id);
    if (after?.status === "error" && this.jobs.get(id)?.status === "drawing") {
      this.turns.delete(drawer.id);
      this.finish(id, { status: "failed", error: `Codex에 보내지 못했습니다${after.lastError ? `: ${after.lastError}` : "."}` });
    } else {
      // The picture may already be in (a quick engine): show what the drawing is now.
      this.publish(this.jobs.get(id)!);
    }
    return { duplicate: false, image: this.jobs.get(id)! };
  }

  private drawerFor(origin: Session, work: Work, via: string | null): Session {
    const codex = this.host.sessions().filter((session) => session.workId === work.id && session.provider === "codex" && !session.archivedAt);
    const free = (session: Session) => session.status === "idle" || session.status === "error";
    if (via === "new") return this.newHelper(work);
    if (via) {
      const chosen = codex.find((session) => session.id === via);
      if (!chosen) throw new HttpError(404, "draw_session_not_found", "그릴 Codex 세션을 찾지 못했습니다.");
      if (!free(chosen)) throw new HttpError(409, "session_busy", `Codex 세션 「${chosen.purpose}」이(가) 일하는 중입니다. 끝난 뒤에 그리거나 다른 세션을 고르세요.`);
      return chosen;
    }
    if (origin.provider === "codex") {
      if (!free(origin)) throw new HttpError(409, "session_busy", "Codex가 일하는 중입니다. 끝난 뒤에 그리거나, 그림 메뉴에서 다른 Codex 세션을 고르세요.");
      return origin;
    }
    // Claude cannot draw: the work's drawing session does, apart from Codex conversations about other things.
    const helper = codex.find((session) => session.id === this.helpers.get(work.id)) ?? codex.findLast((session) => session.purpose === HELPER_PURPOSE);
    if (!helper) return this.newHelper(work);
    if (!free(helper)) throw new HttpError(409, "session_busy", "Codex가 앞선 그림을 그리는 중입니다. 끝나면 다시 보내거나, 그림 메뉴에서 다른 Codex 세션을 고르세요.");
    return helper;
  }

  private newHelper(work: Work) {
    const session = this.host.createSession(work.id, { provider: "codex", purpose: HELPER_PURPOSE });
    this.helpers.set(work.id, session.id);
    this.persist();
    return session;
  }

  /** Codex finished a picture: copy it into the work folder and show it in both conversations. */
  onEngineImage(sessionId: string, image: EngineImage) {
    const session = this.host.session(sessionId);
    const work = session ? this.host.work(session.workId) : undefined;
    if (!session || !work || this.handled.has(image.id)) return;
    this.handled.add(image.id);
    const jobId = this.turns.get(sessionId);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    let info = job?.status === "drawing" ? job : null;
    if (!info) {
      // A second picture of the same turn, or one Codex drew on its own when asked in words.
      info = {
        id: `codex:${image.id}`,
        workId: work.id,
        originSessionId: job?.originSessionId ?? sessionId,
        drawSessionId: sessionId,
        status: "drawing",
        brief: job?.brief ?? (firstLine(image.revisedPrompt) || "Codex가 그린 그림"),
        template: job?.template ?? null,
        aspect: job?.aspect ?? "auto",
        transparent: job?.transparent ?? false,
        prompt: job?.prompt ?? image.revisedPrompt ?? "",
        revisedPrompt: null,
        path: null,
        relPath: null,
        width: null,
        height: null,
        bytes: null,
        insertInto: null,
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      };
      this.save(info);
    }
    if (image.failure || image.status === "failed") {
      this.finish(info.id, { status: "failed", error: failureText(image.failure), revisedPrompt: image.revisedPrompt });
      return;
    }
    const bytes = engineImageBytes(image);
    if (!bytes) {
      this.finish(info.id, { status: "failed", error: "Codex가 보낸 그림 파일을 받지 못했습니다.", revisedPrompt: image.revisedPrompt });
      return;
    }
    try {
      mkdirSync(join(work.cwd, "images"), { recursive: true });
      const path = reserveImagePath(work.cwd, info.brief, Date.now(), bytes.kind);
      writeFileSync(path, bytes.data, { flag: "wx" });
      const size = imageSize(bytes.data, bytes.kind);
      this.finish(info.id, {
        status: "done",
        path,
        relPath: relative(work.cwd, path),
        width: size?.width ?? null,
        height: size?.height ?? null,
        bytes: bytes.data.length,
        revisedPrompt: image.revisedPrompt,
        error: null,
      });
    } catch (error) {
      this.finish(info.id, { status: "failed", error: `그림을 작업 폴더에 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** The drawing turn ended: without a picture the card says why. */
  afterTurn(sessionId: string, status: "completed" | "interrupted" | "failed") {
    const jobId = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job || job.status !== "drawing") return;
    this.finish(job.id, {
      status: "failed",
      error:
        status === "interrupted"
          ? "멈춰서 그림을 그리지 않았습니다."
          : status === "failed"
            ? "응답이 끝나지 못해 그림을 받지 못했습니다."
            : "Codex가 그림 없이 답을 마쳤습니다. Codex의 답을 확인해 주세요.",
    });
  }

  /** A picture file inside a work folder (only raster images, never outside the folder). */
  file(workId: string, raw: string) {
    const work = this.host.work(workId);
    if (!work) throw new HttpError(404, "work_not_found", "작업을 찾지 못했습니다.");
    if (!raw.trim()) throw new HttpError(400, "missing_path", "그림 경로가 필요합니다.");
    const path = isAbsolute(raw) ? raw : resolve(work.cwd, raw);
    const kind = EXTENSIONS[extname(path).toLowerCase()];
    if (!kind) throw new HttpError(415, "not_image", "그림 파일(png·jpg·webp·gif)만 열 수 있습니다.");
    let real: string;
    let root: string;
    try {
      real = realpathSync(path);
      root = realpathSync(work.cwd);
    } catch {
      throw new HttpError(404, "file_missing", "그림 파일이 없습니다.");
    }
    if (real !== root && !real.startsWith(root + sep)) throw new HttpError(403, "outside", "작업 폴더 밖의 파일은 열 수 없습니다.");
    if (!statSync(real).isFile()) throw new HttpError(404, "file_missing", "그림 파일이 없습니다.");
    return { path: real, type: IMAGE_MIME[kind] };
  }

  private item(info: ImageInfo): TranscriptItem {
    return { kind: "image", id: `image:${info.id}`, image: info, at: info.createdAt };
  }

  /** The card in the drawing session and, when another conversation asked, there too. */
  private publish(info: ImageInfo) {
    for (const sessionId of new Set([info.drawSessionId, info.originSessionId])) {
      if (this.host.session(sessionId)) this.host.upsertItem(sessionId, this.item(info));
    }
  }

  private finish(id: string, patch: Partial<ImageInfo>) {
    const job = this.jobs.get(id);
    if (!job) return;
    const next: ImageInfo = { ...job, ...patch, finishedAt: Date.now() };
    this.save(next);
    this.publish(next);
  }

  private save(info: ImageInfo) {
    this.jobs.set(info.id, info);
    this.persist();
  }

  private persist() {
    if (this.jobs.size > MAX_JOBS) {
      const keep = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_JOBS);
      this.jobs.clear();
      for (const job of keep) this.jobs.set(job.id, job);
    }
    this.host.setMeta(JOBS_KEY, JSON.stringify({ jobs: [...this.jobs.values()], helpers: Object.fromEntries(this.helpers) }));
  }
}
