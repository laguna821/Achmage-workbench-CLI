import { useEffect, useState } from "react";
import type { Artifact } from "@workbench/contracts";

type Format = Artifact["format"];
import { designToken } from "./design.ts";

// The document as its tab's placeholder (doc-pages-first, point 1): while a document's editor
// boots, the tab shows the first page of the revision it opens, as a picture made by the gateway
// ahead of time, at the place and size the editor will draw that page. The picture is keyed by
// the revision: a revision without its own picture shows none (never an older revision's).

export type Cover = { artifactId: string; revision: number; url: string; width: number; height: number };

/** The kinds whose placeholder is their first page (see `coverKind` for why not the others). */
export type CoverKind = "docx" | "pptx" | "hwpx";

/**
 * Which documents get the picture. Word, PowerPoint and Hangul: the picture is the page the editor
 * draws. Not Excel: its picture is a printed page (page breaks, no grid, no headers) while the
 * editor shows the sheet's grid — a different picture that then jumps. Not PDF: its viewer draws
 * its first page in under a second, faster than a picture would help.
 */
export function coverKind(format: Format | undefined): CoverKind | null {
  if (format === "docx" || format === "pptx") return format;
  if (format === "hwpx" || format === "hwp") return "hwpx";
  return null;
}

const known = new Map<string, Promise<Cover | null>>();
const key = (artifactId: string, revision: number) => `${artifactId}@${revision}`;

