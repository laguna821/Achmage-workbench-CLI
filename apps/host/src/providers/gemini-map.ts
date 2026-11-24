import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AccessMode, ApprovalDecision, ItemStatus, ModelOption, PlanStep, TranscriptItem } from "@workbench/contracts";
import { isImage, mentionFiles } from "../attachments.ts";
import type { AttachedFile } from "./types.ts";

// ACP (protocol v1) shapes as agy sends them, mapped to Workbench's transcript items — the same items
// Claude's and Codex's adapters produce, so the transcript, file cards, search, export and the phone page
// draw a Gemini conversation with the components they already have. Pure: tested without a process.

export type AcpContent = { type: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string } };
export type AcpToolContent =
  | { type: "content"; content: AcpContent }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };
export type AcpToolCall = {
  toolCallId: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  content?: AcpToolContent[] | null;
  locations?: { path: string; line?: number | null }[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
};
export type AcpPlanEntry = { content: string; priority?: string; status?: string };
export type AcpSelectOption = { value: string; name: string; description?: string | null };
export type AcpConfigOption = { id: string; name: string; category?: string | null; type: string; currentValue: string | boolean; options?: (AcpSelectOption | { group: string; name: string; options: AcpSelectOption[] })[] };
export type AcpPermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string };

const MAX_OUTPUT = 20_000;
const clip = (text: string | null | undefined, max = MAX_OUTPUT) => (!text ? null : text.length > max ? `${text.slice(0, max)}\n…` : text);

export function toolStatus(status: string | undefined, previous?: ItemStatus): ItemStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "pending" || status === "in_progress") return "running";
  return previous ?? "running";
}

/** Text of content blocks (a tool's output, a message chunk). */
export function contentText(content: AcpContent | null | undefined): string {
  if (!content) return "";
  if (content.type === "text") return content.text ?? "";
  if (content.type === "resource_link") return content.uri ?? content.name ?? "";
  if (content.type === "resource") return content.resource?.text ?? content.resource?.uri ?? "";
  return "";
}

/** A diff block as unified-looking text (what the file-change step shows under its card). */
export function diffText(diff: { path: string; oldText?: string | null; newText: string }): string {
  const before = (diff.oldText ?? "").split("\n"), after = diff.newText.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const lines = [`--- ${diff.oldText == null ? "/dev/null" : diff.path}`, `+++ ${diff.path}`, `@@ -${start + 1},${endBefore - start} +${start + 1},${endAfter - start} @@`];
  for (const line of before.slice(start, endBefore)) lines.push(`-${line}`);
  for (const line of after.slice(start, endAfter)) lines.push(`+${line}`);
  return lines.join("\n");
}

const commandOf = (call: AcpToolCall) => {
  const input = call.rawInput as { command?: unknown; CommandLine?: unknown; cmd?: unknown } | null | undefined;
  const value = input?.command ?? input?.CommandLine ?? input?.cmd;
  return Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : null;
};

/**
 * One ACP tool call (`tool_call`, merged with its `tool_call_update`s) as a transcript step. `edit` /
 * `delete` / `move` are file changes (their paths make file cards that open document tabs once completed);
 * `read` names what it read; `execute` is a command; `search` / `fetch` as Codex's search and web steps.
 */
export function mapToolCall(call: AcpToolCall, cwd: string, at: number, previous?: Extract<TranscriptItem, { kind: "tool" }>): Extract<TranscriptItem, { kind: "tool" }> {
  const status = toolStatus(call.status, previous?.status);
  const abs = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
  const diffs = (call.content ?? []).filter((entry): entry is Extract<AcpToolContent, { type: "diff" }> => entry.type === "diff");
  const texts = (call.content ?? []).flatMap((entry) => (entry.type === "content" ? [contentText(entry.content)] : [])).filter(Boolean);
  const located = (call.locations ?? []).map((location) => abs(location.path));
  const base = { kind: "tool" as const, id: `acp:${call.toolCallId}`, at: previous?.at ?? at, status };
  const title = call.title?.trim() || previous?.title || call.name || "도구";
  switch (call.kind) {
    case "edit":
    case "delete":
    case "move": {
      const paths = [...new Set([...diffs.map((diff) => abs(diff.path)), ...located, ...(previous?.paths ?? [])])];
      const output = diffs.length ? clip(diffs.map(diffText).join("\n")) : clip(texts.join("\n")) ?? previous?.output ?? null;
      return { ...base, tool: "fileChange", title: paths.length === 1 ? paths[0]! : paths.length ? `파일 ${paths.length}개 변경` : title, detail: paths.join("\n") || null, output, ...(paths.length ? { paths } : {}) };
    }
    case "read": {
      const reads = [...new Set([...located, ...(previous?.reads ?? [])])];
      return { ...base, tool: "search", title: reads.length === 1 ? `읽기 ${reads[0]}` : title, detail: null, output: clip(texts.join("\n")) ?? previous?.output ?? null, ...(reads.length ? { reads } : {}) };
    }
    case "execute": {
      const command = commandOf(call) ?? previous?.title ?? title;
      return { ...base, tool: "command", title: command, detail: cwd, output: clip(texts.join("\n")) ?? previous?.output ?? null };
    }
    case "search":
      return { ...base, tool: "search", title, detail: null, output: clip(texts.join("\n")) ?? previous?.output ?? null };
    case "fetch":
      return { ...base, tool: "web", title, detail: null, output: clip(texts.join("\n")) ?? previous?.output ?? null };
    default:
      return { ...base, tool: previous?.tool ?? (call.name?.startsWith("mcp") || /__/.test(call.name ?? "") ? "mcp" : "other"), title, detail: previous?.detail ?? null, output: clip(texts.join("\n")) ?? previous?.output ?? null };
  }
}

