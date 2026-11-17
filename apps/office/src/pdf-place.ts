import { scrollerParts, type ViewParts } from "./view-position.ts";

/**
 * The PDF viewer's place is its PAGES scroller (`.pdf-scroll`), never another box that scrolls and holds canvases.
 * "The largest scroller with a canvas" was wrong: on opening, before the pages are laid out, the thumbnail rail
 * (`.pdf-thumbs`, its canvases the thumbnails) is the only such box, and the place parts kept it for the page's life —
 * the tab then said the rail's scroll as its place (it follows the current page's thumbnail) and put it back after an
 * in-place load, while the pages themselves were not kept (pdf-place-report.md).
 */
export const holdsPdfPages = (el: HTMLElement) => el.classList.contains("pdf-scroll");

/** The viewer scrolls to its current page once more after a load: the place counts as back only when it held for a while. */
export function pdfPlaceParts(doc: Document, holdFor = 8): ViewParts {
  const base = scrollerParts(doc, holdsPdfPages);
  let held = 0;
  return { read: base.read, restore: (position) => { held = base.restore(position) ? held + 1 : 0; return held >= holdFor; } };
}
