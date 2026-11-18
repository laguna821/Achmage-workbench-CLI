/**
 * 불러오기 / 내보내기 — deterministic Hangul conversion the HanMark way (0.5.5; design:
 * ux/reports/hanmark-study.md § 3). A button, not a model: the gateway runs the ONE kordoc of the app —
 * the bundled hallym-kordoc skill's core runner (core/scripts/run.mjs, kordoc 4.18.13) — with
 * KORDOC_OFFLINE=1; HanMark's own code (apps/host/src/hanmark/, MIT © laguna821) cleans the Markdown,
 * resolves pictures and names the presets. Same input, preset and template → the same bytes (the core's
 * finalize writes a fixed ZIP order and 1980-01-01 dates); no model, no OCR, no network at run time.
 *
 *  불러오기  HWP/HWPX/DOCX/XLSX/XLS (PDF only when its extension ships, below) → `{stem}.md` beside the
 *           original (a free name), pictures as files in `{stem}.assets/` with relative links; the
 *           original is never changed; the link lives in the new document's record (`derivedFrom` +
 *           `convertedFrom`), not in its body.
 *  내보내기  a Markdown document → a NEW .hwpx (core generate / template-apply), .hwp (that HWPX saved by
 *           the one rhwp engine through the save checks, hwp-ops.mjs hwpxToHwp) or .docx (the Ieum CLI's
 *           md → docx), beside the source, never over a file.
 *
 * The owner has not answered the study's four questions; the recommended answers are built, each behind
 * ONE constant here so it can be flipped.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Artifact, ArtifactRevision } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { findKordocRunner, kordocVersion } from "./kordoc.ts";
import { repoRoot, shipped } from "./resources.ts";
import { adaptMarkdownForKordoc } from "./hanmark/markdownAdapter.ts";
import { resolveMarkdownImages, rewriteMarkdownForResolvedImages } from "./hanmark/imageAssets.ts";
import { rewriteImportedImageReference } from "./hanmark/imageLinks.ts";
import { DEFAULT_IMPORT_OPTIONS, IMPORT_PRESET_IDS, IMPORT_PRESET_LABELS, normalizeImportPreset, normalizePageRange, toParseOptions, type ImportPresetId } from "./hanmark/importOptions.ts";
import { describeImportFailure, describeImportWarning } from "./hanmark/messageCatalog.ts";
import { builtInDocumentStyleProfile, DOCUMENT_STYLE_PRESET_LABELS } from "./hanmark/documentStylePresets.ts";
import { t } from "./hanmark/i18n.ts";
import { LEGACY_TARGET, convertLegacy, isLegacyKind, legacyLine, lossLedger, wordToHangul, type ConvertWorker, type LossLedger } from "./office-convert.ts";

// ---- The four open questions: the recommended answers, one constant each -------------------------

/** Q1 Imported pictures: a `{stem}.assets/` folder beside the new note (moves with it, no name clashes). */
export const IMPORT_PICTURE_FOLDER = (stem: string) => `${stem}.assets`;
/** Q2 Tables: kordoc's readable default `visual` for 기본 (and the others); `keep` (structure, forms) in 서식 문서. */
export const IMPORT_TABLE_MODE: Readonly<Record<ImportPresetId, "visual" | "keep">> = { default: "visual", text: "visual", form: "keep", exam: "visual" };
/** Q3 A general "한글 문서 만들기" (and 내보내기) uses the 기본 template unless the person picks another. */
export const GENERAL_DEFAULT_TEMPLATE = "builtin:kordoc-default";
/**
 * Q4 PDF import ships only if the core's `pdf` extension adds ≤ 30 MB. Measured 2026-11-18 (the core's
 * own `npm ci --ignore-scripts` from its lock, linux-x64): 82,127,441 bytes (pdfjs-dist 37 MB,
 * @napi-rs/canvas 32 MB, @hyzyla/pdfium 11 MB) → not shipped; 불러오기 says so in one line. `true` uses a
 * folder prepared by scripts/fetch-kordoc-pdf.mjs (shipped `kordoc-ext/`, or the source checkout's).
 */
export const SHIP_PDF_EXTENSION = false;
export const PDF_NOT_SHIPPED = "PDF 불러오기는 이 버전에 들어 있지 않습니다(필요한 PDF 구성 요소가 78 MB라 앱에 넣지 않았습니다). 한글·워드·엑셀 파일은 불러올 수 있습니다.";

/** What 불러오기 reads (kordoc detects the real format by content). */
export const IMPORT_EXTENSIONS = ["hwp", "hwpx", "docx", "pdf", "xlsx", "xls"] as const;
export const importable = (path: string) => (IMPORT_EXTENSIONS as readonly string[]).includes(extname(path).slice(1).toLowerCase());

const CORE_TIMEOUT_MS = 180_000;
const IMPORT_MAX_BYTES = 200 * 1024 * 1024;

// ---- Templates ------------------------------------------------------------------------------------

/** HanMark's 공문서 types (the core's presets; HanMark's names). Cover dates are frozen from the request. */
export const GONGMUN_PRESETS = [
  { id: "official", label: "기안문·시행문" }, { id: "report", label: "보고서" }, { id: "plan", label: "계획서" },
  { id: "notice", label: "통지·안내" }, { id: "minutes", label: "회의록" }, { id: "gaejosik", label: "정부 표준 개조식" },
  { id: "press", label: "보도자료" }, { id: "ministry", label: "업무보고" },
] as const;
const COVER_DATE_PRESETS = new Set(["gaejosik", "ministry"]);

export type HangulTemplate = { id: string; label: string; group: "기본 서식" | "내 양식" | "공문서" };
const BUILTINS = [
  { id: "builtin:kordoc-default", label: "기본" },
  { id: "builtin:korean-communication", label: DOCUMENT_STYLE_PRESET_LABELS["korean-communication"] },
  { id: "builtin:youth-studies", label: DOCUMENT_STYLE_PRESET_LABELS["youth-studies"] },
];

