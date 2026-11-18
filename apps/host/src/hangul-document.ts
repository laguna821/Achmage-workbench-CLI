/**
 * "한글 문서 만들기": the Hangul dock's one tool that makes a document THROUGH hallym-kordoc's runner
 * (scripts/run.mjs: resolve → compose, Markdown → HWPX, forms, result.json), instead of hoping the
 * model reads the skill's files and shells out (the dock's engine has no command tool).
 *
 * 0.5.5 (hangul-convert-brief): one input `kind`. "general" (the default unless the request names a Hallym /
 * 공문서 form) — the model writes Markdown and the gateway runs 내보내기's pipeline with the chosen
 * template (기본 unless named; makeGeneralDocument); "hallym" — resolve → compose below, unchanged.
 *
 * Which skill copy runs: the effective `hallym-kordoc` of the existing precedence (user-skills.ts) —
 * the bundled one unless the person disabled it (then nothing runs) or their own installed copy
 * shadows it (then THEIR copy's runner runs, as a conversation would). The skill folder is only
 * read; every output goes to a fresh temporary folder.
 *
 * Where the result goes (doc-default, 0.5.2's leftover 4d):
 *  - the open document is EMPTY and UNTOUCHED (`emptyUntouched`: an HWPX whose every saved revision has
 *    no text, with no unsaved edits in any open view) → the made document becomes THIS document's next
 *    revision; the tab stays; the name follows the made title only while the document keeps the name
 *    새 문서 gave it (`defaultNamed`), through the gateway's 이름 바꾸기 with all its refusals.
 *    It is written when the turn ENDS (the view's open-made), never under the running turn: during the
 *    turn the document's revision belongs to the turn's own editor. Checked again then; touched in the
 *    meantime → as below.
 *  - otherwise a NEW HWPX beside the open document (same folder, a free name from the title), tracked
 *    and opened in its own tab; the open document is never changed. `.hwp` is never filled (read-only input).
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { WorkbenchSkill } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { GENERAL_DEFAULT_TEMPLATE, markdownToHwpx, readDocument, withoutFrontMatter, type HangulTemplates } from "./hangul-convert.ts";

export const HANGUL_TOOL = "make_hangul_document";
const RUN_TIMEOUT_MS = 120_000;

/** The copy that answers to `hallym-kordoc` now, or why none does. */
export function effectiveHallym(skills: readonly WorkbenchSkill[]): { skill: WorkbenchSkill } | { refused: "disabled" | "missing" | "no-runner" } {
  const named = skills.filter((skill) => skill.name === "hallym-kordoc" && !skill.problem);
  if (!named.length) return { refused: "missing" };
  const winner = named.find((skill) => !skill.shadowedBy && skill.state.enabled);
  if (!winner) return { refused: "disabled" };
  if (!existsSync(join(winner.dir, "scripts/run.mjs"))) return { refused: "no-runner" };
  return { skill: winner };
}

