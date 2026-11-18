// Ported from HanMark 2.7.0 src/io/importOptions.ts @ 3db078d (MIT © 2026 laguna821, ./LICENSE-HANMARK). Workbench: kordoc's ParseOptions type named locally (no in-process kordoc).
import type { MessageKey } from "./i18n.ts";

/** kordoc's parse options this file names (kordoc 4.18.13 `ParseOptions`, the core runner's `read` options). */
type ParseOptions = {
  pages?: string; plain?: boolean; htmlTables?: boolean; keepTrailingEmptyCols?: boolean; keepEmptyParagraphs?: boolean;
  includeFieldPlaceholders?: boolean; password?: string; images?: boolean; tables?: boolean; removeHeaderFooter?: boolean;
  dedupeRunningHeaders?: boolean; onProgress?: (current: number, total: number) => void;
};

/**
 * Import presets and advanced options (2.7.0 W3).
 *
 * The default preset passes no options, so its Markdown is exactly Kordoc's default
 * output. Presets only switch on documented, offline Kordoc parse options.
 */
export type ImportPresetId = "default" | "text" | "form" | "exam";

export const IMPORT_PRESET_IDS: readonly ImportPresetId[] = ["default", "text", "form", "exam"];

export const IMPORT_PRESET_LABELS: Readonly<Record<ImportPresetId, { name: MessageKey; desc: MessageKey }>> = {
  default: { name: "import.preset.default.name", desc: "import.preset.default.desc" },
  text: { name: "import.preset.text.name", desc: "import.preset.text.desc" },
  form: { name: "import.preset.form.name", desc: "import.preset.form.desc" },
  exam: { name: "import.preset.exam.name", desc: "import.preset.exam.desc" }
};

export interface ImportAdvancedOptions {
  /** Page (PDF) or section (HWP/HWPX) range such as "1-3,7"; empty means all. */
  pages: string;
  /** Extract images into the Vault (default true). */
  images: boolean;
  /** Write every table as HTML instead of pipe tables. */
  htmlTables: boolean;
  /** PDF: remove running headers and footers. */
  removeHeaderFooter: boolean;
  /** HWP5: keep only the first copy of repeated running headings. */
  dedupeRunningHeaders: boolean;
}

export interface ImportOptions extends ImportAdvancedOptions {
  preset: ImportPresetId;
}

export const DEFAULT_IMPORT_OPTIONS: Readonly<ImportOptions> = Object.freeze({
  preset: "default",
  pages: "",
  images: true,
  htmlTables: false,
  removeHeaderFooter: false,
  dedupeRunningHeaders: false
});

/**
 * The only Kordoc parse options HanMark ever passes. OCR, formula OCR (model
 * downloads), file paths (external COM conversion), and inline images are excluded
 * by type so no call site can reach them (offline contract, R-018).
 */
export type HanmarkParseOptions = Pick<
  ParseOptions,
  | "pages"
  | "plain"
  | "htmlTables"
  | "keepTrailingEmptyCols"
  | "keepEmptyParagraphs"
  | "includeFieldPlaceholders"
  | "password"
  | "images"
  | "tables"
  | "removeHeaderFooter"
  | "dedupeRunningHeaders"
  | "onProgress"
>;

export const ALLOWED_PARSE_OPTION_KEYS: ReadonlySet<string> = new Set<keyof HanmarkParseOptions>([
  "pages",
  "plain",
  "htmlTables",
  "keepTrailingEmptyCols",
  "keepEmptyParagraphs",
  "includeFieldPlaceholders",
  "password",
  "images",
  "tables",
  "removeHeaderFooter",
  "dedupeRunningHeaders",
  "onProgress"
]);

const MAX_PAGE_NUMBER = 100_000;

export function normalizeImportPreset(value: unknown): ImportPresetId {
  return value === "text" || value === "form" || value === "exam" ? value : "default";
}

/**
 * Canonical page range ("1-3,5,7-9"), "" for the whole document, or null when the
 * input is not a valid range. Whitespace is ignored; ranges must ascend.
 */
export function normalizePageRange(value: string): string | null {
  const compact = value.replace(/\s+/gu, "");
  if (!compact) return "";
  const parts: string[] = [];
  for (const part of compact.split(",")) {
    const match = /^(\d{1,6})(?:-(\d{1,6}))?$/u.exec(part);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start || end > MAX_PAGE_NUMBER) return null;
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join(",");
}

export interface ParseExtras {
  /** Held in memory for one attempt; never stored or logged. */
  password?: string;
  onProgress?: (current: number, total: number) => void;
}

/** Translate user choices into the Kordoc options whitelist. */
export function toParseOptions(options: ImportOptions, extras: ParseExtras = {}): HanmarkParseOptions {
  const parse: HanmarkParseOptions = {};
  switch (options.preset) {
    case "text":
      // Text only: placeholders, link URLs and emphasis marks are dropped, so the
      // image bytes would have nowhere to go.
      parse.plain = true;
      parse.images = false;
      break;
    case "form":
      parse.keepTrailingEmptyCols = true;
      parse.includeFieldPlaceholders = true;
      parse.keepEmptyParagraphs = true;
      break;
    case "exam":
      parse.tables = false;
      break;
    default:
      break;
  }
  const pages = normalizePageRange(options.pages);
  if (pages) parse.pages = pages;
  if (!options.images) parse.images = false;
  if (options.htmlTables) parse.htmlTables = true;
  if (options.removeHeaderFooter) parse.removeHeaderFooter = true;
  if (options.dedupeRunningHeaders) parse.dedupeRunningHeaders = true;
  if (extras.password) parse.password = extras.password;
  if (extras.onProgress) parse.onProgress = extras.onProgress;
  return parse;
}

/** Folder policy for new notes created by an import. */
export type ImportDestinationMode = "note-folder" | "folder" | "ask";

export interface ImportDestination {
  mode: ImportDestinationMode;
  /** Vault-relative folder used by "folder" mode; "" means the Vault root. */
  folder: string;
}

export const DEFAULT_IMPORT_DESTINATION: Readonly<ImportDestination> = Object.freeze({
  mode: "note-folder",
  folder: ""
});
