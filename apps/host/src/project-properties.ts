import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROPERTY_TEMPLATE, PROPERTY_TYPES, STAGE_KEY, type PropertyField, type PropertyRow, type PropertyType } from "@workbench/contracts";
import { parseFrontmatter, splitFrontmatter } from "./frontmatter.ts";
import { HttpError } from "./errors.ts";
import { ID_KEY } from "./project-note.ts";

// A project's properties as Obsidian has them: each key has a kind (text, list, number, checkbox,
// date, date and time, tags, links, the stage), shown with its own editor and written in the YAML
// the way Obsidian writes it. Kinds come from the user's properties template, the user's choice in
// the app, the vault's .obsidian/types.json, else from the value itself.

const KINDS = new Set<PropertyType>(PROPERTY_TYPES.map((entry) => entry.type));

/** Obsidian's names in `.obsidian/types.json` → ours. */
const OBSIDIAN: Record<string, PropertyType> = { text: "text", multitext: "list", number: "number", checkbox: "checkbox", date: "date", datetime: "datetime", tags: "tags", aliases: "list" };

/** The kinds the vault's Obsidian gives its property names (read only; none without a vault). */
export function vaultPropertyTypes(vaultRoot: string | null): Map<string, PropertyType> {
  const out = new Map<string, PropertyType>();
  if (!vaultRoot) return out;
  try {
    const parsed = JSON.parse(readFileSync(join(vaultRoot, ".obsidian", "types.json"), "utf8")) as { types?: Record<string, string> };
    for (const [key, type] of Object.entries(parsed.types ?? {})) if (OBSIDIAN[type]) out.set(key, OBSIDIAN[type]!);
  } catch {
    // No types file, or one we cannot read: kinds come from the values.
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const LINK = /^\[\[[^\]]+\]\]$/;

/** A kind read from the key and its values, when nothing else says. */
export function inferType(key: string, values: string[] | null): PropertyType {
  const name = key.trim().replace(/:$/, "").toLowerCase();
  if (key === STAGE_KEY) return "stage";
  if (name === "tags" || name === "tag") return "tags";
  if (name === "aliases") return "list";
  const list = values ?? [];
  if (list.length && list.every((value) => LINK.test(value.trim()))) return "links";
  if (list.length > 1) return "list";
  const value = list[0]?.trim() ?? "";
  if (/^(true|false)$/i.test(value)) return "checkbox";
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  if (DATETIME.test(value)) return "datetime";
  if (DATE.test(value)) return "date";
  return "text";
}

const pad = (value: number) => String(value).padStart(2, "0");
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * A date typed by a person, as YYYY-MM-DD: 2026-10-29, 2026.10.29, 2026/10/29, 10-29-2026,
 * 10/29 (this year), "오늘", "내일", "어제". Null when it is not one.
 */
export function parseDate(text: string, now = new Date()): string | null {
  const value = text.trim();
  const day = (offset: number) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  if (value === "오늘" || value.toLowerCase() === "today") return day(0);
  if (value === "내일" || value.toLowerCase() === "tomorrow") return day(1);
  if (value === "어제" || value.toLowerCase() === "yesterday") return day(-1);
  const valid = (year: number, month: number, date: number) => {
    const made = new Date(year, month - 1, date);
    return made.getFullYear() === year && made.getMonth() === month - 1 && made.getDate() === date ? ymd(made) : null;
  };
  let match = /^(\d{4})[-./ ](\d{1,2})[-./ ](\d{1,2})\.?$/.exec(value);
  if (match) return valid(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/.exec(value);
  if (match) return valid(Number(match[3]), Number(match[1]), Number(match[2]));
  match = /^(\d{1,2})[-./](\d{1,2})$/.exec(value);
  if (match) return valid(now.getFullYear(), Number(match[1]), Number(match[2]));
  match = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일$/.exec(value);
  if (match) return valid(Number(match[1]), Number(match[2]), Number(match[3]));
  return null;
}

/** A link as the note keeps it: `[[name]]` (a link already written stays as it is). */
export const asLinkValue = (value: string) => (/^\[\[.*\]\]$/.test(value.trim()) ? value.trim() : `[[${value.trim().replace(/^\[\[|\]\]$/g, "")}]]`);

/**
 * Values as a kind writes them, or an error in the person's words: dates as YYYY-MM-DD, times as
 * YYYY-MM-DDTHH:mm, numbers and true/false bare, tags without #, links as [[…]], lists trimmed.
 */
export function normalizeValues(type: PropertyType, values: string[], now = new Date()): string[] {
  const list = values.map((value) => value.trim()).filter(Boolean);
  switch (type) {
    case "date":
      return list.slice(0, 1).map((value) => {
        const date = parseDate(value, now);
        if (!date) throw new HttpError(400, "bad_date", `날짜로 읽지 못했습니다: ${value} (예: 2026-10-29, 10-29, 오늘)`);
        return date;
      });
    case "datetime":
      return list.slice(0, 1).map((value) => {
        if (value === "지금" || value.toLowerCase() === "now") return `${ymd(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const match = /^(.+?)[T ](\d{1,2}):(\d{2})$/.exec(value);
        const date = parseDate(match ? match[1]! : value, now);
        if (!date) throw new HttpError(400, "bad_datetime", `날짜와 시간으로 읽지 못했습니다: ${value} (예: 2026-10-29 14:30, 지금)`);
        return match ? `${date}T${pad(Number(match[2]))}:${match[3]}` : `${date}T00:00`;
      });
    case "number":
      return list.slice(0, 1).map((value) => {
        const number = value.replace(/,/g, "");
        if (!/^-?\d+(\.\d+)?$/.test(number)) throw new HttpError(400, "bad_number", `숫자가 아닙니다: ${value}`);
        return number;
      });
    case "checkbox":
      return list.slice(0, 1).map((value) => (/^(true|1|예|네|y|yes|on|✓)$/i.test(value) ? "true" : "false"));
    case "tags":
      return [...new Set(list.flatMap((value) => value.split(/[\s,]+/)).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean))];
    case "links":
      return [...new Set(list.map(asLinkValue))];
    case "text":
    case "stage":
      return list.slice(0, 1);
    default:
      return [...new Set(list)];
  }
}

/** How a kind's value is written in the YAML (see setFrontmatterKey). */
export const keyStyle = (type: PropertyType) => ({ list: type === "list" || type === "tags" || type === "links", raw: type === "number" || type === "checkbox" });

/** A template as saved: known kinds, names that can be keys, each once; the stage always "stage". */
export function cleanTemplate(value: unknown): PropertyField[] {
  if (!Array.isArray(value)) throw new HttpError(400, "bad_template", "템플릿은 속성 목록입니다.");
  const out: PropertyField[] = [];
  for (const raw of value.slice(0, 40)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const key = String(entry.key ?? "").trim().slice(0, 80);
    if (!key || key === ID_KEY || out.some((field) => field.key === key)) continue;
    let type = KINDS.has(entry.type as PropertyType) ? (entry.type as PropertyType) : "text";
    if (key === STAGE_KEY) type = "stage";
    else if (type === "stage") type = "text";
    const hint = typeof entry.hint === "string" && entry.hint.trim() ? entry.hint.trim().slice(0, 120) : undefined;
    out.push({ key, type, ...(hint ? { hint } : {}) });
  }
  return out;
}

/**
 * A template from a Markdown file's front matter (the user's own note template): its keys in order,
 * each with the vault's kind for that name, else the kind its value shows. The machine key and
 * `title` are left out (a project's title is its name).
 */
export function templateFromMarkdown(text: string, known: Map<string, PropertyType>): PropertyField[] {
  const { yaml } = splitFrontmatter(text);
  if (yaml === null) throw new HttpError(400, "no_front_matter", "이 파일에는 맨 위의 속성(YAML, --- 사이)이 없습니다.");
  const fields: PropertyField[] = [];
  for (const [key, values] of parseFrontmatter(yaml)) {
    if (key === ID_KEY || key.trim().toLowerCase() === "title" || fields.some((field) => field.key === key)) continue;
    fields.push({ key, type: known.get(key) ?? inferType(key, values) });
  }
  if (!fields.length) throw new HttpError(400, "empty_template", "속성(YAML)에 키가 없습니다.");
  return cleanTemplate(fields);
}

/** The template's fields first (in its order), then the note's other keys (in the note's order). */
export function propertyRows(template: PropertyField[], properties: [string, string[] | null][], typeOf: (key: string, values: string[] | null) => PropertyType): PropertyRow[] {
  const values = new Map(properties.map(([key, value]) => [key, value] as const));
  const rows: PropertyRow[] = template.map((field) => ({
    key: field.key,
    type: field.type,
    values: values.has(field.key) ? (values.get(field.key) ?? null) : [],
    present: values.has(field.key),
    fromTemplate: true,
    ...(field.hint ? { hint: field.hint } : {}),
  }));
  for (const [key, value] of properties) {
    if (key === ID_KEY || template.some((field) => field.key === key)) continue;
    rows.push({ key, type: typeOf(key, value), values: value, present: true, fromTemplate: false });
  }
  return rows;
}

export { DEFAULT_PROPERTY_TEMPLATE };
