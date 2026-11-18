import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hwpLossMessageBox } from "./office-convert-ledger.mjs";
import { HttpError } from "./errors.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
import { repoRoot } from "./resources.ts";

// The conversions IeumOffice v0.13.0 brought (unit conv2), as the gateway runs them:
//   Word → Hangul ("한글 문서로 내보내기" of a Word document): packages/docx2hwp on Workbench's one Hangul engine.
//   변환해서 열기: .doc → .docx (packages/doc2docx), .ppt → .pptx (packages/ppt2pptx), .ods → .xlsx (the xlsx engine's
//   ODS reader); and old .xls → .xlsx for the office command line (office-cli-input.ts), on the same engine.
// Every conversion runs in a child process of its own (office-convert-job.mjs beside the gateway bundle), one at
// a time and bounded in time: thousands of engine calls never hold the gateway's event loop, and the engine's
// WASM memory goes back when the child exits. The heavy code is office-convert-work.mjs; this file is the light half.

export type LegacyKind = "doc" | "ppt" | "ods";
/** docx2hwp's report entry (packages/docx2hwp/src/losses.ts): a feature id, gone or changed, how many. */
export type Loss = { feature: string; kind: "dropped" | "changed"; count: number };
/** The format each legacy kind opens as. */
export const LEGACY_TARGET: Readonly<Record<LegacyKind, "docx" | "pptx" | "xlsx">> = { doc: "docx", ppt: "pptx", ods: "xlsx" };
export const isLegacyKind = (format: string): format is LegacyKind => format === "doc" || format === "ppt" || format === "ods";

export type ConvertJob =
  | { kind: "docx-hwp"; input: string; output: string; format: "hwp" | "hwpx"; hwpWasm: string }
  | { kind: "doc" | "ppt"; input: string; output: string }
  | { kind: "ods" | "xls"; input: string; output: string; xlsxWasm: string };
export type ConvertReply =
  | { ok: true; losses?: Loss[]; warnings?: string[]; slides?: number; formulasDropped?: number; sheets?: number }
  | { ok: false; code: string; detail: string };

/** A conversion of 200+ pages is about 11 s on upstream's machine; a slow machine and a big deck get room. */
export const CONVERT_TIMEOUT = 180_000;
export const CONVERT_MAX_BYTES = 200 * 1024 * 1024;

/** The job file: beside the gateway bundle (built by scripts/build-host.mjs). */
export function convertJobEntry(): string | null {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "office-convert-job.mjs");
  return existsSync(bundled) ? bundled : null;
}

/** The xlsx engine's WebAssembly (the Excel editor's own build): beside the bundle, or the office build's output in a checkout. */
export function xlsxWasmPath(): string | null {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "xlsx-engine.wasm");
  if (existsSync(bundled)) return bundled;
  const root = repoRoot();
  const built = root ? join(root, "apps/office/src/sheets/xlsx-engine.wasm") : null;
  return built && existsSync(built) ? built : null;
}

/** What the child sees of the environment: no token, vault, engine or session variable. */
const PASSED = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "USERPROFILE", "LOCALAPPDATA"] as const;
const childEnv = () => Object.fromEntries(PASSED.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));

/** Run a job in-process instead (tests: the job file exists only in a build). */
export type ConvertWorker = (job: ConvertJob) => Promise<ConvertReply>;

/**
 * A source checkout without a gateway build (the tests): the work module in this process. Its address is
 * computed so the bundler never pulls the converters into host.mjs (the bundle has its job file instead).
 */
const sourceWorker: ConvertWorker = async (job) => {
  const work = new URL("./office-convert-work.mjs", import.meta.url);
  return ((await import(/* @vite-ignore */ work.href)) as { runConvertJob: ConvertWorker }).runConvertJob(job);
};

let running: Promise<unknown> = Promise.resolve();
/** One conversion after the other: two engines at once would double the memory. */
export function runConvert(job: ConvertJob, worker?: ConvertWorker, timeoutMs = CONVERT_TIMEOUT): Promise<ConvertReply> {
  const chosen = worker ?? (!convertJobEntry() && repoRoot() ? sourceWorker : undefined);
  const turn = running.then(() => chosen ? chosen(job) : runChild(job, timeoutMs));
  running = turn.catch(() => undefined);
  return turn;
}

