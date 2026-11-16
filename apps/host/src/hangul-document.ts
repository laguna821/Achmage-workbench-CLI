/**
 * "한글 문서 만들기": the Hangul dock's one tool that makes a document THROUGH hallym-kordoc's runner
 * (scripts/run.mjs: resolve → compose, Markdown → HWPX, forms, result.json), instead of hoping the
 * model reads the skill's files and shells out (the dock's engine has no command tool).
 *
 * Which skill copy runs: the effective `hallym-kordoc` of the existing precedence (user-skills.ts) —
 * the bundled one unless the person disabled it (then nothing runs) or their own installed copy
 * shadows it (then THEIR copy's runner runs, as a conversation would). The skill folder is only
 * read; every output goes to a fresh temporary folder.
 *
 * Where the result goes (one rule): a NEW HWPX beside the open document (same folder, a free name
 * from the title), tracked and opened in its own tab; the open document is never changed. (An empty
 * new document is not replaced in place: during the turn its revision belongs to the turn's own
 * editor — the executor's final save would refuse or overwrite a revision written underneath it.)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorkbenchSkill } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

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
};
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

export type HangulMade = Awaited<ReturnType<typeof makeHangulDocument>>;
/**
 * resolve, then (when the request carries any content) compose; copy the HWPX beside the open
 * document; `track` registers it and returns its artifact id. Nothing is written when the runner fails.
 */
export async function makeHangulDocument(skillDir: string, input: HangulInput, target: { documentPath: string; track(path: string): string | null; signal?: AbortSignal }) {
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
    const path = madePath(dirname(target.documentPath), title);
    await copyFile(hwpx.path, path, 1 /* COPYFILE_EXCL: never over a file */);
    const artifactId = target.track(path);
    const markdown = files.find((file) => file.name === "document.md");
    return { made: true as const, ...summary, form: form.form, artifactId, name: basename(path), folder: basename(dirname(path)),
      draft: form.form.templateStatus === "common-draft", markdownPreview: markdown ? (await readFile(markdown.path, "utf8")).slice(0, 4000) : null };
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
}

