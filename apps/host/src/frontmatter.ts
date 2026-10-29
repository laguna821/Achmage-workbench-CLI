// YAML front matter of Obsidian notes, read the way the user writes it: top-level keys only, keys
// kept exactly as spelled (quoted keys such as `"DIKM_단계:"` keep their trailing colon), values as
// lists of strings. Small on purpose: notes are only read here, never rewritten.

export type FrontmatterValue = string[] | null;

/** The front matter block (without the `---` lines) and where the body starts, or null when there is none. */
export function splitFrontmatter(text: string): { yaml: string | null; body: string; bodyStart: number } {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const offset = text.length - source.length;
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) return { yaml: null, body: source, bodyStart: offset };
  const close = /^(---|\.\.\.)[ \t]*$/m;
  const rest = source.slice(open[0].length);
  const match = close.exec(rest);
  if (!match) return { yaml: null, body: source, bodyStart: offset };
  const yaml = rest.slice(0, match.index).replace(/\r?\n$/, "");
  let bodyStart = open[0].length + match.index + match[0].length;
  if (source[bodyStart] === "\r") bodyStart += 1;
  if (source[bodyStart] === "\n") bodyStart += 1;
  return { yaml, body: source.slice(bodyStart), bodyStart: bodyStart + offset };
}

/** A top-level key line: `key: value`, `"quoted key:": value` or `'key': value`. */
export const KEY_LINE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"-][^:]*?))[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const ITEM_LINE = /^[ \t]+-(?:[ \t]+(.*?))?[ \t]*$/;

export function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** `[a, "b, c", d]` → three values. */
function inlineList(value: string): string[] {
  const inner = value.trim().slice(1, -1);
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const character of inner) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === ",") {
      out.push(current);
      current = "";
    } else current += character;
  }
  if (current.trim()) out.push(current);
  return out.map(unquote).filter((entry) => entry !== "");
}

function scalar(value: string | undefined): FrontmatterValue {
  if (value === undefined) return null;
  const text = value.replace(/[ \t]+#.*$/, "").trim();
  if (!text || text === "~" || text === "null") return null;
  if (text.startsWith("[") && text.endsWith("]")) return inlineList(text);
  if (text === "|" || text === ">" || text === "|-" || text === ">-") return [];
  return [unquote(text)];
}

/** Top-level keys in their order, with their values (a scalar is a list of one). */
export function parseFrontmatter(yaml: string | null): [string, FrontmatterValue][] {
  if (!yaml) return [];
  const entries: [string, FrontmatterValue][] = [];
  let current: [string, FrontmatterValue] | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = ITEM_LINE.exec(line);
    if (item && current) {
      const value = scalar(item[1]);
      current[1] = [...(current[1] ?? []), ...(value ?? [])];
      continue;
    }
    if (/^[ \t]/.test(line)) {
      // A continuation (block scalar or wrapped value): part of the current value.
      if (current) current[1] = [...(current[1] ?? []).slice(0, -1), `${(current[1] ?? []).at(-1) ?? ""}${(current[1] ?? []).length ? " " : ""}${line.trim()}`];
      continue;
    }
    const key = KEY_LINE.exec(line);
    if (!key) continue;
    const name = key[1] !== undefined ? unquote(`"${key[1]}"`) : key[2] !== undefined ? key[2].replace(/''/g, "'") : key[3]!.trim();
    current = [name, scalar(key[4])];
    entries.push(current);
  }
  return entries;
}

/** The values of a key, compared without case; tags also without a leading `#`. */
export function valuesOf(entries: [string, FrontmatterValue][], key: string): string[] {
  const wanted = key.toLowerCase();
  return entries.find(([name]) => name.toLowerCase() === wanted)?.[1] ?? [];
}

/** Tags of a note: front matter `tags` (and `tag`) and `#tags` written in the body (not in code). */
export function noteTags(entries: [string, FrontmatterValue][], body: string): string[] {
  const tags = new Set<string>();
  for (const value of [...valuesOf(entries, "tags"), ...valuesOf(entries, "tag")]) {
    for (const part of value.split(/[,\s]+/)) {
      const tag = part.replace(/^#/, "").trim();
      if (tag) tags.add(tag);
    }
  }
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    for (const match of line.replace(/`[^`]*`/g, " ").matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) tags.add(match[1]!);
  }
  return [...tags];
}

/** A date written in a note (`2026-04-27T20:28:20+09:00`, `2026-08-30`, `'2026-09-18'`), or null. */
export function noteDate(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  const at = Date.parse(text.replace(" ", "T"));
  return Number.isFinite(at) ? at : null;
}

/** The first lines of a note as plain text: no headings, code, embeds, link syntax or emphasis marks. */
export function excerptOf(body: string, limit = 240): string {
  const out: string[] = [];
  let fence = false;
  let length = 0;
  for (const raw of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    let line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || /^<!--/.test(line) || /^\|/.test(line)) continue;
    line = line
      .replace(/!\[\[[^\]]*\]\]/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/^>\s*(\[![^\]]*\][+-]?\s*)?/, "")
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
      .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
      .replace(/\[\[([^\]]*)\]\]/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|~~|==)/g, "")
      .replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!line) continue;
    out.push(line);
    length += line.length;
    if (length >= limit) break;
  }
  const text = out.join(" ");
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** The first image a note shows: `![[name.png]]` or `![](path.png)` (local files only). */
export function firstImage(body: string): { kind: "embed" | "link" | "url"; target: string } | null {
  const pattern = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const match of body.matchAll(pattern)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(target.split(/[?#]/)[0]!)) continue;
    // Web pictures (R2, S3 …) are shown from where they are; other schemes are not pictures here.
    if (/^https?:\/\//i.test(target)) return { kind: "url", target };
    if (/^[a-z]+:/i.test(target)) continue;
    return { kind: match[1] ? "embed" : "link", target };
  }
  return null;
}