export type HangulInput = {
  prompt: string; title?: string; familyId?: string; context?: Record<string, string>;
  values?: Record<string, string>; sections?: Record<string, string>; tables?: Record<string, unknown>; markdown?: string;
  /**
   * 0.5.5: "general" — the model writes Markdown and the gateway runs 내보내기's pipeline (HanMark's
   * adapter → the core's generate / template-apply, hangul-convert.ts) with `template`; "hallym" — the
   * skill's resolve → compose, unchanged. Absent: hallym when the request carries compose's inputs or
   * names a Hallym / 공문서 form, else general.
   */
  kind?: "general" | "hallym";
  /** general: a template id of 내보내기 (default 기본, GENERAL_DEFAULT_TEMPLATE). */
  template?: string;
  /** general: an attached .md/.docx/.hwp/.hwpx of the project, read to Markdown first (불러오기) for the model to edit. */
  source?: string;
};
/** Which way a request goes (see HangulInput.kind). */
export function hangulKind(input: HangulInput): "general" | "hallym" {
  if (input.kind) return input.kind;
  const composes = Boolean(input.familyId || Object.keys(input.values ?? {}).length || Object.keys(input.sections ?? {}).length || Object.keys(input.tables ?? {}).length);
  return composes || /한림|hallym|공문|기안문|시행문/i.test(input.prompt) ? "hallym" : "general";
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max: number) => v === undefined || (record(v) && Object.keys(v).length <= 200 && Object.values(v).every((x) => typeof x === "string" && x.length <= max));
export function hangulInput(raw: unknown): HangulInput {
  const bad = () => { throw new HttpError(400, "hangul_input", "한글 문서 요청 형식이 올바르지 않습니다."); };
  if (!record(raw) || typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > 8000) return bad();
  if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.length > 200)) return bad();
  if (raw.familyId !== undefined && (typeof raw.familyId !== "string" || !/^[a-z0-9._-]{1,80}$/i.test(raw.familyId))) return bad();
  if (raw.markdown !== undefined && (typeof raw.markdown !== "string" || raw.markdown.length > 2_000_000)) return bad();
  if (!strings(raw.context, 400) || !strings(raw.values, 20_000) || !strings(raw.sections, 400_000)) return bad();
  if (raw.tables !== undefined && (!record(raw.tables) || JSON.stringify(raw.tables).length > 1_000_000)) return bad();
  if (raw.kind !== undefined && raw.kind !== "general" && raw.kind !== "hallym") return bad();
  if (raw.template !== undefined && (typeof raw.template !== "string" || !/^(builtin|user|gongmun):[a-z0-9._-]{1,100}$/i.test(raw.template))) return bad();
  if (raw.source !== undefined && (typeof raw.source !== "string" || !raw.source.trim() || raw.source.length > 1000)) return bad();
  return raw as HangulInput;
}