async function get(path: string) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${designToken()}` } });
  if (!response.ok) throw new Error(response.statusText);
  return response;
}

/**
 * The first-page picture of exactly this revision, or null (none made yet: the gateway makes it in
 * the background, the next opening has it). Pictures are kept for the session; "none yet" is asked
 * again next time.
 */
export function coverOf(artifactId: string, revision: number): Promise<Cover | null> {
  const id = key(artifactId, revision);
  let found = known.get(id);
  if (!found) {
    found = (async () => {
      const answer = (await (await get(`/api/artifacts/${artifactId}/cover?revision=${revision}`)).json()) as { revision: number; cover: { width: number; height: number } | null };
      if (!answer.cover || answer.revision !== revision) return null;
      const blob = await (await get(`/api/artifacts/${artifactId}/cover-image?revision=${revision}`)).blob();
      return { artifactId, revision, url: URL.createObjectURL(blob), width: answer.cover.width, height: answer.cover.height };
    })();
    known.set(id, found);
    found.then((cover) => { if (!cover) known.delete(id); }, () => known.delete(id));
    if (known.size > 60) {
      const [oldest, picture] = known.entries().next().value!;
      known.delete(oldest);
      void picture.then((cover) => cover && URL.revokeObjectURL(cover.url)).catch(() => undefined);
    }
  }
  return found;
}

/** The picture of `revision` when it is known (null until then, and when there is none). Never another revision's. */
export function useCover(artifactId: string, revision: number, format: Format | undefined, wanted: boolean): Cover | null {
  const [cover, setCover] = useState<Cover | null>(null);
  const kind = coverKind(format);
  useEffect(() => {
    // The rig's hook (scripts/webkit-pages-first-check.py measures the tab without the picture too).
    if (!wanted || !kind || (window as { __workbenchNoCover?: boolean }).__workbenchNoCover) return;
    let live = true;
    coverOf(artifactId, revision).then((found) => { if (live) setCover(found); }, () => undefined);
    return () => { live = false; };
  }, [artifactId, revision, kind, wanted]);
  return cover && cover.artifactId === artifactId && cover.revision === revision ? cover : null;
}

/**
 * Where the editor draws the first page in a frame of `box` (CSS px), so the picture can sit there,
 * with the editor's blank chrome around it (toolbar band, left rail, status bar: no buttons drawn).
 * Measured in WebKitGTK (scripts/webkit-pages-first-check.py, frames in ux/shots/pagesfirst/):
 *  - Word (docs.html): band 130 px (ribbon), rail 34 px (comments), status 44 px; the page at
 *    100 % (A4 = 794 px wide), 26 px below the band, centred right of the rail; grey ground.
 *  - PowerPoint (slides.html): band 130, rail 154 (comments + slide list), notes 100 + status 44
 *    below; the slide fitted to the height left minus 74 (48 above it for the AI chips, 26 below),
 *    centred right of the rail; grey ground.
 *  - Hangul (rhwp studio, HOP look since 0.5.3: rows 28 + 56 + 36 + 20): band 140 (menus, tools, ruler), rail 20 (ruler), status 44; the page
 *    at 100 % 10 px below the band, centred right of the rail; white ground.
 * `page`: the picture's own pixel size at `dpi` (Office pictures are 144 dpi, Hangul's size is in CSS px).
 */
export type CoverFit = { band: number; rail: number; status: number; left: number; top: number; width: number; height: number };

type Layout = { band: number; rail: number; status: number; below: number; gap: number; after: number; margin: number; mode: "page" | "fit"; dpi: number };
export const COVER_LAYOUT: Record<CoverKind, Layout> = {
  docx: { band: 130, rail: 34, status: 44, below: 0, gap: 26, after: 0, margin: 24, mode: "page", dpi: 144 },
  pptx: { band: 130, rail: 154, status: 44, below: 100, gap: 48, after: 26, margin: 32, mode: "fit", dpi: 144 },
  hwpx: { band: 140, rail: 20, status: 44, below: 0, gap: 10, after: 0, margin: 10, mode: "page", dpi: 96 },
};

/**
 * Below NARROW_FRAME px of frame width (measured at 928 vs 1368): the Word and PowerPoint ribbons
 * wrap their tab names onto two lines (band +7 px), and the Hangul studio fits the page to the width
 * (112 % at 928) instead of 100 %. Between the two measured widths the switch point is an estimate.
 */
export const NARROW_FRAME = 1100;

export function coverFit(kind: CoverKind, box: { width: number; height: number }, page: { width: number; height: number }): CoverFit {
  const narrow = box.width < NARROW_FRAME;
  const base = COVER_LAYOUT[kind];
  const layout = narrow && kind !== "hwpx" ? { ...base, band: base.band + 7 } : base;
  if (narrow && kind === "hwpx") {
    // The studio fits the page to the width left of its scroll bar (19 px), 10 px from the ruler.
    const width = Math.max(1, box.width - layout.rail - 19);
    return { band: layout.band, rail: layout.rail, status: layout.status, left: layout.rail + 10, top: layout.band + layout.gap + 1, width, height: Math.round((width * page.height) / page.width) };
  }
  const areaW = Math.max(1, box.width - layout.rail), areaH = Math.max(1, box.height - layout.band - layout.status - layout.below);
  let width: number;
  if (layout.mode === "page") {
    // The page at 100 %: its picture is `dpi` dots per inch, the screen 96 CSS px per inch.
    // (A picture's whole pixels are a hair under the page: A4 is 793.7 CSS px, its 144 dpi picture 1190 px = 793.3.)
    width = Math.min(Math.ceil((page.width * 96) / layout.dpi - 0.01), areaW - 2 * layout.margin);
  } else {
    width = Math.min(areaW - 2 * layout.margin, ((areaH - layout.gap - layout.after) * page.width) / page.height);
  }
  width = Math.max(1, Math.round(width));
  const height = Math.round((width * page.height) / page.width);
  const left = Math.round(layout.rail + (areaW - width) / 2);
  const top = layout.band + layout.gap;
  return { band: layout.band, rail: layout.rail, status: layout.status, left, top, width, height };
}

/** After this long without the editor, a quiet "여는 중" mark joins the picture. */
export const COVER_MARK_MS = 600;
/** The picture stays this long after the editor says it has opened, so the editor's own page is painted under it first. */
export const COVER_HOLD_MS = 120;
/** Without the editor's "drawn" report (its AI panel turned off), the picture goes this long after "opened". */
export const COVER_DRAW_WAIT_MS = 1500;
/**
 * Kinds whose page reports itself drawn at its fitted place (`office:page-drawn`): their picture waits for THAT report,
 * not for the AI panel's ready (PowerPoint draws its ribbon and AI panel before the slide, and showed its own "여는 중…"
 * for up to 1.3 s after the picture left — doc-pages-first, 1000×800). The bound is the fallback when the report never comes.
 */
export const PAGE_DRAWN_KINDS: ReadonlySet<CoverKind> = new Set(["pptx"]);
export const COVER_PAGE_WAIT_MS = 6000;
