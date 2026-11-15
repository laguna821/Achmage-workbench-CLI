import { STAGE_KEY, type ProjectEntry } from "@workbench/contracts";
import { parseDocument } from "yaml";
import { KEY_LINE, parseFrontmatter, splitFrontmatter, unquote, valuesOf } from "./frontmatter.ts";
import { yamlValue } from "./pages.ts";

// The text of a project note, changed the way a person would: only the key or line that changes is
// rewritten; every other byte (other keys, their order and quoting, blank lines, line endings, the
// body) stays as it was. Pure functions, so every rule here is tested on strings.

export const ID_KEY = "workbench_id";
const DECISIONS = "결정";
const QUESTIONS = "열린 질문";
/** Keys written as lists even with one value. */
const LIST_KEYS = new Set(["tags", "aliases", "관련"]);

const lineEnding = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** The text split into lines that keep their own line ending. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Where the front matter's lines are (between the `---` lines), or null when the note has none. */
function frontmatterRange(text: string): { start: number; end: number } | null {
  const offset = text.startsWith("﻿") ? 1 : 0;
  const source = text.slice(offset);
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) return null;
  const rest = source.slice(open[0].length);
  const close = /^(---|\.\.\.)[ \t]*\r?$/m.exec(rest);
  if (!close) return null;
  const start = offset + open[0].length;
  return { start, end: start + close.index };
}

const keyName = (match: RegExpExecArray) => (match[1] !== undefined ? unquote(`"${match[1]}"`) : match[2] !== undefined ? match[2].replace(/''/g, "'") : match[3]!.trim());

