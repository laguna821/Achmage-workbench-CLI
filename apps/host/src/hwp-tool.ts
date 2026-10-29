import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, constants, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { hwpToText } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { editHwp, hwpCatalog } from "./hwp-ops.mjs";
import { hwpFormat, HWP_MAX_BYTES, openHwpBytes } from "./hwp-codec.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const guide = { usage: "workbench-hwp read <file> [--offset n] [--max-chars n|--full] | apply <file> --ops <json-file|-> [--dry-run] [--best-effort|--stop-on-error] [--out path] [--force] | catalog", note: "Operations are the pinned Ieum HWP editor's operations. Edit only the designated proposal copy. A rejected atomic batch writes nothing; overwritten files keep a unique .bak copy." };

export async function runHwpTool(argv: string[], input = () => readFileSync(0, "utf8")) {
  const flags = new Map<string, string | boolean>(), positional: string[] = [];
  const values = new Set(["ops", "out", "offset", "max-chars"]), bools = new Set(["json", "full", "dry-run", "best-effort", "stop-on-error", "force"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (flags.has(key)) throw new Error(`Duplicate option --${key}`);
    if (bools.has(key)) flags.set(key, true);
    else if (values.has(key) && argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags.set(key, argv[++i]!);
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  const [command, file] = positional;
  if (!command || command === "help") return { status: "ok", ...guide };
  if (command === "catalog") return { status: "ok", ...guide, catalog: await hwpCatalog() };
  if ((command !== "read" && command !== "apply") || !file || positional.length !== 2) throw new Error(guide.usage);
  const path = resolve(file), format = hwpFormat(extname(path).slice(1).toLowerCase());
  if (statSync(path).size > HWP_MAX_BYTES) throw new Error("Document exceeds the size limit.");
  const bytes = readFileSync(path); await openHwpBytes(bytes, format);
  if (command === "read") {
    const text = await hwpToText(bytes), offset = Number(flags.get("offset") ?? 0), max = flags.get("full") ? text.length : Number(flags.get("max-chars") ?? 24000);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(max) || max < 0) throw new Error("Invalid text offset or length.");
    const end = Math.min(text.length, offset + max);
    return { status: "ok", format, chars: text.length, offset, text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
  }
  const opFile = flags.get("ops");
  if (typeof opFile !== "string") throw new Error("apply requires --ops <json-file|->");
  if (opFile !== "-" && statSync(opFile).size > 10_000_000) throw new Error("Operation file exceeds the size limit.");
  const source = opFile === "-" ? input() : readFileSync(opFile, "utf8");
  if (source.length > 10_000_000) throw new Error("Operation input exceeds the size limit.");
  const parsed = JSON.parse(source), ops: unknown = Array.isArray(parsed) ? parsed : parsed?.ops;
  if (!Array.isArray(ops)) throw new Error("Operations must be an array or {ops: [...]}.");
  if (flags.get("best-effort") && flags.get("stop-on-error")) throw new Error("Choose one batch mode.");
  const output = typeof flags.get("out") === "string" ? resolve(String(flags.get("out"))) : path;
  if (hwpFormat(extname(output).slice(1).toLowerCase()) !== format) throw new Error("This edit keeps the source format. Use the editor's export for format conversion.");
  const targetBytes = existsSync(output) ? readFileSync(output) : null;
  if (output !== path && targetBytes && !flags.get("force")) throw new Error("Output already exists; choose a new path or pass --force.");
  const result = await editHwp(bytes, format, ops, { dryRun: flags.has("dry-run"), mode: flags.get("best-effort") ? "best_effort" : flags.get("stop-on-error") ? "stop_on_error" : "atomic" });
  const { bytes: edited, ...detail } = result;
  if (!result.results.length && result.failures.length) throw new Error(`No operations applied: ${result.failures[0]!.error}`);
  if (flags.has("dry-run") || (!result.changed && output === path)) return { status: result.failures.length ? "partial" : "ok", ...detail, written: false };
  if (digest(readFileSync(path)) !== digest(bytes)) throw new Error("Input changed during editing; nothing was written.");
  if (targetBytes ? !existsSync(output) || digest(readFileSync(output)) !== digest(targetBytes) : existsSync(output)) throw new Error("Output changed during editing; nothing was written.");
  let backup: string | null = null;
  if (targetBytes) {
    backup = `${output}.${randomUUID()}.bak`; copyFileSync(output, backup, constants.COPYFILE_EXCL);
  }
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, edited, { flag: "wx" });
    // Copy exclusively for a new destination; rename atomically for an existing one.
    if (targetBytes) renameSync(temporary, output); else copyFileSync(temporary, output, constants.COPYFILE_EXCL);
  } finally { rmSync(temporary, { force: true }); }
  return { status: result.failures.length ? "partial" : "ok", ...detail, written: true, output, backup, sha256: digest(edited) };
}