/** Run the skill's runner once (stdin JSON → one JSON on stdout), in `cwd`, bounded and stoppable. */
export function runKordoc(skillDir: string, request: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal; timeoutMs?: number }) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new HttpError(409, "hangul_cancelled", "요청을 취소했습니다.")); return; }
    const child = spawn(process.execPath, [join(skillDir, "scripts/run.mjs")], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, options.timeoutMs ?? RUN_TIMEOUT_MS);
    options.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { if (out.length < 8_000_000) out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { if (err.length < 8_000) err += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", kill);
      if (options.signal?.aborted) { reject(new HttpError(409, "hangul_cancelled", "요청을 취소했습니다.")); return; }
      try { resolve(JSON.parse(out)); }
      catch { reject(new HttpError(502, "hangul_runner", `한글 문서 실행기가 결과를 내지 못했습니다.${err.trim() ? ` ${err.trim().split("\n").at(-1)}` : ""}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** A free name for the made document beside the open one. */
export function madePath(folder: string, title: string, taken: (path: string) => boolean = existsSync) {
  const base = (title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "새 한글 문서").slice(0, 80).replace(/\.hwpx?$/i, "");
  for (let n = 1; n < 1000; n++) {
    const path = join(folder, `${base}${n === 1 ? "" : ` (${n})`}.hwpx`);
    if (!taken(path)) return path;
  }
  throw new HttpError(409, "hangul_name", "만든 문서의 이름을 정하지 못했습니다.");
}

type Recipe = { fields?: { id: string; label: string; required?: boolean }[]; sections?: string[]; templateStatus?: string; title?: string; strategy?: string; limitations?: string[] };
/** What the model reads back: the form, the state of the result and where it went — no local path of the skill. */
function plan(result: Record<string, unknown>) {
  const recipe = (result.recipe ?? {}) as Recipe, selection = (result.selection ?? {}) as Record<string, unknown>;
  return {
    familyId: selection.familyId ?? null, needsClarification: Boolean(selection.needsClarification), question: selection.question ?? null,
    candidates: Array.isArray(selection.candidates) ? (selection.candidates as { id: string; title?: string }[]).slice(0, 6).map(({ id, title }) => ({ id, title })) : [],
    form: { title: recipe.title ?? null, strategy: recipe.strategy ?? null, templateStatus: recipe.templateStatus ?? result.templateStatus ?? null,
      fields: (recipe.fields ?? []).map(({ id, label, required }) => ({ id, label, required: Boolean(required) })), sections: recipe.sections ?? [], limitations: recipe.limitations ?? [] },
  };
}

/**
 * Empty and untouched, from what the gateway knows (never from the file name): an HWPX, no open view
 * reporting unsaved edits, and every saved revision without text (a few at most: a blank the person
 * saved, renamed or not). One character typed (saved or not) is a touch.
 */
export async function emptyUntouched(doc: { format: string; revisions: number[]; dirty: boolean; text(revision: number): Promise<string> }) {
  if (doc.format !== "hwpx" || doc.dirty || !doc.revisions.length || doc.revisions.length > 5) return false;
  for (const revision of doc.revisions) {
    let text: string;
    try { text = await doc.text(revision); } catch { return false; }
    if (text.replace(/\s+/g, "")) return false;
  }
  return true;
}

/** The note 새 문서 gives a blank Hangul document's first revision (sessions.ts createOfficeDocument). */
export const BLANK_HANGUL_NOTE = "새 한글 문서";
/** Still the name 새 문서 gave it: made blank by the app and never renamed since (its rename journal). */
export function defaultNamed(first: { note: string | null } | undefined, artifact: { renamed?: unknown }) {
  return first?.note === BLANK_HANGUL_NOTE && !artifact.renamed;
}

export type HangulMade = Awaited<ReturnType<typeof makeHangulDocument>>;
/**
 * resolve, then (when the request carries any content) compose; `fill` may take the HWPX for the open
 * document itself (empty and untouched: kept for the turn's end); else copy it beside the open document,
 * and `track` registers it and returns its artifact id. Nothing is written when the runner fails.
 */
export type HangulTarget = {
  documentPath: string; track(path: string): string | null; fill?(hwpx: string, title: string): Promise<{ artifactId: string; name: string } | null>; signal?: AbortSignal;
  /** general: the project's folder (pictures and `source` are read only inside it) and the person's templates. */
  root?: string; templates?: HangulTemplates;
};
export async function makeHangulDocument(skillDir: string, input: HangulInput, target: HangulTarget) {
  if (hangulKind(input) === "general") return makeGeneralDocument(input, target);
  const work = await mkdtemp(join(tmpdir(), "wb-hangul-"));
  try {
    const context = input.context ?? {};
    const resolved = await runKordoc(skillDir, { schemaVersion: 1, mode: "resolve", prompt: input.prompt, context, ...(input.familyId ? { familyId: input.familyId } : {}) }, { cwd: work, signal: target.signal });
    if (resolved.status === "failed") return { made: false as const, status: "failed", failure: resolved.failure ?? null };
    const form = plan(resolved);
    const content = Boolean(input.markdown?.trim() || Object.keys(input.sections ?? {}).length || Object.keys(input.tables ?? {}).length || Object.keys(input.values ?? {}).length);
    if (form.needsClarification || !content) return { made: false as const, status: form.needsClarification ? "needs-clarification" : "form", ...form };
    const out = join(work, "out");
    const composed = await runKordoc(skillDir, { schemaVersion: 1, mode: "compose", prompt: input.prompt, familyId: form.familyId, context,
      ...(input.title ? { title: input.title } : {}), values: input.values ?? {}, sections: input.sections ?? {}, tables: input.tables ?? {},
      ...(input.markdown?.trim() ? { markdown: input.markdown } : {}), outputDir: out }, { cwd: work, signal: target.signal });
    const summary = { status: String(composed.status), templateStatus: composed.templateStatus ?? null,
      missingFields: composed.missingFields ?? [], skipped: composed.skipped ?? null, warnings: ((composed.warnings ?? []) as { code?: string; message?: string }[]).map(({ code, message }) => ({ code, message })),
      limitations: composed.limitations ?? [], failure: composed.failure ?? null };
    const files = (composed.files ?? []) as { name: string; path: string }[];
    const hwpx = files.find((file) => file.name === "document.hwpx");
    if (composed.status === "failed" || !hwpx) return { made: false as const, ...summary, form: form.form };
    target.signal?.throwIfAborted();
    const title = input.title?.trim() || (form.form.templateStatus === "common-draft" ? "새 한글 문서 (초안)" : String(form.form.title ?? "새 한글 문서"));
    const markdown = files.find((file) => file.name === "document.md");
    const preview = markdown ? (await readFile(markdown.path, "utf8")).slice(0, 4000) : null, draft = form.form.templateStatus === "common-draft";
    const filled = target.fill ? await target.fill(hwpx.path, title) : null;
    if (filled) return { made: true as const, ...summary, form: form.form, artifactId: filled.artifactId, name: filled.name, folder: basename(dirname(target.documentPath)), inPlace: true, draft, markdownPreview: preview };
    const path = madePath(dirname(target.documentPath), title);
    await copyFile(hwpx.path, path, 1 /* COPYFILE_EXCL: never over a file */);
    const artifactId = target.track(path);
    return { made: true as const, ...summary, form: form.form, artifactId, name: basename(path), folder: basename(dirname(path)), inPlace: false, draft, markdownPreview: preview };
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
}

const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
const firstHeading = (markdown: string) => /^#{1,2}\s+(.+?)\s*#*\s*$/m.exec(withoutFrontMatter(markdown))?.[1]?.trim();

/**
 * kind "general" (0.5.5): the gateway runs 내보내기's pipeline — HanMark's adapter, then the core's generate
 * (기본) or template-apply (the chosen template) — on the Markdown the model wrote; placed as compose's
 * result is (the empty untouched document filled at the turn's end, else a new HWPX beside it). With
 * `source` and no Markdown yet: that file read to Markdown first (불러오기, nothing written) for the model
 * to edit. Without either: the templates the model may name, and what to send next.
 */
export async function makeGeneralDocument(input: HangulInput, target: HangulTarget) {
  const root = target.root ?? dirname(target.documentPath);
  const template = input.template ?? GENERAL_DEFAULT_TEMPLATE;
  const templates = (target.templates?.choices() ?? []).map(({ id, label, group }) => ({ id, label, group }));
  const templateLabel = templates.find((entry) => entry.id === template)?.label ?? template;
  if (!input.markdown?.trim() && input.source) {
    const path = resolve(dirname(target.documentPath), input.source);
    if (!within(realpathSync(root), existsSync(path) ? realpathSync(path) : path)) return { made: false as const, kind: "general", status: "failed", failure: { code: "outside_project", message: "프로젝트 폴더 밖의 파일은 읽지 않습니다." } };
    if (!existsSync(path)) return { made: false as const, kind: "general", status: "failed", failure: { code: "FILE_NOT_FOUND", message: `파일이 없습니다: ${basename(path)}` } };
    if (/\.(md|markdown|txt)$/i.test(path)) return { made: false as const, kind: "general", status: "source-markdown", source: basename(path), markdown: withoutFrontMatter(await readFile(path, "utf8")).slice(0, 400_000), template: templateLabel };
    try {
      const read = await readDocument(path, { preset: "default", pages: "", images: false }, { signal: target.signal });
      return { made: false as const, kind: "general", status: "source-markdown", source: basename(path), markdown: read.markdown.slice(0, 400_000), warnings: read.warnings, template: templateLabel };
    } catch (error) {
      return { made: false as const, kind: "general", status: "failed", failure: { code: error instanceof HttpError ? error.code : "read_failed", message: error instanceof Error ? error.message : String(error) } };
    }
  }
  if (!input.markdown?.trim()) return { made: false as const, kind: "general", status: "write-markdown", template: templateLabel, templates };
  const made = await markdownToHwpx(input.markdown, dirname(target.documentPath), root, { template, templates: target.templates, signal: target.signal });
  target.signal?.throwIfAborted();
  const title = input.title?.trim() || firstHeading(input.markdown) || "새 한글 문서";
  const work = await mkdtemp(join(tmpdir(), "wb-hangul-general-"));
  try {
    const hwpx = join(work, "document.hwpx");
    await writeFile(hwpx, made.bytes);
    const summary = { kind: "general", status: "success", template: made.label, warnings: made.warnings.map((message) => ({ message })), draft: false };
    const filled = target.fill ? await target.fill(hwpx, title) : null;
    if (filled) return { made: true as const, ...summary, artifactId: filled.artifactId, name: filled.name, folder: basename(dirname(target.documentPath)), inPlace: true };
    const path = madePath(dirname(target.documentPath), title);
    await copyFile(hwpx, path, 1 /* COPYFILE_EXCL: never over a file */);
    const artifactId = target.track(path);
    return { made: true as const, ...summary, artifactId, name: basename(path), folder: basename(dirname(path)), inPlace: false };
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
}

