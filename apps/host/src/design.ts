import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DESIGN_EXTENSION } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

// Design documents: a doory document (schema v1) saved as `<name>.design.json` in the work folder.
// The editor is the vendored doory editor (apps/design); engines change the JSON file itself. Images
// live next to it in `<name>.assets/`, named by content hash, so every revision of the JSON keeps
// pointing at the same bytes.

type Json = Record<string, unknown>;

const ASSET_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/webm": ".weba",
};
const ASSET_EXTENSIONS = new Set(Object.values(ASSET_TYPES).concat([".jpeg"]));

export const DESIGN_PRESETS = {
  square: { width: 1080, height: 1080, label: "정사각 1080" },
  portrait: { width: 1080, height: 1350, label: "카드뉴스 1080×1350" },
  story: { width: 1080, height: 1920, label: "세로 1080×1920" },
  wide: { width: 1920, height: 1080, label: "가로 1920×1080" },
  a4: { width: 794, height: 1123, label: "A4" },
} as const;
export type DesignPreset = keyof typeof DESIGN_PRESETS;

export function designStem(name: string) {
  return name.toLowerCase().endsWith(DESIGN_EXTENSION) ? name.slice(0, -DESIGN_EXTENSION.length) : basename(name, extname(name));
}

/** A new design with one blank white page. */
export function blankDesign(preset: DesignPreset = "square") {
  const { width, height } = DESIGN_PRESETS[preset] ?? DESIGN_PRESETS.square;
  const document = { schemaVersion: 1, width, height, unit: "px", pages: [{ id: randomUUID(), background: { type: "solid", color: "#ffffff" }, objects: [] }] };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Why a design file cannot be opened as it is, or null when it can. Checks the shape the editor relies on. */
export function designProblem(text: string): string | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return `JSON 형식이 아닙니다 (${error instanceof Error ? error.message : String(error)}).`;
  }
  if (!isObject(document)) return "디자인 문서가 객체가 아닙니다.";
  if (document.schemaVersion !== 1) return `schemaVersion이 1이 아닙니다 (${JSON.stringify(document.schemaVersion)}).`;
  if (!(Number(document.width) > 0) || !(Number(document.height) > 0)) return "width·height가 양수가 아닙니다.";
  if (!Array.isArray(document.pages) || document.pages.length === 0) return "pages가 비어 있습니다.";
  if (document.pages.length > 100) return "페이지는 100개까지입니다.";
  const ids = new Set<string>();
  for (const [index, page] of document.pages.entries()) {
    if (!isObject(page) || typeof page.id !== "string" || !page.id) return `${index + 1}쪽에 id가 없습니다.`;
    if (!isObject(page.background) || typeof page.background.type !== "string") return `${index + 1}쪽 background가 올바르지 않습니다.`;
    if (!Array.isArray(page.objects)) return `${index + 1}쪽 objects가 배열이 아닙니다.`;
    const stack: unknown[] = [...page.objects];
    while (stack.length) {
      const object = stack.pop();
      if (!isObject(object) || typeof object.type !== "string") return `${index + 1}쪽에 type이 없는 개체가 있습니다.`;
      if (typeof object.id === "string") {
        if (ids.has(object.id)) return `개체 id가 겹칩니다: ${object.id}`;
        ids.add(object.id);
      } else if (object.id !== undefined) return `${index + 1}쪽 개체 id가 문자열이 아닙니다.`;
      if (Array.isArray(object.objects)) stack.push(...object.objects);
    }
  }
  return null;
}

const round = (value: unknown) => (typeof value === "number" ? Math.round(value) : "?");

/** One line per object: what an engine needs to find things in a large JSON file. */
export function designOutline(text: string, limit = 120): string[] {
  let document: Json;
  try {
    document = JSON.parse(text) as Json;
  } catch {
    return [];
  }
  const pages = Array.isArray(document.pages) ? (document.pages as Json[]) : [];
  const lines: string[] = [`크기 ${round(document.width)}×${round(document.height)}px, ${pages.length}쪽`];
  let count = 0;
  pages.forEach((page, index) => {
    const size = page.width ? ` ${round(page.width)}×${round(page.height)}` : "";
    lines.push(`${index + 1}쪽 id=${String(page.id)}${page.name ? ` 「${String(page.name)}」` : ""}${size}`);
    const walk = (objects: Json[], depth: number) => {
      for (const object of objects) {
        if (++count > limit) return;
        const words = typeof object.text === "string" ? ` "${object.text.replace(/\s+/g, " ").slice(0, 40)}"` : "";
        const font = object.fontFamily ? ` ${String(object.fontFamily)} ${round(object.fontSize)}` : "";
        const fill = typeof object.fill === "string" ? ` fill=${object.fill}` : "";
        lines.push(`${"  ".repeat(depth)}  - ${String(object.type)} id=${String(object.id ?? "?")} @${round(object.left)},${round(object.top)}${words}${font}${fill}`);
        if (Array.isArray(object.objects)) walk(object.objects as Json[], depth + 1);
      }
    };
    walk(Array.isArray(page.objects) ? (page.objects as Json[]) : [], 0);
  });
  if (count > limit) lines.push(`  … 개체 ${count - limit}개 더`);
  return lines;
}

