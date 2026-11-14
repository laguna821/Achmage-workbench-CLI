import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { hwpFontFace, hwpFontSnapshot } from "../hwp-fonts.ts";
import { repoRoot, shipped } from "../resources.ts";

// A Hangul page drawn by rhwp (SVG) as a PNG a phone shows inline: rasterized by resvg (WASM,
// bundled with the gateway), with the faces the page asks for as the gateway's font catalog finds
// them, and the app's own Pretendard for everything else. Fonts are read once, lazily, and kept.

/** The picture's width: what a phone shows sharply at full width. */
export const PICTURE_WIDTH = 1200;
/** At most this much font data is kept in memory for pictures. */
const FONT_BUDGET = 96 * 1024 * 1024;

let ready: Promise<void> | null = null;
const fonts = new Map<string, Uint8Array>();
let kept = 0;

function wasmPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = repoRoot();
  // The gateway bundle carries it beside host.mjs; a source checkout reads the package.
  const candidates = [join(here, "resvg_bg.wasm"), ...(root ? [join(root, "node_modules/@resvg/resvg-wasm/index_bg.wasm")] : [])];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("그림 변환기(resvg)를 찾지 못했습니다.");
  return found;
}

/** The Hangul font that ships with the app (OFL): what any text falls back to. */
function shippedFont(): Uint8Array {
  const root = repoRoot();
  const path = shipped("web/fonts/pretendard/PretendardVariable.ttf") ?? (root ? join(root, "apps/web/public/fonts/pretendard/PretendardVariable.ttf") : null);
  if (!path || !existsSync(path)) throw new Error("기본 한글 글꼴을 찾지 못했습니다.");
  return remember(`shipped:${path}`, () => new Uint8Array(readFileSync(path))) ?? new Uint8Array();
}

function remember(key: string, load: () => Uint8Array): Uint8Array | null {
  const known = fonts.get(key);
  if (known) return known;
  const bytes = load();
  if (kept + bytes.length > FONT_BUDGET) return null;
  fonts.set(key, bytes);
  kept += bytes.length;
  return bytes;
}

/** Each font-family list of the page, in its order of preference. */
function familyLists(svg: string): string[][] {
  const lists = new Set([...svg.matchAll(/font-family="([^"]+)"/g)].map((match) => match[1]!));
  return [...lists].map((list) => list.replace(/&apos;|&quot;/g, "'").split(",").map((name) => name.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean));
}

/** For each list, the first family the catalog has (one face each), read once. */
async function catalogFonts(svg: string): Promise<Uint8Array[]> {
  let snapshot: Awaited<ReturnType<typeof hwpFontSnapshot>>;
  try {
    snapshot = await hwpFontSnapshot();
  } catch {
    return [];
  }
  const out: Uint8Array[] = [];
  for (const list of familyLists(svg)) {
    for (const family of list) {
      const wanted = family.toLowerCase();
      // The regular face of the family (resvg picks a weight among the faces it is given; one face is
      // given, so it must be the upright regular one, not whichever the catalog lists first).
      const face = snapshot.faces
        .filter((entry) => [entry.family, ...(entry.aliases ?? [])].some((name) => name.toLowerCase() === wanted))
        .sort((a, b) => Number(a.slant !== "normal") - Number(b.slant !== "normal") || Math.abs((a.weight ?? 400) - 400) - Math.abs((b.weight ?? 400) - 400))[0];
      if (!face) continue;
      try {
        const { bytes } = await hwpFontFace(face.id, snapshot.revision);
        const font = remember(`face:${face.family}:${face.postscriptName}`, () => new Uint8Array(bytes));
        if (font && !out.includes(font)) out.push(font);
      } catch { /* A face that cannot be read: the next in the list, or the shipped font. */ }
      break;
    }
  }
  return out;
}

/** Memory held by the picture fonts now (bytes). */
export const pictureFontBytes = () => kept;

/** The page as a PNG `PICTURE_WIDTH` wide. Throws when it cannot be drawn. */
export async function hangulPng(svg: string): Promise<Uint8Array> {
  ready ??= initWasm(readFileSync(wasmPath())).catch((error: unknown) => { ready = null; throw error; });
  await ready;
  const buffers = [shippedFont(), ...(await catalogFonts(svg))];
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: PICTURE_WIDTH }, background: "white",
    font: { fontBuffers: buffers, defaultFontFamily: "Pretendard", sansSerifFamily: "Pretendard", serifFamily: "Pretendard" },
  });
  try {
    const image = resvg.render();
    try { return image.asPng(); } finally { image.free(); }
  } finally { resvg.free(); }
}
