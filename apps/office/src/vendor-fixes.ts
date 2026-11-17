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
  {
    // office-leftovers point 3: a woken Excel tab comes back on its sheet and cell. The page reads and restores the
    // place through Univer's own facade (active sheet, active cell, scrollToCell); the app exposes it only in DEV
    // (its e2e hooks), so the opened workbook's facade is handed to the page here — read and move only.
    file: "apps/sheets/src/renderer/App.tsx",
    from: "    // Dev-only diagnosis hooks: e2e drivers dump journal state and dispatch\n",
    to: "    ;(window as unknown as Record<string, unknown>).__workbenchUniverAPI = univerRef.current?.univerAPI\n    // Dev-only diagnosis hooks: e2e drivers dump journal state and dispatch\n",
    why: "the Excel page keeps the tab's sheet and cell across sleep (office-leftovers point 3)",
  },
  {
    // office-leftovers point 2: a new revision (the 문서 AI's result from a hidden tab) is loaded INTO the running Markdown
    // editor through its own opening path (loadFromPath: no undo step, the source map rebuilt), instead of reopening
    // the page. While it loads, the editor is "not ready" for that one transaction so the load does not count as an edit.
    file: "apps/markdown/src/renderer/App.tsx",
    from: "    [editor, roundTripEnabled],\n  )\n",
    to: `    [editor, roundTripEnabled],
  )
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__workbenchTextReload = (raw: string) => {
      const before = statusRef.current
      statusRef.current = 'loading' as typeof before
      try { loadFromPath(filePathRef.current, raw) } finally { statusRef.current = before }
    }
  }, [loadFromPath])
`,
    why: "a hidden tab's 문서 AI result loads into the open Markdown editor (office-leftovers point 2)",
  },
  {
    // office-leftovers point 2: the same for the HTML editor — its source replaced as one load (the document's new
    // text is also what is saved, so it is not unsaved); the preview keeps its scroll (frameScrollRef is kept).
    file: "apps/html/src/renderer/App.tsx",
    from: "    [commitText, flushPending],\n  )\n",
    to: `    [commitText, flushPending],
  )
  useEffect(() => {
    // The preview's place as last seen on screen (a hidden frame reports 0 when it loses its layout).
    let shownY: number | null = null
    // (The tab's frame is hidden by its pane, not resized: the preview frame's own box says whether it is laid out.)
    const laidOut = () => [...document.querySelectorAll('iframe')].some((frame) => frame.clientHeight > 0)
    const look = window.setInterval(() => { if (laidOut()) shownY = frameScrollRef.current }, 400)
    ;(window as unknown as Record<string, unknown>).__workbenchTextReload = (raw: string) => {
      flushPending()
      // The preview reloads with the new source; a hidden tab's frame cannot be scrolled then (and reports 0):
      // the reader's place is handed back to the page, which puts it back once the frame is shown.
      const y = shownY ?? frameScrollRef.current
      const doc = parseDocText(raw)
      envelopeRef.current = doc.envelope
      editorRef.current?.replaceDoc(doc.text, false)
      commitText(doc.text, false)
      setSavedText(doc.text)
      return () => {
        if (y === null) return
        frameScrollRef.current = y
        previewRef.current?.post({ type: 'gx:scrollTo', y })
      }
    }
    return () => window.clearInterval(look)
  }, [commitText, flushPending])
`,
    why: "a hidden tab's 문서 AI result loads into the open HTML editor (office-leftovers point 2)",
  },
];
