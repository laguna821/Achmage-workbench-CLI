import { STAGE_KEY, type ProjectEntry } from "@workbench/contracts";
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
 * Set a front matter key (null removes it). The key keeps its place and, for lists, the shape it
 * had (block or `[inline]`); a new key goes last. A note without front matter gets one.
 */
export function setFrontmatterKey(text: string, key: string, values: string[] | null, how: KeyStyle = {}): string {
  const nl = lineEnding(text);
  const range = frontmatterRange(text);
  const listy = how.list ?? (LIST_KEYS.has(key) || (values?.length ?? 0) > 1);
  if (!range) {
    if (values === null) return text;
    const bom = text.startsWith("﻿") ? "﻿" : "";
    const body = bom ? text.slice(1) : text;
    return `${bom}---${nl}${renderKey(key, values, listy ? "block" : "scalar", nl, how.raw)}---${nl}${body}`;
  }
  const lines = linesOf(text.slice(range.start, range.end));
  let at = -1;
  let length = 0;
  let style: "scalar" | "block" | "inline" = listy ? "block" : "scalar";
  for (let index = 0; index < lines.length; index += 1) {
    const match = KEY_LINE.exec(lines[index]!.replace(/\r?\n$/, ""));
    if (!match || /^[ \t]/.test(lines[index]!) || keyName(match) !== key) continue;
    at = index;
    length = 1;
    while (index + length < lines.length && /^[ \t]+\S/.test(lines[index + length]!)) length += 1;
    const inline = (match[4] ?? "").trim();
    if (listy) style = inline.startsWith("[") ? "inline" : "block";
    else if (length > 1) style = "block";
    break;
  }
  const rendered = values === null ? "" : renderKey(key, values, style, nl, how.raw);
  const yaml = at === -1 ? `${lines.join("")}${lines.length && !/\n$/.test(lines.at(-1)!) ? nl : ""}${rendered}` : [...lines.slice(0, at), rendered, ...lines.slice(at + length)].join("");
  return text.slice(0, range.start) + yaml + text.slice(range.end);
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
  problem: string | null;
};

/** What a project note says: its keys as written, stage, tags, decisions, open questions, body. */
export function readNote(text: string): ReadNote {
  const opened = /^﻿?---[ \t]*\r?\n/.test(text);
  const range = frontmatterRange(text);
  const problem = opened && !range ? "속성(YAML) 부분이 `---`로 닫히지 않았습니다." : null;
  const { yaml } = splitFrontmatter(text);
  const entries = range ? parseFrontmatter(yaml) : [];
  const start = range ? bodyStartOf(text) : 0;
  const lines = linesOf(text);
  // The line where the body starts.
  let first = 0;
  for (let consumed = 0; first < lines.length && consumed < start; first += 1) consumed += lines[first]!.length;
  const decisions = sectionOf(lines, first, DECISIONS);
  const questions = sectionOf(lines, first, QUESTIONS);
  const entriesOf = (section: ReturnType<typeof sectionOf>): ProjectEntry[] =>
    (section?.items ?? []).map((line) => {
      const match = ITEM.exec(lines[line]!)!;
      return { line, text: match[2]!.trim(), done: (match[1] ?? " ").toLowerCase() === "x" };
    });
  const cut = new Set<number>();
  for (const section of [decisions, questions]) for (let line = section?.heading ?? 0; section && line < section.end; line += 1) cut.add(line);
  return {
    id: valuesOf(entries, ID_KEY)[0]?.trim() || null,
    properties: entries.filter(([key]) => key !== ID_KEY),
    stage: valuesOf(entries, STAGE_KEY)[0]?.trim() || null,
    tags: [...new Set([...valuesOf(entries, "tags"), ...valuesOf(entries, "tag")].flatMap((value) => value.split(/[,\s]+/)).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean))],
    decisions: entriesOf(decisions),
    questions: entriesOf(questions),
    body: text.slice(start),
    free: lines.filter((_, line) => line >= first && !cut.has(line)).join(""),
    problem,
  };
}

/**
 * Add a line to `## 결정` (a plain item) or `## 열린 질문` (an unticked `- [ ]` item), after the
 * section's last item. A missing section is made: decisions before open questions, else at the end.
 */
export function appendEntry(text: string, section: "decision" | "question", entry: string): string {
  const nl = lineEnding(text);
  const clean = entry.replace(/\s+/g, " ").trim();
  const item = section === "decision" ? `- ${clean}${nl}` : `- [ ] ${clean}${nl}`;
  const lines = linesOf(text);
  if (lines.length && !/\n$/.test(lines.at(-1)!)) lines[lines.length - 1] += nl;
  let first = 0;
  const start = frontmatterRange(text) ? bodyStartOf(text) : 0;
  for (let consumed = 0; first < lines.length && consumed < start; first += 1) consumed += lines[first]!.length;
  const title = section === "decision" ? DECISIONS : QUESTIONS;
  const found = sectionOf(lines, first, title);
  if (found) {
    const after = found.items.length ? found.items.at(-1)! + 1 : found.heading + 1;
    // Continuation lines of the last item stay with it.
    let at = after;
    while (found.items.length && at < found.end && /^[ \t]+\S/.test(lines[at]!)) at += 1;
    lines.splice(at, 0, item);
    return lines.join("");
  }
  const block = [`## ${title}${nl}`, item];
  const questions = section === "decision" ? sectionOf(lines, first, QUESTIONS) : null;
  if (questions) {
    lines.splice(questions.heading, 0, ...block, nl);
    return lines.join("");
  }
  const tail = lines.length > first && lines.slice(first).some((line) => line.trim()) ? [nl] : [];
  return [...lines, ...(lines.length && lines.at(-1)!.trim() ? tail : []), ...block].join("");
}

/** Tick or untick an open question on a line (only a `- [ ]` / `- [x]` line changes). */
export function setEntryDone(text: string, line: number, done: boolean): string {
  const lines = linesOf(text);
  const current = lines[line];
  if (current === undefined || !/^- \[[ xX]\] /.test(current)) throw new Error("그 줄은 열린 질문이 아닙니다.");
  lines[line] = current.replace(/^- \[[ xX]\] /, done ? "- [x] " : "- [ ] ");
  return lines.join("");
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

/** A new note: only the machine key that ties it to the work (the rest is added as people write). */
export function newNote(workId: string, nl = "\n"): string {
  return `---${nl}${ID_KEY}: ${workId}${nl}---${nl}`;
}