/** Merge a `tool_call_update` into what is known of the call (fields it leaves out stay). */
export function mergeToolCall(known: AcpToolCall | undefined, update: AcpToolCall): AcpToolCall {
  if (!known) return update;
  return {
    ...known,
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)),
    content: update.content ?? known.content,
    locations: update.locations ?? known.locations,
  } as AcpToolCall;
}

export function mapPlan(entries: AcpPlanEntry[]): PlanStep[] {
  return entries.map((entry) => ({ text: entry.content, status: entry.status === "completed" ? "completed" : entry.status === "in_progress" ? "inProgress" : "pending" }));
}

const selectValues = (option: AcpConfigOption | undefined): AcpSelectOption[] =>
  (option?.options ?? []).flatMap((entry) => ("options" in entry ? entry.options : [entry]));

export const configByCategory = (options: AcpConfigOption[] | null | undefined, category: string) => (options ?? []).find((option) => option.category === category && option.type === "select");

/**
 * The model picker from the session's own selectors (§ G rule 8): the `model` option's values, each
 * with the `thought_level` values as its efforts. Nothing hard-coded: what agy offers this account.
 * The older `models` field (`availableModels`) is read when there is no config option.
 */
export function modelsFromConfig(options: AcpConfigOption[] | null | undefined, legacy?: { currentModelId?: string; availableModels?: { modelId: string; name: string; description?: string | null }[] } | null): ModelOption[] {
  const model = configByCategory(options, "model");
  const thought = configByCategory(options, "thought_level");
  const efforts = selectValues(thought).map((entry) => entry.value);
  const defaultEffort = typeof thought?.currentValue === "string" ? thought.currentValue : null;
  if (model) {
    return selectValues(model).map((entry) => ({ id: entry.value, label: entry.name || entry.value, description: entry.description ?? null, efforts, defaultEffort, isDefault: entry.value === model.currentValue }));
  }
  return (legacy?.availableModels ?? []).map((entry) => ({ id: entry.modelId, label: entry.name || entry.modelId, description: entry.description ?? null, efforts, defaultEffort, isDefault: entry.modelId === legacy?.currentModelId }));
}

/** Effort ids Workbench shows with labels it knows ("낮음", "높음") are agy's own values; anything else shows as agy names it. */
export function effortLabels(options: AcpConfigOption[] | null | undefined): Record<string, string> {
  return Object.fromEntries(selectValues(configByCategory(options, "thought_level")).map((entry) => [entry.value, entry.name]));
}

/**
 * The agy session mode for a Workbench access (§ G rule 5): 묻기 → `default`, 자동 → `accept-edits`,
 * 계획 먼저 → `plan`. There is no 전체 접근 for Gemini (subscription login only): it is treated as 자동, and
 * `--dangerously-skip-permissions` is never used.
 */
export function modeFor(access: AccessMode, plan: boolean, available: string[]): string | null {
  const want = plan ? "plan" : access === "ask" ? "default" : "accept-edits";
  if (!available.length) return want;
  if (available.includes(want)) return want;
  return available.includes("default") ? "default" : null;
}

/** The access a Gemini conversation actually runs with: never 전체. */
export function effectiveAccess(access: AccessMode): AccessMode {
  return access === "full" ? "auto" : access;
}

/**
 * The option to send for a decision: accept → allow once, never "allow always" on the person's behalf (null when
 * agy offers no "once"); decline → reject once, else any reject offered (security review 5).
 */