/** Sorted-key JSON, as the core hashes a TemplatePack (templates.mjs `stable`). */
const stable = (value: unknown) => JSON.stringify(value, (_key, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, (x as Record<string, unknown>)[key]])) : x));
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** A TemplatePack v1 carrying one of HanMark's built-in style presets (the owner's own), for template-apply. */
export function builtinPack(id: "korean-communication" | "youth-studies", engine: { name?: string; version: string; commit?: string }) {
  const documentStyle = builtInDocumentStyleProfile(id)!;
  const pack: Record<string, unknown> = {
    kind: "kordoc-template-pack", schemaVersion: 1, id: `hanmark-${id}`, version: "2.7.0", name: documentStyle.name,
    source: { name: documentStyle.sourceName ?? documentStyle.name, sha256: sha256(stable(documentStyle)), format: "hanmark-style-preset" },
    engine, markdownSkeleton: "", fields: [], tableRules: [], assets: [], evidence: [{ authority: "hanmark-preset", source: "HanMark 2.7.0 src/io/documentStylePresets.ts" }],
    limitations: ["Named styles (바탕글, 제목 1–6) and page only; covers, headers and footers of the source template are not cloned."], documentStyle,
  };
  pack.contentHash = sha256(stable(pack));
  return pack;
}

// ---- The core runner ----------------------------------------------------------------------------

export type CoreResult = {
  status: "success" | "partial" | "failed"; success: boolean;
  engine?: { name?: string; version: string; commit?: string };
  files?: { path: string; bytes?: number }[];
  warnings?: { code?: string; message: string; page?: number }[];
  data?: Record<string, unknown>;
  failure?: { code: string; message: string } | null;
};

/** The prepared PDF extension folder (KORDOC_WORKBENCH_CACHE), when it ships and is ready. */
export function pdfExtensionCache(): string | null {
  if (!SHIP_PDF_EXTENSION) return null;
  const root = repoRoot();
  for (const dir of [shipped("kordoc-ext"), root ? join(root, "apps/desktop/src-tauri/kordoc-ext") : null]) {
    if (dir && existsSync(join(dir, `${process.platform}-${process.arch}`, "pdf", ".ready"))) return dir;
  }
  return null;
}

/**
 * One request to the core runner on stdin (a password never touches the disk), one JSON on stdout.
 * Offline always; a fresh temporary folder per call (removed by the caller).
 */
export function runCore(runner: string, request: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal; timeoutMs?: number }): Promise<CoreResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) { reject(new HttpError(409, "convert_cancelled", "변환을 취소했습니다.")); return; }
    const cache = pdfExtensionCache();
    const child = spawn(process.execPath, [runner], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, KORDOC_OFFLINE: "1", ...(cache ? { KORDOC_WORKBENCH_CACHE: cache } : {}) } });
    const out: Buffer[] = [];
    let size = 0, err = "";
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, options.timeoutMs ?? CORE_TIMEOUT_MS);
    options.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 900_000_000) out.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (err.length < 4000) err += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", kill);
      if (options.signal?.aborted) { reject(new HttpError(409, "convert_cancelled", "변환을 취소했습니다.")); return; }
      try { resolvePromise(JSON.parse(Buffer.concat(out).toString("utf8")) as CoreResult); }
      catch { reject(new HttpError(502, "convert_runner", `한글 변환기가 결과를 내지 못했습니다.${err.trim() ? ` ${err.trim().split("\n").at(-1)}` : ""}`)); }
    });
    child.stdin.end(JSON.stringify({ schemaVersion: 1, ...request }));
  });
}

function requireRunner() {
  const runner = findKordocRunner();
  if (!runner) throw new HttpError(501, "convert_unavailable", "한글 변환기(hallym-kordoc)를 찾지 못했습니다. 앱을 다시 설치해 주세요.");
  return runner;
}
/** "kordoc 4.18.13" from the runner's manifest. */
export function converterVersion(runner = findKordocRunner()) {
  return (kordocVersion(runner) ?? "").split(" ")[0] || "4.18.13";
}

// ---- 불러오기 -------------------------------------------------------------------------------------

export type ImportRequest = { preset?: unknown; pages?: unknown; images?: unknown; password?: unknown };
export type ImportOptionsIn = { preset: ImportPresetId; pages: string; images: boolean; password?: string };
export function importOptionsOf(raw: ImportRequest): ImportOptionsIn {
  const pages = typeof raw.pages === "string" ? normalizePageRange(raw.pages) : "";
  if (pages === null) throw new HttpError(400, "convert_pages", "쪽 범위를 「1-3,5」처럼 적어 주세요.");
  if (raw.password !== undefined && (typeof raw.password !== "string" || raw.password.length > 256)) throw new HttpError(400, "convert_password", "암호가 올바르지 않습니다.");
  return { preset: normalizeImportPreset(raw.preset), pages, images: raw.images !== false, ...(raw.password ? { password: raw.password as string } : {}) };
}

/** The core `read` options: HanMark's whitelist (importOptions.ts) + the table mode of the preset (Q2). */
export function coreReadOptions(options: ImportOptionsIn) {
  return { ...toParseOptions({ ...DEFAULT_IMPORT_OPTIONS, preset: options.preset, pages: options.pages, images: options.images }, options.password ? { password: options.password } : {}), layoutTables: IMPORT_TABLE_MODE[options.preset] };
}

/** A refusal the dialog can act on: what happened, what to do, and whether a password helps. */
export class ConvertError extends HttpError {
  readonly passwordHelps: boolean;
  /** kordoc's own sentence, for a bug report (never the main text). */
  readonly original?: string;
  constructor(status: number, code: string, title: string, fix: string | undefined, passwordHelps = false, original?: string) {
    super(status, code, fix ? `${title} ${fix}` : title);
    this.passwordHelps = passwordHelps;
    this.original = original;
  }
}

export type ImportedDocument = {
  /** The new Markdown file. */
  path: string;
  /** Picture files written (relative links in the Markdown). */
  pictures: string[];
  tables: number;
  /** Readable lines, with the page where kordoc names one. */
  warnings: string[];
  fileType: string;
  converter: { converter: string; version: string; preset: string };
};