/** Store an uploaded image or sound next to the design; returns the src the document uses. */
export function saveDesignAsset(designPath: string, data: Buffer, contentType: string, name: string) {
  const fromName = extname(name).toLowerCase();
  const extension = ASSET_TYPES[contentType.split(";")[0].trim().toLowerCase()] ?? (ASSET_EXTENSIONS.has(fromName) ? fromName : null);
  if (!extension) throw new HttpError(415, "asset_type", "이미지(PNG·JPG·WebP·GIF·SVG·AVIF)나 소리 파일만 넣을 수 있습니다.");
  if (data.length === 0) throw new HttpError(400, "asset_empty", "빈 파일입니다.");
  const folder = `${designStem(basename(designPath))}.assets`;
  const file = `${createHash("sha256").update(data).digest("hex").slice(0, 16)}${extension}`;
  const target = join(dirname(designPath), folder, file);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return `${folder}/${file}`;
}

/** The file a document src points at: relative to the design's folder and never outside it. */
export function designAssetPath(designPath: string, src: string) {
  if (!src || isAbsolute(src) || /^[a-z][a-z0-9+.-]*:/i.test(src)) throw new HttpError(400, "asset_src", "상대 경로 이미지가 아닙니다.");
  const folder = dirname(designPath);
  const file = resolve(folder, src);
  const inside = relative(folder, file);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes(".workbench")) {
    throw new HttpError(403, "outside", "디자인 폴더 밖의 파일은 열 수 없습니다.");
  }
  if (!existsSync(file)) throw new HttpError(404, "asset_missing", `이미지 파일이 없습니다: ${src}`);
  return file;
}

export type FontEntry = { family: string; category: "sans-serif" | "serif" | "monospace" | "display" | "handwriting"; korean: boolean };

const WINDOWS_FONTS: FontEntry[] = [
  { family: "Malgun Gothic", category: "sans-serif", korean: true },
  { family: "Batang", category: "serif", korean: true },
  { family: "Gulim", category: "sans-serif", korean: true },
  { family: "Dotum", category: "sans-serif", korean: true },
  { family: "Segoe UI", category: "sans-serif", korean: false },
  { family: "Arial", category: "sans-serif", korean: false },
  { family: "Georgia", category: "serif", korean: false },
  { family: "Times New Roman", category: "serif", korean: false },
  { family: "Consolas", category: "monospace", korean: false },
];

let fontCache: FontEntry[] | null = null;

/** Families installed on this computer (fontconfig on Linux), Korean-capable ones first. */
export function systemFonts(): FontEntry[] {
  if (fontCache) return fontCache;
  if (process.platform === "win32") return (fontCache = WINDOWS_FONTS);
  const list = (pattern: string) => {
    try {
      return execFileSync("fc-list", ["--format", "%{family[0]}\\t%{spacing}\\n", pattern], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    } catch {
      return "";
    }
  };
  const korean = new Set(list(":lang=ko").split("\n").map((line) => line.split("\t")[0]).filter(Boolean));
  const seen = new Map<string, FontEntry>();
  for (const line of list(":").split("\n")) {
    const [family, spacing] = line.split("\t");
    if (!family || seen.has(family) || family.startsWith(".")) continue;
    const lower = family.toLowerCase();
    const category: FontEntry["category"] =
      spacing === "100" || /mono|code|consol/.test(lower) ? "monospace" : /serif|myeongjo|batang|명조|바탕/.test(lower) && !/sans/.test(lower) ? "serif" : "sans-serif";
    seen.set(family, { family, category, korean: korean.has(family) });
  }
  fontCache = [...seen.values()].sort((a, b) => Number(b.korean) - Number(a.korean) || a.family.localeCompare(b.family, "ko"));
  return fontCache;
}

/** Engine instructions for a design document (on top of the general pinned-document lines). */
export function designGuide(workingText: string | null, artifactPath: string) {
  const folder = dirname(artifactPath);
  const lines = [
    "  · 디자인 파일 규칙 (doory 문서 schemaVersion 1, JSON):",
    "    - 구조: { schemaVersion: 1, width, height, unit: \"px\", pages: [{ id, name?, width?, height?, background, objects: [...] , notes? }] }",
    "    - background: {type:\"solid\",color} | {type:\"gradient\",kind:\"linear\"|\"radial\",angle?,stops:[{offset,color}]} | {type:\"image\",src,fit:\"cover\"|\"contain\"|\"tile\"}",
    "    - 개체는 Fabric 직렬화 형식입니다. 좌표는 페이지 px이고 originX/originY가 \"center\"라서 left/top은 개체의 중심점입니다. 크기는 width·height × scaleX·scaleY입니다.",
    "    - type: 글자 \"textbox\" (text, fontFamily, fontSize, fontWeight, fill, textAlign, width, lineHeight), 도형 \"rect\"·\"ellipse\"·\"triangle\"·\"polygon\"·\"path\", 선 \"doryline\", 이미지 \"image\" (src), 묶음 \"group\" (objects).",
    "    - 기존 개체를 고칠 때는 필요한 속성만 바꾸고 id와 모르는 키는 그대로 두세요. 새 개체는 기존 개체를 복사해 고치고 새 UUID id를 붙이세요.",
    `    - 이미지 src는 원본 디자인 폴더(${folder}) 기준 상대 경로입니다. 새 그림은 그 폴더의 <디자인 이름>.assets/ 아래에 두고 그 경로를 쓰세요.`,
    "    - 기본 글꼴은 \"Achmage SameTone\"입니다. 결과는 반드시 올바른 JSON이어야 합니다 (앱이 검증하고, 깨지면 적용하지 않습니다).",
  ];
  const outline = workingText ? designOutline(workingText) : [];
  if (outline.length) {
    lines.push("  · 현재 개체 목록:");
    for (const line of outline) lines.push(`    ${line}`);
  }
  return lines;
}