export function permissionOption(options: AcpPermissionOption[], decision: ApprovalDecision): string | null {
  const order = decision === "accept" ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found.optionId;
  }
  return null;
}

/** The approval card for a permission request: what agy wants to do, in the words the other engines' cards use. */
export function approvalCard(itemId: string, call: AcpToolCall | undefined, cwd: string, at: number): Extract<TranscriptItem, { kind: "approval" }> {
  const kind = call?.kind;
  const paths = [...(call?.content ?? []).flatMap((entry) => (entry.type === "diff" ? [entry.path] : [])), ...(call?.locations ?? []).map((location) => location.path)].map((path) => (isAbsolute(path) ? path : resolve(cwd, path)));
  const command = call ? commandOf(call) : null;
  const title = kind === "edit" || kind === "delete" || kind === "move" ? "파일을 변경할까요?" : kind === "execute" ? "이 명령을 실행할까요?" : kind === "fetch" ? "웹에서 가져올까요?" : `${call?.title ?? "이 도구"}를 쓸까요?`;
  return { kind: "approval", id: itemId, title, detail: command ?? ([...new Set(paths)].join("\n") || call?.title || null), reason: null, decision: null, at };
}

/**
 * A request as ACP content (§ "image content"): the text (other files named by path, as for Codex),
 * pictures as image blocks (base64, agy caps them at 2000 px itself). `images: false` when agy did not
 * offer image prompts: pictures are then named by path like any file.
 */
export function promptBlocks(text: string, files: AttachedFile[], options: { images: boolean } = { images: true }): AcpContent[] {
  const pictures = options.images ? files.filter((file) => isImage(file.mime)) : [];
  const others = files.filter((file) => !pictures.includes(file));
  const blocks: AcpContent[] = [{ type: "text", text: mentionFiles(text, others) }];
  for (const file of pictures) {
    try {
      blocks.push({ type: "image", mimeType: file.mime, data: readFileSync(file.path).toString("base64") });
    } catch { /* gone meanwhile: the text still names nothing missing */ }
  }
  return blocks;
}

/**
 * Where a path really lands: relative to the project folder, links followed. A file that does not exist yet
 * resolves through its nearest existing folder (a link to the vault one level up is still the vault).
 */
export function realTarget(path: string, cwd: string): string {
  let at = isAbsolute(path) ? path : resolve(cwd, path);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(at), ...rest.reverse()); } catch { /* not there yet: one folder up */ }
    const up = dirname(at);
    if (up === at) return resolve(path);
    rest.push(basename(at));
    at = up;
  }
}

/** Every path an edit names: its diffs, its locations, and the path fields agy puts in its raw input. */
export function editTargets(call: AcpToolCall | undefined, cwd: string): string[] {
  if (!call) return [];
  const input = (call.rawInput ?? {}) as Record<string, unknown>;
  const raw = ["Path", "path", "file_path", "filePath", "TargetFile", "target", "destination", "newPath", "old_path", "new_path"].map((key) => input[key]).filter((value): value is string => typeof value === "string" && value.length > 0);
  const named = [...(call.content ?? []).flatMap((entry) => (entry.type === "diff" ? [entry.path] : [])), ...(call.locations ?? []).map((location) => location.path), ...raw];
  return [...new Set(named.map((path) => realTarget(path, cwd)))];
}

/** The path is one of the roots or inside one (both with links followed). */
export function insideAny(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const real = realTarget(root, "/");
    const way = relative(real, path);
    return way === "" || (!way.startsWith("..") && !isAbsolute(way));
  });
}

/**
 * agy said Google blocked this account (study § H: "accounts blocked for a Terms of Service violation", with an
 * appeal link). Its address is kept only when it is Google's own (https, *.google.com or *.google); null otherwise.
 * Null when the text is not such a refusal (signed out, quota, a model error).
 */
export function suspensionOf(text: string): { appeal: string | null } | null {
  const tos = /terms of service|\btos\b/i.test(text) && /(violat|suspend|disabl|block|terminat|banned)/i.test(text);
  const account = /(account|access)[^.]{0,60}\b(suspended|disabled|blocked|terminated|banned)\b/i.test(text);
  if (!tos && !account) return null;
  const google = (raw: string) => {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" && (url.hostname === "google.com" || url.hostname.endsWith(".google.com") || url.hostname.endsWith(".google"));
    } catch { return false; }
  };
  const links = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((match) => match[0].replace(/[.,;:]+$/, "")).filter(google);
  return { appeal: links.find((link) => /appeal/i.test(link)) ?? links[0] ?? null };
}