const PRESET_NAMES: Record<ImportPresetId, string> = { default: "기본", text: "글 위주", form: "서식 문서", exam: "시험지·안내문 PDF" };
const countTables = (blocks: unknown): number => Array.isArray(blocks) ? blocks.reduce((sum: number, block) => sum + (block && typeof block === "object" && (block as { type?: string }).type === "table" ? 1 : 0), 0) : 0;
const safeName = (value: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
const linkTo = (path: string) => (/[\s()<>]/.test(path) ? `<${path}>` : path);

/** A stem whose `{stem}.md` and `{stem}.assets/` are both free in `folder` (`{stem} (1)` …). */
export function freeImportStem(folder: string, base: string, taken: (path: string) => boolean = existsSync) {
  const clean = safeName(base).slice(0, 120) || "불러온 문서";
  for (let n = 0; n < 1000; n++) {
    const stem = n ? `${clean} (${n})` : clean;
    if (!taken(join(folder, `${stem}.md`)) && !taken(join(folder, IMPORT_PICTURE_FOLDER(stem)))) return stem;
  }
  throw new HttpError(409, "convert_name", "새 문서의 이름을 정하지 못했습니다.");
}

export type ReadDocument = {
  markdown: string;
  images: { filename: string; bytes: Buffer; mimeType?: string }[];
  warnings: string[];
  tables: number;
  fileType: string;
  version: string;
};

/** Read one file with the core into Markdown (and its pictures' bytes); nothing is written. */
export async function readDocument(source: string, options: ImportOptionsIn, extra: { signal?: AbortSignal; runner?: string } = {}): Promise<ReadDocument> {
  const ext = extname(source).slice(1).toLowerCase();
  if (!importable(source)) throw new ConvertError(415, "UNSUPPORTED_FORMAT", t("import.error.unsupportedFormat.title"), t("import.error.unsupportedFormat.fix"));
  if (ext === "pdf" && !pdfExtensionCache()) throw new ConvertError(415, "pdf_not_shipped", PDF_NOT_SHIPPED, undefined);
  const info = lstatSync(source, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new ConvertError(404, "FILE_NOT_FOUND", t("import.error.notFound.title"), t("import.error.notFound.fix"));
  if (info.size > IMPORT_MAX_BYTES) throw new ConvertError(413, "convert_too_large", "파일이 200 MB보다 커서 불러오지 않았습니다.", undefined);
  const runner = extra.runner ?? requireRunner();
  const work = await mkdtemp(join(tmpdir(), "wb-hconv-read-"));
  try {
    const result = await runCore(runner, { mode: "read", input: resolve(source), options: coreReadOptions(options), outputDir: join(work, "out") }, { cwd: work, signal: extra.signal });
    if (result.status === "failed" || !result.data) {
      const code = result.failure?.code ?? "PARSE_ERROR";
      if (code === "DEPENDENCY_UNAVAILABLE_OFFLINE" || code === "MISSING_DEPENDENCY") throw new ConvertError(415, "pdf_not_shipped", ext === "pdf" ? PDF_NOT_SHIPPED : t("import.error.missingDependency.title"), ext === "pdf" ? undefined : t("import.error.missingDependency.fix"));
      const described = describeImportFailure(code, ext === "pdf" ? "pdf" : ext === "hwpx" || ext === "hwp" ? ext : undefined);
      // A wrong password reads like a missing one: say so, so the person knows to try again.
      const wrong = code === "ENCRYPTED" && Boolean(options.password);
      throw new ConvertError(code === "ENCRYPTED" ? 401 : 422, code === "ENCRYPTED" ? (wrong ? "password_wrong" : "password_required") : code,
        wrong ? "암호가 맞지 않습니다." : described.title, wrong ? "다시 입력해 주세요." : described.fix, described.passwordHelps, result.failure?.message);
    }
    const data = result.data as { markdown?: string; images?: { filename: string; data?: { data?: string } | string; mimeType?: string }[]; blocks?: unknown; fileType?: string };
    const images = (data.images ?? []).flatMap((image) => {
      const base64 = typeof image.data === "string" ? image.data : image.data?.data;
      return base64 ? [{ filename: image.filename, bytes: Buffer.from(base64, "base64"), mimeType: image.mimeType }] : [];
    });
    return {
      markdown: typeof data.markdown === "string" ? data.markdown : "", images, tables: countTables(data.blocks), fileType: data.fileType ?? ext,
      warnings: (result.warnings ?? []).map((warning) => `${warning.page ? `${warning.page}쪽: ` : ""}${describeImportWarning({ code: warning.code, message: warning.message })}`),
      version: result.engine?.version ?? converterVersion(runner),
    };
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
}

/**
 * Read one file with the core and write `{stem}.md` (+ pictures) into `folder`. Nothing is written when
 * the reading fails; the source is only read. `name`: a wanted file name — refused when taken.
 */
export async function importToMarkdown(source: string, folder: string, options: ImportOptionsIn, extra: { name?: string; signal?: AbortSignal; runner?: string } = {}): Promise<ImportedDocument> {
  let stem: string;
  if (extra.name !== undefined) {
    stem = safeName(extra.name.replace(/\.md$/i, ""));
    if (!stem || stem.startsWith(".")) throw new HttpError(400, "convert_name", "새 문서 이름을 적어 주세요.");
    if (existsSync(join(folder, `${stem}.md`)) || existsSync(join(folder, IMPORT_PICTURE_FOLDER(stem)))) throw new HttpError(409, "convert_name_taken", `「${stem}.md」이(가) 이미 있습니다. 다른 이름을 적거나 비워 두면 번호를 붙여 새로 만듭니다.`);
  } else stem = freeImportStem(folder, basename(source, extname(source)));
  const read = await readDocument(source, options, extra);
  let markdown = read.markdown;
  const warnings = [...read.warnings];
  // Pictures: HanMark's importImages (vault attachment policy → `{stem}.assets/`, relative links);
  // bytes the Markdown does not reference are not written (a warning), as HanMark does.
  const pictures: { file: string; bytes: Buffer }[] = [];
  const folderName = IMPORT_PICTURE_FOLDER(stem);
  for (const [index, image] of (options.images ? read.images : []).entries()) {
    const extension = /\.([a-z0-9]{1,8})$/i.exec(image.filename)?.[1]?.toLowerCase() ?? ({ "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp", "image/webp": "webp" } as Record<string, string>)[image.mimeType ?? ""] ?? "png";
    const file = `${stem}-${index + 1}.${extension}`;
    const rewritten = rewriteImportedImageReference(markdown, image.filename, `![](${linkTo(`${folderName}/${file}`)})`);
    if (!rewritten.replacements) { warnings.push(t("import.image.unreferenced", { file: image.filename })); continue; }
    markdown = rewritten.markdown;
    pictures.push({ file, bytes: image.bytes });
  }
  // Written last, never over a file: the pictures' folder (new), then the note.
  const written: string[] = [];
  if (pictures.length) {
    mkdirSync(join(folder, folderName));
    for (const picture of pictures) {
      const path = join(folder, folderName, picture.file);
      try { writeFileSync(path, picture.bytes, { flag: "wx" }); written.push(path); }
      catch (error) { warnings.push(t("import.image.saveFailed", { file: picture.file, detail: error instanceof Error ? error.message : String(error) })); }
    }
  }
  const path = join(folder, `${stem}.md`);
  writeFileSync(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, { flag: "wx" });
  return { path, pictures: written, tables: read.tables, warnings, fileType: read.fileType, converter: { converter: "kordoc", version: read.version, preset: PRESET_NAMES[options.preset] } };
}
export const IMPORT_PRESETS = IMPORT_PRESET_IDS.map((id) => ({ id, label: t(IMPORT_PRESET_LABELS[id].name), description: t(IMPORT_PRESET_LABELS[id].desc) }));

// ---- 내보내기 -------------------------------------------------------------------------------------

export type ExportFormat = "hwpx" | "hwp" | "docx";
export type ExportRequest = { format?: unknown; template?: unknown; name?: unknown; date?: unknown };
export type ExportOptions = { format: ExportFormat; template: string; name?: string; date?: string };
export function exportOptionsOf(raw: ExportRequest): ExportOptions {
  const format = raw.format === undefined ? "hwpx" : raw.format;
  if (format !== "hwpx" && format !== "hwp" && format !== "docx") throw new HttpError(400, "export_format", "HWPX·HWP·DOCX 가운데 하나를 골라 주세요.");
  const template = raw.template === undefined ? GENERAL_DEFAULT_TEMPLATE : raw.template;
  if (typeof template !== "string" || !/^(builtin|user|gongmun):[a-z0-9._-]{1,100}$/i.test(template)) throw new HttpError(400, "export_template", "서식을 다시 골라 주세요.");
  if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name.length > 200)) throw new HttpError(400, "export_name", "이름이 올바르지 않습니다.");
  if (raw.date !== undefined && (typeof raw.date !== "string" || raw.date.length > 40)) throw new HttpError(400, "export_date", "날짜가 올바르지 않습니다.");
  return { format, template, ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name } : {}), ...(typeof raw.date === "string" && raw.date.trim() ? { date: raw.date.trim() } : {}) };
}

