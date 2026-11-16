import type { KoreanCopy } from "./korean-copy.ts";

/**
 * Behaviour fixes to the vendored editors, applied at build time by the same plugin as the Korean copy
 * (apps/office/korean-copy-plugin.ts): the vendored checkout (vendor/ieumoffice, fetched at its pin) is never
 * edited. Each `from` must occur exactly once in its file, or the build fails (the source changed: review here).
 */
export const VENDOR_FIXES: KoreanCopy[] = [
  {
    // one-doc-ai (the owner, 2026-11-16: an AI request in PowerPoint left the slide "우측 하단으로 잘려서", not centred).
    // The slides editor fits its zoom on opening and when the stage's box changes, never when the SLIDE's size
    // changes: an AI turn (or a template) that gives the deck another page size kept the old zoom, so the slide
    // overflowed the stage (overflow hidden while it "fits") and showed cut at the bottom/right
    // (scripts/slides-fit-check.ts, "makes the deck 4:3"). While the zoom is the fitted one (fit mode), a new slide
    // size is fitted again; a zoom the person chose is left as it is.
    file: "apps/slides/src/renderer/App.tsx",
    from: "    setScaleBox({ w: el.offsetWidth, h: el.offsetHeight })\n  }, [slide?.widthPx, slide?.heightPx])\n",
    to: `    setScaleBox({ w: el.offsetWidth, h: el.offsetHeight })
  }, [slide?.widthPx, slide?.heightPx])
  const fittedSizeRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!slide) return
    const size = \`\${slide.widthPx}x\${slide.heightPx}\`
    const before = fittedSizeRef.current
    fittedSizeRef.current = size
    if (before === null || before === size || needsFitRef.current) return
    const fitted = lastFitRef.current
    if (fitted == null || Math.abs(zoomLiveRef.current - fitted) > 0.001) return
    const z = fitZoom(slide)
    lastFitRef.current = z
    setZoom(z)
  }, [slide?.widthPx, slide?.heightPx, fitZoom])
`,
    why: "the slide is fitted again when an edit changes the page size (one-doc-ai, PowerPoint view jump)",
  },
];