/** A key as YAML: plain when that is safe, double-quoted otherwise (`"DIKM_단계:"`). */
export function yamlKey(key: string) {
  return /^[^\s#'"\-?:,[\]{}&*!|>%@`][^:#]*$/.test(key) && !/\s$/.test(key) ? key : JSON.stringify(key);
}

function renderKey(key: string, values: string[], style: "scalar" | "block" | "inline", nl: string, raw = false): string {
  const head = `${yamlKey(key)}:`;
  const value = raw ? (text: string) => text : yamlValue;
  if (style === "scalar") return `${values.length ? `${head} ${value(values[0]!)}` : head}${nl}`;
  if (style === "inline") return `${head} [${values.map(value).join(", ")}]${nl}`;
  return values.length ? `${head}${nl}${values.map((entry) => `  - ${value(entry)}${nl}`).join("")}` : `${head}${nl}`;
}

/** How a value is written: `list` as a YAML list even with one item (Obsidian's lists, tags, links); `raw` unquoted (numbers, true/false). */
export type KeyStyle = { list?: boolean; raw?: boolean };

/**
 * Why a key was not written: `opaque` (a block or folded scalar, a map, an anchor, a list with
 * comments — shown, edited only in the source), `shape` (more values than a scalar holds),
 * `invalid` / `changed` (the result would not read, or would read differently elsewhere),
 * `unreadable` (the front matter does not read now), `moved` (the text changed under the edit).
 */
export type FrontmatterEditCode = "opaque" | "shape" | "invalid" | "changed" | "unreadable" | "moved" | "frontmatter" | "structure";
export class FrontmatterEditError extends Error {
  readonly code: FrontmatterEditCode;
  constructor(code: FrontmatterEditCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A key's value as the page may edit it. */
export type KeyShape = "empty" | "scalar" | "flow" | "block" | "opaque";

/** An edit of the note: exactly one span of the current text, replaced. Nothing else changes. */
export type Span = { start: number; end: number; replacement: string };
/** The text with the span replaced: `before[0:start] + replacement + before[end:]`, and nothing else. */
export const applySpan = (text: string, span: Span) => text.slice(0, span.start) + span.replacement + text.slice(span.end);

const isIndented = (line: string | undefined) => line !== undefined && /^[ \t]+\S/.test(line);
const bare = (line: string) => line.replace(/\r?\n$/, "");

/** The value text after a key's colon, split into the value, its quoting and a trailing comment; null when it is not one plain value. */
function inlineValue(rest: string): { value: string; quote: '"' | "'" | ""; comment: string } | null {
  const text = rest.trimEnd();
  const quoted = /^"(?:[^"\\]|\\.)*"|^'(?:[^']|'')*'/.exec(text);
  if (quoted) {
    const after = text.slice(quoted[0].length);
    if (after && !/^[ \t]+#/.test(after)) return null;
    return { value: quoted[0], quote: quoted[0][0] as '"' | "'", comment: after };
  }
  const comment = /[ \t]+#.*$/.exec(text);
  return { value: comment ? text.slice(0, comment.index) : text, quote: "", comment: comment ? comment[0] : "" };
}

/** One list item: its value's own text (`start`..`end`) and, for a block list, its whole line. */
type Item = { start: number; end: number; value: string; quote: '"' | "'" | ""; line?: { start: number; end: number } };

/** A top-level key in the front matter, with the offsets of everything an edit may touch (all in the whole text). */
type KeyInfo = {
  shape: KeyShape;
  /** The key's lines, children included (end after the last line's ending). */
  start: number;
  end: number;
  /** Right after the colon; and the end of the key line's text (before its ending). */
  colon: number;
  lineEnd: number;
  /** A scalar's (or flow list's) own text, without a trailing comment. */
  value: { start: number; end: number; quote: '"' | "'" | "" } | null;
  items: Item[];
  /** A flow list's `]`. */
  close: number;
  indent: string;
  dash: string;
};

/** The items of a flow list between `[` (at `open`) and `]` (at `close`), quotes and escapes respected. */
function flowItems(text: string, open: number, close: number): Item[] | null {
  const out: Item[] = [];
  let start = -1;
  let quote: string | null = null;
  const push = (end: number) => {
    if (start < 0) return;
    const raw = text.slice(start, end).trimEnd();
    if (raw) out.push({ start, end: start + raw.length, value: unquote(raw), quote: /^["']/.test(raw) ? (raw[0] as '"' | "'") : "" });
    start = -1;
  };
  for (let at = open + 1; at < close; at += 1) {
    const character = text[at]!;
    if (quote) {
      if (quote === '"' && character === "\\") at += 1;
      else if (character === quote) {
        if (quote === "'" && text[at + 1] === "'") at += 1;
        else quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      if (start < 0) start = at;
      quote = character;
    } else if (character === ",") push(at);
    else if (start < 0 && !/\s/.test(character)) start = at;
  }
  if (quote) return null;
  push(close);
  return out;
}

/** Where a top-level key is and its shape: what the page may edit, and the offsets to edit it at. */
function keyInfo(text: string, key: string): KeyInfo | null {
  const range = frontmatterRange(text);
  if (!range) return null;
  const lines = linesOf(text.slice(range.start, range.end));
  const offsets: number[] = [];
  for (let line = 0, at = range.start; line <= lines.length; line += 1) {
    offsets.push(at);
    at += lines[line]?.length ?? 0;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = bare(lines[index]!);
    const match = KEY_LINE.exec(line);
    if (!match || /^[ \t]/.test(line) || keyName(match) !== key) continue;
    let length = 1;
    for (let next = index + 1; next < lines.length; ) {
      if (isIndented(bare(lines[next]!))) { length = next - index + 1; next += 1; continue; }
      if (bare(lines[next]!).trim()) break;
      let after = next;
      while (after < lines.length && !bare(lines[after]!).trim()) after += 1;
      if (!isIndented(after < lines.length ? bare(lines[after]!) : undefined)) break;
      next = after;
    }
    const colonAt = line.length - line.replace(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"-][^:]*?)[ \t]*:/, "").length;
    const rest = line.slice(colonAt);
    const space = /^[ \t]*/.exec(rest)![0];
    const inline = inlineValue(rest.slice(space.length));
    const lineStart = offsets[index]!;
    const info: KeyInfo = { shape: "opaque", start: lineStart, end: offsets[index + length]!, colon: lineStart + colonAt, lineEnd: lineStart + line.length, value: null, items: [], close: -1, indent: "  ", dash: " " };
    if (!inline) return info;
    const valueStart = lineStart + colonAt + space.length;
    if (inline.value) info.value = { start: valueStart, end: valueStart + inline.value.length, quote: inline.quote };
    const value = inline.value;
    // A list written at column 0 under the key (valid YAML, not Obsidian's own shape): left to the source.
    if (length === 1 && !value && /^-([ \t]|$)/.test(bare(lines[index + 1] ?? ""))) return info;
    if (length === 1) {
      if (!value || value === "~" || value === "null") info.shape = "empty";
      else if (/^[|>&*!{?]/.test(value)) info.shape = "opaque";
      else if (value.startsWith("[")) {
        const items = value.endsWith("]") && !/[[\]{}]/.test(value.slice(1, -1).replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, "")) ? flowItems(text, valueStart, valueStart + value.length - 1) : null;
        if (items) Object.assign(info, { shape: "flow", items, close: valueStart + value.length - 1 });
      } else info.shape = "scalar";
      return info;
    }
    if (value) return info;
    // A block list: item lines at one indentation (each may carry its own comment), comment and blank lines between.
    for (let child = index + 1; child < index + length; child += 1) {
      const own = bare(lines[child]!);
      if (!own.trim() || /^[ \t]+#/.test(own)) continue;
      const item = /^([ \t]+)-([ \t]+)(.*)$/.exec(own);
      const parsed = item ? inlineValue(item[3]!) : null;
      if (!item || !parsed || !parsed.value || /^[|>&*!{[?#-]/.test(parsed.value) || (!parsed.quote && /:(\s|$)/.test(parsed.value))) return info;
      if (info.items.length && item[1] !== info.indent) return info;
      if (!info.items.length) Object.assign(info, { indent: item[1], dash: item[2] });
      const start = offsets[child]! + item[1]!.length + 1 + item[2]!.length;
      info.items.push({ start, end: start + parsed.value.length, value: unquote(parsed.value), quote: parsed.quote, line: { start: offsets[child]!, end: offsets[child + 1]! } });
    }
    if (info.items.length) info.shape = "block";
    return info;
  }
  return null;
}

/** Each top-level key's shape, as written. */
export function keyShapes(text: string): Record<string, KeyShape> {
  const range = frontmatterRange(text);
  if (!range) return {};
  const out: Record<string, KeyShape> = {};
  for (const line of linesOf(text.slice(range.start, range.end))) {
    const match = KEY_LINE.exec(bare(line));
    if (!match || /^[ \t]/.test(line)) continue;
    const name = keyName(match);
    if (!(name in out)) out[name] = keyInfo(text, name)?.shape ?? "opaque";
  }
  return out;
}

/** A list key's item values as written (null when the key is not a list). */
export function listValues(text: string, key: string): string[] | null {
  const info = keyInfo(text, key);
  return info && (info.shape === "flow" || info.shape === "block") ? info.items.map((item) => item.value) : null;
}

/** A value in a scalar's own quoting, when that quoting can hold it. */
function scalarText(value: string, quote: '"' | "'" | "", raw: boolean) {
  if (quote === '"') return JSON.stringify(value);
  if (quote === "'" && !/[\r\n]/.test(value)) return `'${value.replace(/'/g, "''")}'`;
  return raw ? value : yamlValue(value);
}

/** A value inside `[…]`: plain when that reads back as the same one item, double-quoted otherwise. */
function flowValue(value: string) {
  const plain = yamlValue(value);
  return plain !== value || /[,[\]{}#]/.test(value) ? JSON.stringify(value) : value;
}

/** What a list edit asks: set the whole list (one item added, removed or renamed), or one of those directly. */
export type KeyChange = { set: string[] | null } | { add: string } | { remove: string } | { rename: [string, string] };
/** A key edit: its one span, and the values the key must read as afterwards (null: the key gone). */
export type KeySpanEdit = Span & { intended: string[] | null };

const oneAtATime = () => new FrontmatterEditError("shape", "목록은 한 번에 한 항목씩 바꿉니다.");

/** The one list operation a requested list is (one added at the end, one removed, one renamed), or null when unchanged. */
function listOperation(current: string[], wanted: string[]): { add: string } | { remove: number } | { rename: [number, string] } | null {
  if (wanted.length === current.length && wanted.every((value, index) => value === current[index])) return null;
  if (wanted.length === current.length + 1 && current.every((value, index) => value === wanted[index])) return { add: wanted.at(-1)! };
  if (wanted.length === current.length - 1) {
    const at = current.findIndex((value, index) => value !== wanted[index]);
    const index = at < 0 ? current.length - 1 : at;
    if ([...current.slice(0, index), ...current.slice(index + 1)].every((value, position) => value === wanted[position])) return { remove: index };
  }
  if (wanted.length === current.length) {
    const differ = current.map((value, index) => (value !== wanted[index] ? index : -1)).filter((index) => index >= 0);
    if (differ.length === 1) return { rename: [differ[0]!, wanted[differ[0]!]!] };
  }
  throw oneAtATime();
}

/**
 * The one span that sets, adds, removes or renames a front matter value, computed from the current
 * text. A scalar's own text; one list item's own text; an insertion point for a new item in the
 * list's style; one item with its own separator; a new key before the closing line; a removed key's
 * lines. Items, comments and quoting outside the span stay as written. Null: nothing to change.
 * Values the page cannot edit safely are refused (FrontmatterEditError).
 */
export function keyEdit(text: string, key: string, change: KeyChange, how: KeyStyle = {}): KeySpanEdit | null {
  const nl = lineEnding(text);
  const range = frontmatterRange(text);
  const c = change as { set?: string[] | null; add?: string; remove?: string; rename?: [string, string] };
  const set = "set" in change ? c.set?.filter((value) => value !== "") ?? null : undefined;
  const listy = how.list ?? (LIST_KEYS.has(key) || (set?.length ?? 0) > 1);
  const token = (value: string) => (how.raw ? value : yamlValue(value));
  const fresh = set !== undefined ? set : "add" in change ? [c.add!] : null;
  if (!range) {
    if (!fresh) return null;
    const bom = text.startsWith("﻿") ? 1 : 0;
    return { start: bom, end: bom, replacement: `---${nl}${renderKey(key, fresh, listy ? "block" : "scalar", nl, how.raw)}---${nl}`, intended: fresh };
  }
  const info = keyInfo(text, key);
  if (!info) {
    if (!fresh) return null;
    return { start: range.end, end: range.end, replacement: renderKey(key, fresh, listy ? "block" : "scalar", nl, how.raw), intended: fresh };
  }
  if (set === null) return { start: info.start, end: info.end, replacement: "", intended: null };
  if (info.shape === "opaque") throw new FrontmatterEditError("opaque", "이 속성은 여러 줄이거나 묶음이라 여기서 고치지 않습니다. 원문에서 고쳐 주세요.");
  if (info.shape === "empty") {
    const values = set ?? ("add" in change ? [c.add!] : []);
    if (!values.length) return null;
    const replacement = listy ? `${nl}${values.map((value) => `  - ${token(value)}`).join(nl)}` : ` ${token(values[0]!)}`;
    // Whatever stood after the colon (`~`, `null`) is the empty value's own text.
    return { start: info.colon, end: info.value ? info.value.end : info.colon, replacement, intended: values };
  }
  if (info.shape === "scalar") {
    const was = unquote(text.slice(info.value!.start, info.value!.end));
    const values = set ?? ("rename" in change ? (c.rename![0] === was ? [c.rename![1]] : [was]) : "remove" in change ? (c.remove === was ? [] : [was]) : [was, c.add!]);
    if (values.length > 1) throw new FrontmatterEditError("shape", "이 속성은 값 하나만 담습니다. 여러 값은 원문에서 목록으로 바꿔 주세요.");
    if (!values.length) return { start: info.colon, end: info.value!.end, replacement: "", intended: [] };
    return { start: info.value!.start, end: info.value!.end, replacement: scalarText(values[0]!, info.value!.quote, Boolean(how.raw)), intended: values };
  }
  // A list: exactly one item added, removed or renamed.
  const current = info.items.map((item) => item.value);
  let operation: ReturnType<typeof listOperation>;
  if (set !== undefined) operation = listOperation(current, set);
  else if ("add" in change) operation = { add: c.add! };
  else if ("remove" in change) {
    const at = current.indexOf(c.remove!);
    operation = at < 0 ? null : { remove: at };
  } else {
    const at = current.indexOf(c.rename![0]);
    operation = at < 0 ? null : { rename: [at, c.rename![1]] };
  }
  if (!operation) return null;
  const items = info.items;
  if ("add" in operation) {
    const intended = [...current, operation.add];
    if (info.shape === "block") return { start: items.at(-1)!.line!.end, end: items.at(-1)!.line!.end, replacement: `${info.indent}-${info.dash}${token(operation.add)}${nl}`, intended };
    const item = how.raw ? operation.add : flowValue(operation.add);
    const trailingComma = items.length > 0 && text.slice(items.at(-1)!.end, info.close).includes(",");
    return { start: info.close, end: info.close, replacement: !items.length ? item : trailingComma ? ` ${item}` : `, ${item}`, intended };
  }
  if ("remove" in operation) {
    const at = operation.remove;
    const intended = current.filter((_, index) => index !== at);
    if (info.shape === "block") return { start: items[at]!.line!.start, end: items[at]!.line!.end, replacement: "", intended };
    // The item and its own separator: the one after it, or before it for the last item.
    if (at < items.length - 1) return { start: items[at]!.start, end: items[at + 1]!.start, replacement: "", intended };
    if (at > 0) return { start: items[at - 1]!.end, end: items[at]!.end, replacement: "", intended };
    return { start: items[at]!.start, end: items[at]!.end, replacement: "", intended };
  }
  const [at, value] = operation.rename;
  const intended = current.map((entry, index) => (index === at ? value : entry));
  const quote = items[at]!.quote;
  const replacement = quote ? scalarText(value, quote, false) : how.raw ? value : info.shape === "flow" ? flowValue(value) : token(value);
  return { start: items[at]!.start, end: items[at]!.end, replacement, intended };
}

/** Set a front matter key (null removes it): `keyEdit` applied (the text unchanged when there is nothing to do). */
export function setFrontmatterKey(text: string, key: string, values: string[] | null, how: KeyStyle = {}): string {
  const edit = keyEdit(text, key, { set: values }, how);
  return edit ? applySpan(text, edit) : text;
}

/** Why the front matter does not read as YAML (null when it does, or there is none). */
export function frontmatterProblem(text: string): string | null {
  const read = strictFrontmatter(text);
  return "error" in read ? read.error : null;
}

/** The front matter as a vault reads it (strict YAML), or the reason it does not read. */
function strictFrontmatter(text: string): { value: Record<string, unknown>; order: string[] } | { error: string } {
  const range = frontmatterRange(text);
  if (!range) return /^\uFEFF?---[ \t]*\r?\n/.test(text) ? { error: "`---`로 닫히지 않았습니다" } : { value: {}, order: [] };
  const document = parseDocument(text.slice(range.start, range.end), { uniqueKeys: true });
  if (document.errors.length) {
    // Said in the file's own line numbers (the front matter starts on line 2).
    const line = document.errors[0]!.linePos?.[0]?.line;
    const duplicate = document.errors[0]!.code === "DUPLICATE_KEY";
    return { error: `${line ? `${line + 1}번째 줄` : "속성 부분"}${duplicate ? "에 같은 이름의 키가 또 있습니다" : "을 YAML로 읽지 못했습니다"}` };
  }
  const value = document.toJS() ?? {};
  if (typeof value !== "object" || Array.isArray(value)) return { error: "키와 값의 묶음이 아닙니다" };
  return { value: value as Record<string, unknown>, order: Object.keys(value) };
}

/**
 * The guard after every key write: the result must read as YAML, and every key but `key` must read
 * exactly as before, in the same order. Otherwise the write is refused and the file left alone.
 */
export function verifyKeyEdit(before: string, after: string, key: string, intended?: string[] | null) {
  const was = strictFrontmatter(before);
  if ("error" in was) throw new FrontmatterEditError("unreadable", `노트의 속성(YAML)을 지금 읽을 수 없어 고치지 않았습니다: ${was.error}`);
  const now = strictFrontmatter(after);
  if ("error" in now) throw new FrontmatterEditError("invalid", `고치면 속성(YAML)이 깨져서 쓰지 않았습니다: ${now.error}`);
  const others = (order: string[]) => order.filter((name) => name !== key);
  // The edited key keeps its place when it stays; a new key may only be added, a removed one only go.
  const kept = was.order.includes(key) && now.order.includes(key);
  const order = kept ? JSON.stringify(was.order) === JSON.stringify(now.order) : JSON.stringify(others(was.order)) === JSON.stringify(others(now.order));
  const same = order && others(was.order).every((name) => JSON.stringify(was.value[name]) === JSON.stringify(now.value[name]));
  if (!same) throw new FrontmatterEditError("changed", "고치면 다른 속성이 달라져서 쓰지 않았습니다. 원문에서 고쳐 주세요.");
  // The edited key itself must read as the values asked for, item for item.
  if (intended === undefined) return;
  if (intended === null) {
    if (now.order.includes(key)) throw new FrontmatterEditError("changed", "속성이 지워지지 않아 쓰지 않았습니다.");
    return;
  }
  const raw = now.value[key];
  const read = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const want = intended.filter((entry) => entry !== "");
  const equal = (a: string, b: string) => a === b || (/^-?\d+(\.\d+)?$/.test(a) && /^-?\d+(\.\d+)?$/.test(b) && Number(a) === Number(b));
  if (read.length !== want.length || !read.every((entry, index) => equal(entry, want[index]!))) {
    throw new FrontmatterEditError("changed", "고치면 이 속성이 뜻과 다르게 읽혀서 쓰지 않았습니다. 원문에서 고쳐 주세요.");
  }
}

/** A key's value as a vault reads it (strict YAML), or undefined when the front matter does not read. */
export function keyValue(text: string, key: string): unknown {
  const read = strictFrontmatter(text);
  return "error" in read ? undefined : read.value[key];
}

/** Lines and where each starts in the text (one more offset: the end). */
function lineOffsets(text: string) {
  const lines = linesOf(text);
  const offsets: number[] = [];
  for (let line = 0, at = 0; line <= lines.length; line += 1) {
    offsets.push(at);
    at += lines[line]?.length ?? 0;
  }
  return { lines, offsets };
}

/** Whether `at` starts a line: the text before it is empty, only a BOM, or ends with a line ending. */
const startsLine = (text: string, at: number) => at === 0 || (at === 1 && text.startsWith("﻿")) || text[at - 1] === "\n";

/**
 * The span for one run of the note's words (run `index`, which must read `expected` now), retyped.
 * Boundaries are terminated from the bytes, not the editor's text: words that do not start a line
 * begin with the file's line ending, and words followed by more of the note end with the separator
 * the file had there.
 */
export function runEdit(text: string, index: number, expected: string, typed: string): Span {
  const run = readNote(text).runs[index];
  if (!run || run.text !== expected) throw new FrontmatterEditError("moved", "그 사이 노트가 바뀌었습니다.");
  let words = typed;
  if (words !== "") {
    const nl = lineEnding(text);
    if (!startsLine(text, run.start)) words = nl + words;
    if (run.end < text.length) words = words.replace(/(?:\r?\n)*$/, "") + (/(?:\r?\n)*$/.exec(expected)![0] || nl + nl);
  }
  return { start: run.start, end: run.end, replacement: words };
}

/**
 * The span (an insertion point) for a new line in `## 결정` (a plain item) or `## 열린 질문` (an
 * unticked `- [ ]` item): after the section's last item, or a new section before the questions, or
 * at the end. The insertion always starts on its own line.
 */
export function entryEdit(text: string, section: "decision" | "question", entry: string): Span {
  const nl = lineEnding(text);
  const clean = entry.replace(/\s+/g, " ").trim();
  const item = section === "decision" ? `- ${clean}${nl}` : `- [ ] ${clean}${nl}`;
  const { lines, offsets } = lineOffsets(text);
  const bodyStart = frontmatterRange(text) ? bodyStartOf(text) : text.startsWith("﻿") ? 1 : 0;
  let first = 0;
  while (first < lines.length && offsets[first + 1]! <= bodyStart) first += 1;
  const found = sectionOf(lines, first, section === "decision" ? DECISIONS : QUESTIONS);
  const at = (offset: number, replacement: string): Span => ({ start: offset, end: offset, replacement: (startsLine(text, offset) ? "" : nl) + replacement });
  if (found) {
    let line = found.items.length ? found.items.at(-1)! + 1 : found.heading + 1;
    // Continuation lines of the last item stay with it.
    while (found.items.length && line < found.end && /^[ \t]+\S/.test(lines[line]!)) line += 1;
    return at(offsets[line]!, item);
  }
  const block = `## ${section === "decision" ? DECISIONS : QUESTIONS}${nl}${item}`;
  const questions = section === "decision" ? sectionOf(lines, first, QUESTIONS) : null;
  if (questions) return at(offsets[questions.heading]!, `${block}${nl}`);
  // At the end, a blank line after the note's own words.
  const words = lines.slice(first).some((line) => line.trim()) && lines.at(-1)!.trim() !== "";
  return at(text.length, `${words ? nl : ""}${block}`);
}

/** The span that ticks or unticks the open question on `line` (the one character inside `[ ]`). */
export function tickEdit(text: string, line: number, done: boolean): Span {
  const { lines, offsets } = lineOffsets(text);
  if (lines[line] === undefined || !/^- \[[ xX]\] /.test(lines[line]!)) throw new FrontmatterEditError("moved", "그 줄은 열린 질문이 아닙니다.");
  return { start: offsets[line]! + 3, end: offsets[line]! + 4, replacement: done ? "x" : " " };
}

/**
 * The headings outside `from`..`to` and the sections' own bytes, in order (`skip`: the section being
 * edited). A section's trailing blank lines are the separator after it, not its content.
 */
function structure(text: string, from: number, to: number, skip?: "decision" | "question") {
  const read = readNote(text);
  const headings: string[] = [];
  let fenced = false;
  let at = 0;
  for (const line of linesOf(text)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && (at < from || at >= to) && HEADING.test(line)) headings.push(line.replace(/\r?\n$/, ""));
    at += line.length;
  }
  return JSON.stringify({ headings, sections: read.sections.filter((section) => section.kind !== skip).map((section) => [section.kind, text.slice(section.start, section.end).replace(/(?:\r?\n[ \t]*)+$/, "")]) });
}

/** The front matter block as bytes, up to its closing marker ("" without one; null when it opens and does not close). */
function frontmatterBlock(text: string): string | null {
  const range = frontmatterRange(text);
  if (!range) return /^﻿?---[ \t]*\r?\n/.test(text) ? null : "";
  return text.slice(0, range.end + /^(---|\.\.\.)[ \t]*/.exec(text.slice(range.end))![0].length);
}

/** What a write's span is for: one key, the body (or one of its sections), the body as a whole, or the whole file. */
export type SpanScope = { kind: "key"; key: string; intended: string[] | null } | { kind: "body"; section?: "decision" | "question" } | { kind: "body-all" } | { kind: "whole" };

/**
 * The guard after every write, on bytes and parse; any failure refuses the write (the file is not
 * touched): (i) the result is exactly the declared span applied; (ii) a key edit stays inside the
 * front matter, which still closes, every other key reads as before and the key reads as intended —
 * any other edit leaves the front matter's bytes as they were; (iii) a body edit leaves every other
 * section's bytes and the headings outside its span as they were.
 */
export function verifySpan(before: string, after: string, span: Span, scope: SpanScope) {
  if (after !== applySpan(before, span)) throw new FrontmatterEditError("changed", "쓸 내용이 정한 범위를 벗어나 쓰지 않았습니다.");
  if (scope.kind === "whole") {
    const problem = frontmatterProblem(after);
    if (problem && /^﻿?---[ \t]*\r?\n/.test(after)) throw new FrontmatterEditError("invalid", `속성(YAML)이 읽히지 않아 쓰지 않았습니다: ${problem}`);
    return;
  }
  if (scope.kind === "key") {
    const range = frontmatterRange(before);
    if (range && (span.start < range.start || span.end > range.end)) throw new FrontmatterEditError("frontmatter", "속성이 아닌 곳은 여기서 고치지 않습니다.");
    if (!frontmatterRange(after)) throw new FrontmatterEditError("invalid", "고치면 속성 부분이 닫히지 않아 쓰지 않았습니다.");
    verifyKeyEdit(before, after, scope.key, scope.intended);
    return;
  }
  const block = frontmatterBlock(before);
  if (block === null || frontmatterBlock(after) !== block) throw new FrontmatterEditError("frontmatter", "고치면 속성 부분이 바뀌어 쓰지 않았습니다.");
  if (scope.kind === "body" && structure(before, span.start, span.end, scope.section) !== structure(after, span.start, span.start + span.replacement.length, scope.section)) {
    throw new FrontmatterEditError("structure", "그렇게 쓰면 결정·열린 질문 칸이나 다른 제목이 바뀌어 쓰지 않았습니다. 원문 전체에서 고쳐 주세요.");
  }
}

/** The text after the front matter (or all of it), with where it starts. */
function bodyStartOf(text: string) {
  const { yaml, bodyStart } = splitFrontmatter(text);
  return yaml === null && !frontmatterRange(text) ? (text.startsWith("﻿") ? 1 : 0) : bodyStart;
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*\r?\n?$/;
const ITEM = /^- (?:\[([ xX])\] )?(.*?)\r?\n?$/;

/** The line numbers where each `## 결정` / `## 열린 질문` section's heading and list items are. */
function sectionOf(lines: string[], from: number, title: string) {
  let heading = -1;
  let fenced = false;
  for (let index = from; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index]!)) fenced = !fenced;
    if (fenced) continue;
    const match = HEADING.exec(lines[index]!);
    if (match && match[1] === "##" && match[2]!.trim() === title) {
      heading = index;
      break;
    }
  }
  if (heading === -1) return null;
  const items: number[] = [];
  let end = heading + 1;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (HEADING.test(line)) break;
    if (ITEM.test(line)) items.push(index);
    else if (line.trim() && !/^[ \t]/.test(line)) break;
    end = index + 1;
  }
  return { heading, items, end };
}

export type ReadNote = {
  id: string | null;
  properties: [string, string[] | null][];
  stage: string | null;
  tags: string[];
  decisions: ProjectEntry[];
  questions: ProjectEntry[];
  body: string;
  /** The body without the decision and open-question sections: the note's own words. */
  free: string;
  /** The stretches of the note's own words, with their offsets in the whole text (at least one). */
  runs: { start: number; end: number; text: string }[];
  /** Each key's shape as written (what the page may edit in place). */
  shapes: Record<string, KeyShape>;
  /** The `## 결정` / `## 열린 질문` sections as byte ranges of the whole text, in file order. */
  sections: { kind: "decision" | "question"; start: number; end: number }[];
  problem: string | null;
};

/** What a project note says: its keys as written, stage, tags, decisions, open questions, body. */
export function readNote(text: string): ReadNote {
  const opened = /^﻿?---[ \t]*\r?\n/.test(text);
  const range = frontmatterRange(text);
  const strict = opened && range ? strictFrontmatter(text) : null;
  const problem = opened && !range ? "속성(YAML) 부분이 `---`로 닫히지 않았습니다." : strict && "error" in strict ? `속성(YAML)을 읽을 수 없습니다: ${strict.error}` : null;
  const { yaml } = splitFrontmatter(text);
  const entries = range ? parseFrontmatter(yaml) : [];
  const start = range ? bodyStartOf(text) : text.startsWith("\uFEFF") ? 1 : 0;
  const lines = linesOf(text);
  const offsets: number[] = [];
  for (let line = 0, at = 0; line <= lines.length; line += 1) {
    offsets.push(at);
    at += lines[line]?.length ?? 0;
  }
  // The line where the body starts (a BOM before it stays outside).
  let first = 0;
  while (first < lines.length && offsets[first + 1]! <= start) first += 1;
  const decisions = sectionOf(lines, first, DECISIONS);
  const questions = sectionOf(lines, first, QUESTIONS);
  const entriesOf = (section: ReturnType<typeof sectionOf>): ProjectEntry[] =>
    (section?.items ?? []).map((line) => {
      const match = ITEM.exec(lines[line]!)!;
      return { line, text: match[2]!.trim(), done: (match[1] ?? " ").toLowerCase() === "x" };
    });
  const cut = new Set<number>();
  for (const section of [decisions, questions]) for (let line = section?.heading ?? 0; section && line < section.end; line += 1) cut.add(line);
  const runs: ReadNote["runs"] = [];
  for (let line = first; line < lines.length; line += 1) {
    if (cut.has(line)) continue;
    const from = Math.max(offsets[line]!, start);
    const last = runs.at(-1);
    if (last && last.end === offsets[line]) last.end = offsets[line + 1]!;
    else runs.push({ start: from, end: offsets[line + 1]!, text: "" });
  }
  for (const run of runs) run.text = text.slice(run.start, run.end);
  if (!runs.length) runs.push({ start, end: start, text: "" });
  return {
    id: valuesOf(entries, ID_KEY)[0]?.trim() || null,
    properties: entries.filter(([key]) => key !== ID_KEY),
    stage: valuesOf(entries, STAGE_KEY)[0]?.trim() || null,
    tags: [...new Set([...valuesOf(entries, "tags"), ...valuesOf(entries, "tag")].flatMap((value) => value.split(/[,\s]+/)).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean))],
    decisions: entriesOf(decisions),
    questions: entriesOf(questions),
    body: text.slice(start),
    free: lines.filter((_, line) => line >= first && !cut.has(line)).join(""),
    runs,
    shapes: range ? keyShapes(text) : {},
    sections: ([["decision", decisions], ["question", questions]] as const).filter(([, section]) => section !== null).map(([kind, section]) => ({ kind, start: offsets[section!.heading]!, end: offsets[section!.end]! })).sort((a, b) => a.start - b.start),
    problem,
  };
}

/** Add a line to `## 결정` or `## 열린 질문` (the `entryEdit` span applied). */
export function appendEntry(text: string, section: "decision" | "question", entry: string): string {
  return applySpan(text, entryEdit(text, section, entry));
}

/** Tick or untick an open question on a line (the `tickEdit` span applied). */
export function setEntryDone(text: string, line: number, done: boolean): string {
  return applySpan(text, tickEdit(text, line, done));
}

/** Where the body starts (after the front matter's closing line; after a BOM when there is none). */
export function bodyStart(text: string) {
  return frontmatterRange(text) ? bodyStartOf(text) : text.startsWith("\uFEFF") ? 1 : 0;
}

/** The note with a new body: the front matter stays byte for byte. */
export function setBody(text: string, body: string): string {
  const range = frontmatterRange(text);
  if (!range) return body;
  return text.slice(0, bodyStartOf(text)) + body;
}

/** A file name for the note from the project's name (no path characters, not too long). */
export function noteFileName(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${clean || "프로젝트"}.md`;
}

/**
 * The first line of a note's own words, as a list shows it under the name: headings, rules, code
 * blocks, tables and comments are passed over, list and quote marks and Markdown links come off.
 * At most 140 characters; null when the note has no words of its own.
 */
export function notePreview(free: string): string | null {
  let fenced = false;
  for (const raw of free.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || !line || /^(#{1,6}\s|-{3,}$|\*{3,}$|```|~~~|<!--|\|)/.test(line)) continue;
    const plain = line
      .replace(/^>\s*(\[![^\]]*\][+-]?\s*)?/, "")
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
      .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_|`|==)(?=\S)([^*_`=]*?\S)\1/g, "$2")
      .replace(/\s+/g, " ")
      .trim();
    if (plain) return plain.length > 140 ? `${plain.slice(0, 139)}…` : plain;
  }
  return null;
}

/** A new note: only the machine key that ties it to the work (the rest is added as people write). */
export function newNote(workId: string, nl = "\n"): string {
  return `---${nl}${ID_KEY}: ${workId}${nl}---${nl}`;
}