/** Workbench Markdown may open with YAML front matter (properties): not part of the document's body. */
export function withoutFrontMatter(text: string) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

export type ExportedDocument = { bytes: Buffer; warnings: string[]; template: string; converter: { converter: string; version: string; preset: string }; check?: { structure: string; text: string } };

/**
 * Markdown → HWPX bytes through the core (adapter → pictures → generate / template-apply). `folder`: the
 * Markdown file's folder (pictures resolve against it); `root`: the project folder (no picture outside
 * it is read). `templates`: the store of the person's registered templates.
 */
export async function markdownToHwpx(text: string, folder: string, root: string, options: { template: string; date?: string; templates?: HangulTemplates; signal?: AbortSignal; runner?: string }) {
  const runner = options.runner ?? requireRunner();
  const warnings: string[] = [];
  const adapted = adaptMarkdownForKordoc(withoutFrontMatter(text));
  for (const warning of adapted.warnings) warnings.push(warning.count > 1 ? `${warning.message} (${warning.count}곳)` : warning.message);
  const work = await mkdtemp(join(tmpdir(), "wb-hconv-export-"));
  try {
    // Pictures: HanMark's imageAssets resolution (limits, real format and size); read only inside the project.
    const resolved = await resolveMarkdownImages(adapted.markdown, { concurrency: 1, loader: async (source) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(source)) throw new Error("인터넷·다른 앱 주소의 그림은 넣지 않습니다(오프라인).");
      let decoded = source.replace(/^<|>$/g, "");
      try { decoded = decodeURI(decoded); } catch { /* as written */ }
      const path = resolve(folder, decoded.replace(/[?#].*$/, ""));
      if (!within(real(root), real(path))) throw new Error("프로젝트 폴더 밖의 그림은 넣지 않습니다.");
      return { data: await readFile(path) };
    } });
    const failed = new Set(resolved.failures.map((failure) => failure.source));
    for (const failure of resolved.failures) warnings.push(`그림 「${failure.alt || failure.source}」을(를) 넣지 못했습니다: ${failure.message}`);
    const markdown = rewriteMarkdownForResolvedImages(adapted.markdown, resolved.assets, failed);
    const images: Record<string, string> = {};
    if (resolved.assets.length) mkdirSync(join(work, "images"));
    for (const asset of resolved.assets) {
      const path = join(work, "images", asset.safeName);
      writeFileSync(path, asset.data);
      images[asset.safeName] = path;
    }
    const engine = { name: "kordoc", version: converterVersion(runner) };
    const [kind, id] = options.template.split(":") as ["builtin" | "user" | "gongmun", string];
    const request: Record<string, unknown> = { mode: "generate", markdown, images, outputDir: join(work, "out") };
    let label: string;
    if (kind === "builtin") {
      const builtin = BUILTINS.find((entry) => entry.id === options.template);
      if (!builtin) throw new HttpError(404, "export_template", "그 기본 서식이 없습니다.");
      label = builtin.label;
      if (id !== "kordoc-default") {
        const pack = join(work, "template.kordoc-template.json");
        writeFileSync(pack, JSON.stringify(builtinPack(id as "korean-communication" | "youth-studies", engine)));
        Object.assign(request, { mode: "template-apply", template: pack });
      }
    } else if (kind === "user") {
      const entry = options.templates?.get(id);
      if (!entry) throw new HttpError(404, "export_template", "그 양식을 찾지 못했습니다. 서식을 다시 골라 주세요.");
      label = entry.label;
      Object.assign(request, { mode: "template-apply", template: entry.path });
    } else {
      const preset = GONGMUN_PRESETS.find((entry) => entry.id === id);
      if (!preset) throw new HttpError(404, "export_template", "그 공문서 종류가 없습니다.");
      label = `공문서 · ${preset.label}`;
      if (COVER_DATE_PRESETS.has(id) && !options.date) throw new HttpError(400, "export_date", `「${preset.label}」은(는) 표지 날짜가 필요합니다. 날짜를 적어 주세요.`);
      Object.assign(request, { options: { gongmun: { preset: id } }, ...(options.date ? { frozenDate: options.date } : {}) });
    }
    const result = await runCore(runner, request, { cwd: work, signal: options.signal });
    const file = result.files?.find((entry) => entry.path.endsWith(".hwpx"))?.path;
    if (result.status === "failed" || !file) throw new HttpError(422, result.failure?.code ?? "export_failed", `한글 문서를 만들지 못했습니다: ${result.failure?.message ?? "변환기가 파일을 내지 않았습니다."}`);
    for (const warning of result.warnings ?? []) warnings.push(warning.message);
    return { bytes: await readFile(file), warnings, label, version: result.engine?.version ?? engine.version };
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
}

/** A free `{stem}.{ext}` beside the source (`{stem} (1).{ext}` …); a wanted name is refused when taken. */
export function exportPath(folder: string, stem: string, ext: string, wanted?: string) {
  if (wanted !== undefined) {
    const clean = safeName(wanted.replace(new RegExp(`\\.${ext}$`, "i"), ""));
    if (!clean || clean.startsWith(".")) throw new HttpError(400, "export_name", "새 문서 이름을 적어 주세요.");
    const path = join(folder, `${clean}.${ext}`);
    if (existsSync(path)) throw new HttpError(409, "export_name_taken", `「${clean}.${ext}」이(가) 이미 있습니다. 다른 이름을 적거나 비워 두면 번호를 붙여 새로 만듭니다.`);
    return path;
  }
  const clean = safeName(stem).slice(0, 120) || "내보낸 문서";
  for (let n = 0; n < 1000; n++) {
    const path = join(folder, `${n ? `${clean} (${n})` : clean}.${ext}`);
    if (!existsSync(path)) return path;
  }
  throw new HttpError(409, "export_name", "새 문서의 이름을 정하지 못했습니다.");
}

// ---- The person's templates ("HWPX를 양식으로 등록") ---------------------------------------------

/** Registered .hwpx templates: the core's TemplatePack (template-analyze), one file each in the data folder. */
export class HangulTemplates {
  readonly dir: string;
  constructor(dataDir: string) { this.dir = join(dataDir, "hangul-templates"); }
  list(): { id: string; label: string; path: string }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((name) => name.endsWith(".kordoc-template.json")).sort().flatMap((name) => {
      try {
        const pack = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as { id?: string; name?: string };
        return pack.id ? [{ id: pack.id, label: String(pack.name ?? pack.id), path: join(this.dir, name) }] : [];
      } catch { return []; }
    });
  }
  get(id: string) { return this.list().find((entry) => entry.id === id); }
  /** The core's template-analyze on an .hwpx; the same file again is "이미 있음". */
  async register(source: string, options: { name?: string; signal?: AbortSignal; runner?: string } = {}) {
    if (extname(source).toLowerCase() !== ".hwpx" || !lstatSync(source, { throwIfNoEntry: false })?.isFile()) throw new HttpError(415, "template_format", "양식으로 등록할 수 있는 것은 HWPX 파일입니다.");
    const runner = options.runner ?? requireRunner();
    const work = await mkdtemp(join(tmpdir(), "wb-hconv-template-"));
    try {
      const name = (options.name?.trim() || basename(source, extname(source))).slice(0, 80);
      const result = await runCore(runner, { mode: "template-analyze", input: resolve(source), name, outputDir: join(work, "out") }, { cwd: work, signal: options.signal });
      const file = result.files?.find((entry) => entry.path.endsWith(".kordoc-template.json"))?.path;
      if (result.status === "failed" || !file) throw new HttpError(422, result.failure?.code ?? "template_failed", `양식을 읽지 못했습니다: ${result.failure?.message ?? ""}`.trim());
      const pack = JSON.parse(await readFile(file, "utf8")) as { id: string; name: string };
      mkdirSync(this.dir, { recursive: true });
      const target = join(this.dir, `${pack.id}.kordoc-template.json`);
      if (existsSync(target)) return { id: pack.id, label: pack.name, existed: true };
      await copyFile(file, target, 1 /* COPYFILE_EXCL */);
      return { id: pack.id, label: pack.name, existed: false };
    } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
  }
  /** Every template a person can choose, in the dialog's order. */
  choices(): HangulTemplate[] {
    return [
      ...BUILTINS.map((entry) => ({ ...entry, group: "기본 서식" as const })),
      ...this.list().map((entry) => ({ id: `user:${entry.id}`, label: entry.label, group: "내 양식" as const })),
      ...GONGMUN_PRESETS.map((entry) => ({ id: `gongmun:${entry.id}`, label: entry.label, group: "공문서" as const })),
    ];
  }
}

// ---- The gateway's side: documents, projects, refusals ------------------------------------------

type Track = (workId: string, cwd: string, path: string, author: ArtifactRevision["author"], sessionId: string | null, note: string | null,
  derivedFrom?: ArtifactRevision["derivedFrom"], provenance?: null, convertedFrom?: ArtifactRevision["convertedFrom"]) => { artifact: Artifact } | null;
export type ConvertHost = {
  documents: { get(id: string): Artifact; find(id: string): Artifact | undefined; check(id: string): Artifact; list(): Artifact[]; revisionPath(id: string, revision: number): string; track: Track };
  /** The project's folder for a work (and workspace). */
  projectFolder(workId: string, workspaceId?: string): string;
  dataDir: string;
  /** md → docx through the Ieum CLI (null: not installed). */
  ieumConvert: ((input: string, out: string, roots: string[]) => Promise<void>) | null;
  /** HWPX → .hwp through the one rhwp engine and the save checks (hwp-ops.mjs). */
  hwpxToHwp?: (bytes: Uint8Array) => Promise<{ bytes: Buffer; structure: string; text: string }>;
  /** IeumOffice's converters in this process (tests); absent: the job process (office-convert.ts). */
  convertWorker?: ConvertWorker;
};

/** The IeumOffice release whose converters run (vendor/ieumoffice.PINNED; a test keeps the two equal). */
export const IEUM_CONVERTERS = "IeumOffice 0.13.0";
const LEGACY_CONVERTER = { doc: "doc2docx", ppt: "ppt2pptx", ods: "xlsx 엔진" } as const;
/** A Word → Hangul copy waiting for the person's answer to the ledger (never written before it). */
type HangulTicket = { artifactId: string; revision: number; format: "hwp" | "hwpx"; name?: string; bytes: Uint8Array; fromEditor: boolean; expires: number };
export type WordHangulPlan = { ticket: string; format: "hwp" | "hwpx"; name: string; ledger: LossLedger; losses: number };

/**
 * 불러오기 / 내보내기 for listed documents and files of a project. Every write is a NEW file in the
 * project's folder; refused: a document taken out of its project (보관함), a file outside its project's
 * folder, a wanted name already taken.
 */
export class HangulConvert {
  readonly templates: HangulTemplates;
  private readonly host: ConvertHost;
  constructor(host: ConvertHost) { this.host = host; this.templates = new HangulTemplates(host.dataDir); }

  private listed(artifactId: string) {
    const found = this.host.documents.find(artifactId);
    if (found?.removed) throw new HttpError(409, "document_removed", "목록에서 뺀 문서라 변환하지 않습니다. 보관함에서 되돌린 뒤 다시 해 주세요.");
    const artifact = this.host.documents.check(artifactId);
    if (artifact.diskState === "missing") throw new HttpError(404, "file_missing", "문서 파일이 없습니다. 옮기거나 지웠는지 확인해 주세요.");
    return artifact;
  }
  /** The project folder that holds `path`, or a refusal. */
  private inProject(workId: string, workspaceId: string | undefined, path: string) {
    const root = this.host.projectFolder(workId, workspaceId);
    if (!within(real(root), real(dirname(path)))) throw new HttpError(409, "outside_project", "프로젝트 폴더 밖에 있는 파일이라 그 옆에 새 문서를 만들지 않습니다. 「문서 불러오기…」로 프로젝트에 복사한 뒤 변환해 주세요.");
    return root;
  }

  /** "문서 불러오기…" / drag and drop: copy each file into the project folder (never moved), list what can be listed. */
  importFiles(workId: string, paths: unknown, workspaceId?: string) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 50 || !paths.every((path) => typeof path === "string" && isAbsolute(path))) throw new HttpError(400, "import_paths", "불러올 파일을 다시 골라 주세요.");
    const root = this.host.projectFolder(workId, workspaceId);
    return (paths as string[]).map((path) => {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info?.isFile()) throw new HttpError(404, "file_missing", `파일이 없습니다: ${basename(path)}`);
      if (!importable(path)) throw new HttpError(415, "import_format", `「${basename(path)}」은(는) 불러올 수 없는 형식입니다. HWP·HWPX·DOCX·XLSX·XLS 파일을 골라 주세요.`);
      const inside = within(real(root), real(path)) ? path : this.copyIn(root, basename(path), readFileSync(path));
      return this.entry(workId, root, inside);
    });
  }
  /** A dropped file's bytes, written into the project folder under a free name. */
  importUpload(workId: string, name: string, bytes: Buffer, workspaceId?: string) {
    if (!importable(name) || basename(name) !== name) throw new HttpError(415, "import_format", `「${basename(name)}」은(는) 불러올 수 없는 형식입니다. HWP·HWPX·DOCX·XLSX·XLS 파일을 골라 주세요.`);
    const root = this.host.projectFolder(workId, workspaceId);
    return this.entry(workId, root, this.copyIn(root, name, bytes));
  }
  private copyIn(root: string, name: string, bytes: Buffer) {
    const ext = extname(name), stem = basename(name, ext);
    for (let n = 0; n < 1000; n++) {
      const path = join(root, `${n ? `${stem} (${n})` : stem}${ext}`);
      try { mkdirSync(root, { recursive: true }); writeFileSync(path, bytes, { flag: "wx" }); return path; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    throw new HttpError(409, "import_name", "복사할 이름을 정하지 못했습니다.");
  }
  private entry(workId: string, root: string, path: string) {
    const tracked = this.host.documents.track(workId, root, path, "user", null, "문서 불러오기");
    const artifact = tracked?.artifact ?? this.host.documents.list().find((entry) => entry.workId === workId && entry.path === path) ?? null;
    return { path, name: basename(path), artifactId: artifact?.id ?? null };
  }

  /** "Markdown 문서로 변환" of a listed document. */
  async convertDocument(artifactId: string, raw: ImportRequest & { name?: unknown }, signal?: AbortSignal) {
    const artifact = this.listed(artifactId);
    if (!importable(artifact.path)) throw new HttpError(415, "convert_format", "HWP·HWPX·DOCX·PDF·XLSX·XLS 문서만 Markdown으로 바꿀 수 있습니다.");
    this.inProject(artifact.workId, artifact.workspaceId, artifact.path);
    return this.convert(artifact.workId, artifact.workspaceId, artifact.path, { artifactId: artifact.id, revision: artifact.revision }, raw, signal);
  }
  /** The same for a file of the project folder that is not a listed document (an .xls). */
  async convertFile(workId: string, path: unknown, raw: ImportRequest & { name?: unknown }, workspaceId?: string, signal?: AbortSignal) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new HttpError(400, "convert_path", "변환할 파일을 다시 골라 주세요.");
    this.inProject(workId, workspaceId, path);
    const listed = this.host.documents.list().find((entry) => entry.workId === workId && entry.path === path);
    return this.convert(workId, workspaceId, path, listed ? { artifactId: listed.id, revision: listed.revision } : null, raw, signal);
  }
  private async convert(workId: string, workspaceId: string | undefined, path: string, source: { artifactId: string; revision: number } | null, raw: ImportRequest & { name?: unknown }, signal?: AbortSignal) {
    if (raw.name !== undefined && typeof raw.name !== "string") throw new HttpError(400, "convert_name", "이름이 올바르지 않습니다.");
    const made = await importToMarkdown(path, dirname(path), importOptionsOf(raw), { signal, ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name } : {}) });
    const note = `「${basename(path)}」에서 불러옴 (${made.converter.converter} ${made.converter.version} · ${made.converter.preset})`;
    const root = this.host.projectFolder(workId, workspaceId);
    const tracked = this.host.documents.track(workId, root, made.path, "user", null, note, source ? [source] : null, null, made.converter);
    if (!tracked) throw new HttpError(500, "document_not_tracked", `Markdown 문서는 만들었지만 목록에 넣지 못했습니다: ${made.path}`);
    return { artifact: tracked.artifact, pictures: made.pictures.length, tables: made.tables, warnings: made.warnings, fileType: made.fileType };
  }

  /** "한글 문서로 내보내기…" of a Markdown document: a NEW .hwpx/.hwp/.docx beside it. */
  async exportDocument(artifactId: string, raw: ExportRequest, signal?: AbortSignal) {
    const artifact = this.listed(artifactId);
    if (artifact.format !== "markdown") throw new HttpError(415, "export_source", "Markdown 문서만 한글 문서로 내보낼 수 있습니다.");
    const options = exportOptionsOf(raw);
    const root = this.inProject(artifact.workId, artifact.workspaceId, artifact.path);
    const folder = dirname(artifact.path), stem = basename(artifact.path, extname(artifact.path));
    const target = exportPath(folder, stem, options.format, options.name);
    // The recorded revision (what the derivedFrom link names); pictures resolve beside the file.
    const made = await this.exportBytes(readFileSync(this.host.documents.revisionPath(artifact.id, artifact.revision), "utf8"), artifact.path, root, options, signal);
    // Never over a file: refused (not replaced) if one appeared meanwhile.
    try { await writeFile(target, made.bytes, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "export_name_taken", `「${basename(target)}」이(가) 방금 생겼습니다. 다시 내보내 주세요.`); throw error; }
    const note = `「${artifact.name}」 r${artifact.revision}에서 내보냄 (${made.converter.converter} ${made.converter.version} · ${made.converter.preset})`;
    const tracked = this.host.documents.track(artifact.workId, root, target, "user", null, note, [{ artifactId: artifact.id, revision: artifact.revision }], null, made.converter);
    if (!tracked) throw new HttpError(500, "document_not_tracked", `파일은 만들었지만 문서 목록에 넣지 못했습니다: ${target}`);
    return { artifact: tracked.artifact, warnings: made.warnings, template: made.template, ...(made.check ? { check: made.check } : {}) };
  }

  /** The bytes of one export (no file written): HWPX by the core, HWP from that HWPX, DOCX by the Ieum CLI. */
  async exportBytes(text: string, sourcePath: string, root: string, options: ExportOptions, signal?: AbortSignal): Promise<ExportedDocument> {
    if (options.format === "docx") {
      if (!this.host.ieumConvert) throw new HttpError(501, "ieumoffice_missing", "워드로 내보내려면 이음오피스가 필요합니다. 앱을 다시 설치해 주세요.");
      const work = await mkdtemp(join(tmpdir(), "wb-hconv-docx-"));
      try {
        const out = join(work, "document.docx");
        await this.host.ieumConvert(sourcePath, out, [dirname(sourcePath), work]);
        return { bytes: await readFile(out), warnings: [], template: "워드(이음오피스)", converter: { converter: "ieumoffice", version: "md → docx", preset: "워드" } };
      } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
    }
    const hwpx = await markdownToHwpx(text, dirname(sourcePath), root, { template: options.template, date: options.date, templates: this.templates, signal });
    const converter = { converter: "kordoc", version: hwpx.version, preset: hwpx.label };
    if (options.format === "hwpx") return { bytes: hwpx.bytes, warnings: hwpx.warnings, template: hwpx.label, converter };
    const convert = this.host.hwpxToHwp ?? (async (bytes: Uint8Array) => (await import("./hwp-ops.mjs")).hwpxToHwp(bytes));
    let saved;
    try { saved = await convert(hwpx.bytes); }
    catch (error) { throw new HttpError(422, "export_hwp_refused", `HWP로 저장하지 않았습니다(저장 검사에 걸림): ${error instanceof Error ? error.message : String(error)} HWPX로 내보내면 그대로 만들 수 있습니다.`); }
    return { bytes: Buffer.from(saved.bytes), warnings: hwpx.warnings, template: hwpx.label, converter: { ...converter, preset: `${hwpx.label} · HWP(rhwp)` }, check: { structure: saved.structure, text: saved.text } };
  }

  // ---- IeumOffice v0.13.0's converters (office-convert.ts) -------------------------------------------

  /** A NEW file beside the source: a free `{stem}.{ext}`, or the wanted name (refused when taken); never over a file. */
  private async writeBeside(folder: string, stem: string, ext: string, bytes: Uint8Array, wanted?: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = exportPath(folder, stem, ext, wanted);
      try { await writeFile(target, bytes, { flag: "wx" }); return target; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (wanted !== undefined) throw new HttpError(409, "export_name_taken", `「${basename(target)}」이(가) 방금 생겼습니다. 다른 이름을 적어 주세요.`);
      }
    }
    throw new HttpError(409, "export_name", "새 문서의 이름을 정하지 못했습니다.");
  }

  /**
   * "변환해서 열기" of a listed .doc / .ppt / .ods: a NEW .docx / .pptx / .xlsx beside it (`{stem}.docx`, a free
   * name when taken), recorded as made from it; the original stays as it is. `line`: where the copy came
   * from and what did not come along, in one sentence.
   */
  async openConverted(artifactId: string) {
    const artifact = this.listed(artifactId);
    const kind = artifact.format;
    if (!isLegacyKind(kind)) throw new HttpError(415, "convert_format", "워드 97-2003(.doc)·PPT 97-2003(.ppt)·ODS 파일만 변환해서 엽니다.");
    const root = this.inProject(artifact.workId, artifact.workspaceId, artifact.path);
    const { bytes, reply } = await convertLegacy(kind, readFileSync(this.host.documents.revisionPath(artifact.id, artifact.revision)), this.host.convertWorker);
    const target = await this.writeBeside(dirname(artifact.path), basename(artifact.path, extname(artifact.path)), LEGACY_TARGET[kind], bytes);
    const converter = { converter: LEGACY_CONVERTER[kind], version: IEUM_CONVERTERS, preset: "변환해서 열기" };
    const line = legacyLine(kind, artifact.name, reply as Extract<typeof reply, { ok: true }>);
    // The copy says where it came from (its record's note, and derivedFrom / convertedFrom), with the same line.
    const tracked = this.host.documents.track(artifact.workId, root, target, "user", null, `r${artifact.revision}에서 변환: ${line} (${converter.converter} · ${IEUM_CONVERTERS})`, [{ artifactId: artifact.id, revision: artifact.revision }], null, converter);
    if (!tracked) throw new HttpError(500, "document_not_tracked", `파일은 만들었지만 문서 목록에 넣지 못했습니다: ${target}`);
    return { artifact: tracked.artifact, line };
  }

  private readonly hangulTickets = new Map<string, HangulTicket>();
  /**
   * "한글 문서로 내보내기" of a Word document, step 1: convert (docx2hwp on the one engine) and say what the
   * copy loses — nothing is written yet. `editorBytes`: the open editor's document (with edits not saved
   * yet); absent: the recorded revision. `passwordSet`: the document carries an open password (the copy does not).
   */
  async prepareWordHangul(artifactId: string, raw: { format?: unknown; name?: unknown; passwordSet?: unknown }, editorBytes?: Uint8Array): Promise<WordHangulPlan> {
    const artifact = this.listed(artifactId);
    if (artifact.format !== "docx") throw new HttpError(415, "export_source", "워드 문서(.docx)만 한글 문서로 내보낼 수 있습니다.");
    const format = raw.format === undefined ? "hwpx" : raw.format;
    if (format !== "hwpx" && format !== "hwp") throw new HttpError(400, "export_format", "HWPX·HWP 가운데 하나를 골라 주세요.");
    if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name.length > 200)) throw new HttpError(400, "export_name", "이름이 올바르지 않습니다.");
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : undefined;
    this.inProject(artifact.workId, artifact.workspaceId, artifact.path);
    // A taken wanted name is refused before the conversion, not after it.
    const planned = exportPath(dirname(artifact.path), basename(artifact.path, extname(artifact.path)), format, name);
    const made = await wordToHangul(editorBytes ?? readFileSync(this.host.documents.revisionPath(artifact.id, artifact.revision)), format, this.host.convertWorker);
    const now = Date.now();
    for (const [id, ticket] of this.hangulTickets) if (ticket.expires < now) this.hangulTickets.delete(id);
    if (this.hangulTickets.size >= 20) throw new HttpError(429, "export_busy", "내보내기 요청이 너무 많습니다. 잠시 뒤에 다시 해 주세요.");
    const ticket = randomUUID();
    this.hangulTickets.set(ticket, { artifactId, revision: artifact.revision, format, ...(name ? { name } : {}), bytes: made.bytes, fromEditor: Boolean(editorBytes), expires: now + 15 * 60_000 });
    return { ticket, format, name: basename(planned), ledger: lossLedger(made.losses, raw.passwordSet === true), losses: made.losses.length };
  }

  /** Step 2, after the person read the ledger and chose 저장: the NEW .hwpx/.hwp beside the Word document. */
  async commitWordHangul(artifactId: string, ticketId: unknown) {
    const ticket = typeof ticketId === "string" ? this.hangulTickets.get(ticketId) : undefined;
    if (!ticket || ticket.artifactId !== artifactId || ticket.expires < Date.now()) throw new HttpError(404, "export_expired", "내보내기를 처음부터 다시 해 주세요.");
    this.hangulTickets.delete(ticketId as string);
    const artifact = this.listed(artifactId);
    const root = this.inProject(artifact.workId, artifact.workspaceId, artifact.path);
    const target = await this.writeBeside(dirname(artifact.path), basename(artifact.path, extname(artifact.path)), ticket.format, ticket.bytes, ticket.name);
    const converter = { converter: "docx2hwp", version: IEUM_CONVERTERS, preset: `워드 모양 · ${ticket.format.toUpperCase()}` };
    const note = `「${artifact.name}」 r${ticket.revision}${ticket.fromEditor ? "(편집 중이던 내용)" : ""}에서 내보냄 (docx2hwp · ${IEUM_CONVERTERS})`;
    const tracked = this.host.documents.track(artifact.workId, root, target, "user", null, note, [{ artifactId: artifact.id, revision: ticket.revision }], null, converter);
    if (!tracked) throw new HttpError(500, "document_not_tracked", `파일은 만들었지만 문서 목록에 넣지 못했습니다: ${target}`);
    return { artifact: tracked.artifact };
  }

  /** The import dialog's and the export dialog's choices. */
  choices() {
    return { presets: IMPORT_PRESETS, templates: this.templates.choices(), defaultTemplate: GENERAL_DEFAULT_TEMPLATE, pdf: Boolean(pdfExtensionCache()), pdfLine: PDF_NOT_SHIPPED, converter: `kordoc ${converterVersion()}` };
  }
}