function runChild(job: ConvertJob, timeoutMs: number): Promise<ConvertReply> {
  const entry = convertJobEntry();
  if (!entry) return Promise.resolve({ ok: false, code: "no-job", detail: "office-convert-job.mjs is missing" });
  return new Promise((done) => {
    let child: ReturnType<typeof fork>;
    try { child = fork(entry, [String(timeoutMs + 5_000)], { execArgv: [], env: childEnv(), stdio: ["ignore", "ignore", "pipe", "ipc"] }); }
    catch (error) { return done({ ok: false, code: "spawn", detail: String(error) }); }
    // Diagnostics drained, never logged: they can quote the document.
    child.stderr?.resume();
    let settled = false;
    const finish = (reply: ConvertReply) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      done(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", detail: `no answer in ${timeoutMs} ms` }), timeoutMs);
    child.once("message", (message) => finish(message as ConvertReply));
    child.once("error", (error) => finish({ ok: false, code: "spawn", detail: error.message }));
    child.once("exit", (code) => finish({ ok: false, code: "exited", detail: `exit ${code}` }));
    child.send(job);
  });
}

/** Bytes in, bytes out, through a private temp folder (removed after). */
async function convertBytes(make: (input: string, output: string) => ConvertJob, bytes: Uint8Array, worker?: ConvertWorker) {
  if (bytes.length > CONVERT_MAX_BYTES) throw new HttpError(413, "convert_too_large", "파일이 200 MB보다 커서 변환하지 않았습니다.");
  const folder = mkdtempSync(join(tmpdir(), "wb-office-convert-"));
  try {
    const input = join(folder, "input"), output = join(folder, "output");
    writeFileSync(input, bytes, { mode: 0o600 });
    const reply = await runConvert(make(input, output), worker);
    return { reply, bytes: reply.ok ? readFileSync(output) : null };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

// ---- Word → Hangul ------------------------------------------------------------------------------------

/** The ledger, in upstream's own Korean words (apps/docs hwpLossMessageBox, the same strings as IeumOffice's dialog). */
export type LossLedger = { title: string; message: string; sections: { heading: string; items: string[] }[] };
export function lossLedger(losses: readonly Loss[], passwordDropped = false): LossLedger {
  const box = hwpLossMessageBox(losses, passwordDropped, "ko");
  const sections = (box.detail ?? "").split("\n\n").filter(Boolean).map((block) => {
    const [heading = "", ...lines] = block.split("\n");
    return { heading, items: lines.map((line) => line.replace(/^• /, "")) };
  });
  return { title: box.title ?? "한글 문서로 내보내기", message: box.message, sections };
}

/** Why no Hangul file was made, in words a person can act on. */
function hangulRefusal(code: string, format: "hwp" | "hwpx") {
  if (code === "hwp-readback") return new HttpError(422, "hwp_readback", "이 문서는 .hwp로 정확히 쓰지 못했습니다(다시 읽은 쪽 수가 달랐습니다). 한글 HWPX로 내보내 보세요.");
  if (code === "not-docx") return new HttpError(415, "not_docx", "워드 문서(.docx)로 읽지 못했습니다. 암호가 걸린 문서는 암호를 푼 뒤 내보내 주세요.");
  if (code === "timeout") return new HttpError(504, "convert_timeout", "변환이 너무 오래 걸려 멈췄습니다. 문서를 나눠서 다시 해 보세요.");
  if (code === "no-job") return new HttpError(501, "convert_missing", "변환 도구가 이 설치에 없습니다. 앱을 다시 설치해 주세요.");
  return new HttpError(422, "convert_failed", `${format === "hwp" ? "HWP" : "HWPX"} 문서를 만들지 못했습니다. 다시 해 보고, 같으면 문서를 나눠서 해 보세요.`);
}

/** docx → .hwpx/.hwp bytes and what the copy loses. A .hwp comes only when the engine reads it back with the same page count. */
export async function wordToHangul(docx: Uint8Array, format: "hwp" | "hwpx", worker?: ConvertWorker) {
  const hwpWasm = hwpWasmPath();
  const { reply, bytes } = await convertBytes((input, output) => ({ kind: "docx-hwp", input, output, format, hwpWasm }), docx, worker);
  if (!reply.ok || !bytes) throw hangulRefusal(reply.ok ? "failed" : reply.code, format);
  return { bytes, losses: reply.losses ?? [] };
}

// ---- 변환해서 열기 ---------------------------------------------------------------------------------------

/** doc2docx's warnings (English, technical) as the few things a person recognizes. */
const DOC_LOSSES: [RegExp, string][] = [
  [/picture|image|bitmap|metafile|jpeg|png|dib|pict/i, "그림 일부"],
  [/header|footer/i, "머리말·꼬리말 일부"],
  [/table|cell|row/i, "표 서식 일부"],
  [/comment/i, "메모 일부"],
  [/list/i, "번호 매기기 일부"],
  [/style/i, "스타일(직접 서식으로 옮김)"],
  [/text box|shape/i, "글상자·도형 일부"],
  [/field|hyperlink/i, "필드·링크(글로 남음)"],
  [/font/i, "글꼴 이름 일부"],
];
export function docLosses(warnings: readonly string[]) {
  const found: string[] = [];
  for (const warning of warnings) {
    if (/already Office Open XML/i.test(warning)) continue;
    const name = DOC_LOSSES.find(([pattern]) => pattern.test(warning))?.[1] ?? "그 밖의 서식 일부";
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * The one line that says what did not come along and where the copy came from — what is lost first, because
 * the bar's notice shows the start of a long line.
 */
export function legacyLine(kind: LegacyKind, source: string, made: Extract<ConvertReply, { ok: true }>) {
  let lost: string;
  if (kind === "ppt") {
    lost = `슬라이드 노트·애니메이션은 옮기지 않았습니다.${(made.warnings ?? []).some((warning) => /picture/i.test(warning)) ? " 읽지 못한 그림도 빠졌습니다." : ""}`;
  } else if (kind === "doc") {
    const parts = docLosses(made.warnings ?? []);
    lost = parts.length ? `옮기지 못한 것: ${parts.join(", ")}.` : "변환기가 알린 빠진 내용은 없습니다.";
  } else {
    const dropped = made.formulasDropped ?? 0;
    lost = dropped ? `수식 ${dropped}개는 옮기지 못해 계산된 값만 남겼습니다.` : "수식과 값은 모두 옮겼습니다.";
  }
  return `${LEGACY_TARGET[kind].toUpperCase()} 사본으로 열었습니다. ${lost} 원본 「${source}」은 그대로 둡니다.`;
}

function legacyRefusal(kind: LegacyKind | "xls", code: string) {
  if (code === "encrypted") return new HttpError(422, "legacy_encrypted", "암호가 걸린 파일이라 변환하지 못했습니다. 만든 프로그램에서 암호를 푼 뒤 다시 해 주세요.");
  if (code === "timeout") return new HttpError(504, "convert_timeout", "변환이 너무 오래 걸려 멈췄습니다.");
  if (code === "no-job" || code === "no-engine") return new HttpError(501, "convert_missing", "변환 도구가 이 설치에 없습니다. 앱을 다시 설치해 주세요.");
  const name = kind === "doc" ? "워드 97-2003 문서" : kind === "ppt" ? "파워포인트 97-2003 파일" : kind === "ods" ? "ODS 스프레드시트" : "엑셀 97-2003 파일";
  return new HttpError(422, "legacy_unreadable", `${name}로 읽지 못했습니다. 파일이 손상됐거나 다른 형식일 수 있습니다.`);
}

/** .doc / .ppt / .ods (and .xls) bytes → the modern file's bytes and what the converter said. */
export async function convertLegacy(kind: LegacyKind | "xls", source: Uint8Array, worker?: ConvertWorker) {
  let job: (input: string, output: string) => ConvertJob;
  if (kind === "doc" || kind === "ppt") job = (input, output) => ({ kind, input, output });
  else {
    const xlsxWasm = xlsxWasmPath();
    if (!xlsxWasm) throw legacyRefusal(kind, "no-engine");
    job = (input, output) => ({ kind, input, output, xlsxWasm });
  }
  const { reply, bytes } = await convertBytes(job, source, worker);
  if (!reply.ok || !bytes) throw legacyRefusal(kind, reply.ok ? "failed" : reply.code);
  return { bytes, reply };
}
