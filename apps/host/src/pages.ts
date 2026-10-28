import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { PageTemplate } from "@workbench/contracts";
import { KEY_LINE, unquote } from "./frontmatter.ts";

// Pages phase 2: page templates and the page text they give. A template is copied as it is:
// only `title` and `date created` are filled, choice fields (a key followed by a list of options,
// such as `"DIKM_단계:"`) take what the user picked (nothing by default), and every other byte —
// key spelling, quotes, empty values, order, the body, Templater's `<% %>` — stays as written.
// Templater commands are never run.

/** DIKM stages, offered for `DIKM_단계:` when a template lists none. */
export const DIKM_STAGES = ["🟢 D", "🔵 I", "🟣 K", "🟠 M", "⬜ 보류"];

const ITEM = /^([ \t]*)-([ \t]+)(.*?)[ \t]*$/;

type Line = { text: string; eol: string };

function lines(text: string): Line[] {
  const out: Line[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[0] === "" && match.index === text.length) break;
    out.push({ text: match[1]!, eol: match[2]! });
  }
  return out;
}

/** The front matter lines of a template (between the `---` lines), or null. */
function frontmatterRange(all: Line[]): { start: number; end: number } | null {
  if (!all.length || !/^---[ \t]*$/.test(all[0]!.text.replace(/^﻿/, ""))) return null;
  for (let index = 1; index < all.length; index += 1) if (/^(---|\.\.\.)[ \t]*$/.test(all[index]!.text)) return { start: 1, end: index };
  return null;
}

const keyOf = (text: string) => {
  const match = KEY_LINE.exec(text);
  if (!match) return null;
  return match[1] !== undefined ? unquote(`"${match[1]}"`) : match[2] !== undefined ? match[2] : match[3]!.trim();
};

const isDikm = (key: string) => /^DIKM_단계:?$/.test(key.trim());

/** Where the colon between a key and its value is (after a quoted key's closing quote). */
function keyColon(text: string) {
  if (text.startsWith('"')) {
    for (let index = 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === '"') return text.indexOf(":", index);
    }
  }
  if (text.startsWith("'")) return text.indexOf(":", text.indexOf("'", 1));
  return text.indexOf(":");
}

/** Choice fields of a template: keys followed by a list of options (and `DIKM_단계:` always). */
export function templateChoices(text: string): { key: string; options: string[] }[] {
  const all = lines(text);
  const range = frontmatterRange(all);
  if (!range) return [];
  const choices: { key: string; options: string[] }[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const line = all[index]!.text;
    if (/^[ \t]/.test(line)) continue;
    const key = keyOf(line);
    if (!key) continue;
    const options: string[] = [];
    for (let next = index + 1; next < range.end; next += 1) {
      const item = ITEM.exec(all[next]!.text);
      if (!item) break;
      if (item[3]) options.push(unquote(item[3]));
    }
    if (options.length >= 2) choices.push({ key, options });
    else if (isDikm(key)) choices.push({ key, options: options.length ? options : DIKM_STAGES });
  }
  return choices;
}

/** A YAML scalar for a filled value: plain when that is safe, double-quoted otherwise. */
export function yamlValue(value: string) {
  const plain = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^#]*$/.test(value) && !/:\s|\s$|^\s/.test(value) && !/^(true|false|null|~|yes|no|on|off|-?\d[\d._]*)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

/** The local time with its offset, as the vault writes `date created` (2026-04-27T20:28:20+09:00). */
export function localStamp(at = Date.now()) {
  const date = new Date(at);
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/**
 * The page text from a template: `title` and `date created` filled, choice fields set to the picked
 * values (or left empty), everything else byte for byte. Templater's `<% %>` stays as text.
 */
export function fillTemplate(text: string, fill: { title: string; date: string; choices?: Record<string, string[]> }): string {
  const all = lines(text);
  const range = frontmatterRange(all);
  if (!range) return text;
  const out: Line[] = all.slice(0, range.start);
  const choices = fill.choices ?? {};
  for (let index = range.start; index < range.end; index += 1) {
    const line = all[index]!;
    const key = /^[ \t]/.test(line.text) ? null : keyOf(line.text);
    if (key === "title" || key === "date created") {
      const colon = keyColon(line.text);
      out.push({ text: `${line.text.slice(0, colon + 1)} ${key === "title" ? yamlValue(fill.title) : fill.date}`, eol: line.eol });
      continue;
    }
    const chosen = key !== null && Object.hasOwn(choices, key) ? choices[key]! : null;
    if (chosen === null) {
      out.push(line);
      continue;
    }
    // A choice field: the key line as written, then the picked values in the template's list style.
    let next = index + 1;
    let style: { indent: string; gap: string } | null = null;
    while (next < range.end) {
      const item = ITEM.exec(all[next]!.text);
      if (!item) break;
      style ??= { indent: item[1]!, gap: item[2]! };
      next += 1;
    }
    const inline = KEY_LINE.exec(line.text)?.[4];
    const keyText = inline && chosen.length ? line.text.slice(0, line.text.lastIndexOf(inline)).trimEnd() : line.text;
    out.push({ text: keyText, eol: line.eol || "\n" });
    const eol = line.eol || "\n";
    for (const value of chosen) out.push({ text: `${style?.indent ?? "  "}-${style?.gap ?? " "}${value}`, eol });
    index = next - 1;
  }
  out.push(...all.slice(range.end));
  return out.map((line) => line.text + line.eol).join("");
}

// ── where templates come from ──────────────────────────────────────────────────────────────

export type TemplateSource = { source: PageTemplate["source"]; dir: string };

/** Markdown templates of one folder (not its subfolders), newest name order. */
export function readTemplates(source: TemplateSource): PageTemplate[] {
  if (!existsSync(source.dir)) return [];
  let names: string[];
  try {
    names = readdirSync(source.dir).filter((name) => /\.md$/i.test(name) && !name.startsWith("."));
  } catch {
    return [];
  }
  return names
    .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
    .flatMap((name) => {
      const path = join(source.dir, name);
      try {
        if (!statSync(path).isFile() || statSync(path).size > 512 * 1024) return [];
        const text = readFileSync(path, "utf8");
        return [{ id: `${source.source}:${name}`, source: source.source, name: basename(name, ".md"), choices: templateChoices(text), templater: /<%[\s\S]*?%>/.test(text) }];
      } catch {
        return [];
      }
    });
}

/** The file behind a template id, only inside its own folder. */
export function templateFile(id: string, sources: TemplateSource[]) {
  const [source, ...rest] = id.split(":");
  const name = rest.join(":");
  const from = sources.find((entry) => entry.source === source);
  if (!from || !name || name.includes("/") || name.includes("\\") || name.startsWith(".") || !/\.md$/i.test(name)) return null;
  const path = join(from.dir, name);
  return existsSync(path) ? path : null;
}
