/** Adapt the pinned renderer's undo boundary without modifying vendor files or
 * the PDF serialization engine. Every marker is checked when the app is built.
 * ONE undo: Workbench's history (pending-edit snapshots over saved revisions) owns Undo/Redo. v0.13.0's
 * own undo for page operations written to the file at once (161e68fff: Replace pages, Page size, Crop,
 * Insert PDF keep up to ten whole-file before/after copies, `writtenRef`) records no steps here: a page
 * operation is a new Workbench revision, as before, and earlier revisions stay in the tab's 판 기록. */
export function patchPdfHistory(code: string, modulePath: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original PDF history boundary changed: ${before.slice(0, 90)}`);
    code = code.replace(before, after);
  };
  for (const name of ["undoStack", "redoStack"]) {
    const setter = name === "undoStack" ? "setUndoStack" : "setRedoStack";
    replace(`const [${name}, ${setter}] = useState<EditSnapshot[]>([])`, `const [${name}, ${setter}] = useState<WorkbenchPdfSnapshot[]>([])`);
  }
  replace("  const coalesceKeyRef = useRef<string | null>(null)", "  const wbHistoryBusyRef = useRef(false)\n  const wbDisplayedBase = useRef<PdfHistoryBase | null>(null)\n  const [wbHistoryBusy, setWbHistoryBusy] = useState(false)\n  const coalesceKeyRef = useRef<string | null>(null)");
  replace("      waitForPageNos: number[] = [],\n    ) => {", "      waitForPageNos: number[] = [],\n      wbKeepHistory = false,\n    ) => {");
  // v0.13.0 reads the file in 8 MiB slices (73c69181f).
  replace("      const bytes = await readFileBytes(window.pdfApi, path)\n", "      const bytes = await readFileBytes(window.pdfApi, path)\n      const wbLoadedBase = pdfHistory.capture()\n");
  // A corrupt/unavailable historical base must leave the current pending edits
  // and catalog intact. Adopt UI state only after PDF.js has validated the file.
  const resetStart = code.indexOf("      setFormHasXfa(xfaMarker)\n"), resetEnd = code.indexOf("      const task = loadPdfForView(bytes, passwordRef.current)", resetStart);
  if (resetStart < 0 || resetEnd < 0) throw new Error("Original PDF load preparation changed");
  const resetForm = code.slice(resetStart, resetEnd);
  code = code.slice(0, resetStart) + code.slice(resetEnd);
  replace("      const userUnits: number[] = []", "      const userUnits: number[] = []\n      let wbDocInfo = { title: '', author: '', subject: '', keywords: '' }\n      let wbFormFeatures = { hasXfa: xfaMarker, encrypted: false }");
  replace(`        setDocInfo({
          title: documentInfo.Title ?? '',
          author: documentInfo.Author ?? '',
          subject: documentInfo.Subject ?? '',
          keywords: documentInfo.Keywords ?? '',
        })`, `        wbDocInfo = {
          title: documentInfo.Title ?? '',
          author: documentInfo.Author ?? '',
          subject: documentInfo.Subject ?? '',
          keywords: documentInfo.Keywords ?? '',
        }`);
  // The encrypted-file branch after it (the session's own decryptor) still reads `formFeatures`.
  replace(`        const formFeatures = documentFormFeatures(documentInfo, bytes)
        setFormHasXfa(formFeatures.hasXfa || xfaMarker)
        setDocumentEncrypted(formFeatures.encrypted)
`, `        const formFeatures = documentFormFeatures(documentInfo, bytes)
        wbFormFeatures = { hasXfa: formFeatures.hasXfa || xfaMarker, encrypted: formFeatures.encrypted }
`);
  replace("      try {\n        setFormCatalog(await buildFormCatalog(loaded))", resetForm + "      setDocInfo(wbDocInfo)\n      setFormHasXfa(wbFormFeatures.hasXfa)\n      setDocumentEncrypted(wbFormFeatures.encrypted)\n      try {\n        setFormCatalog(await buildFormCatalog(loaded))");
  replace("      setUndoStack([])\n      setRedoStack([])", "      wbDisplayedBase.current = wbLoadedBase\n      if (!saved && !wbKeepHistory) {\n        setUndoStack([])\n        setRedoStack([])\n      }\n      coalesceKeyRef.current = null");
  replace("  const readOnly =\n    status === 'ready' &&\n", "  const readOnly =\n    wbHistoryBusy || !pdfHistory.writable() ||\n    status === 'ready' &&\n");
  replace("  const snapshot = (): EditSnapshot => ({", "  const snapshot = (): WorkbenchPdfSnapshot => ({\n    wbBase: wbDisplayedBase.current ?? pdfHistory.capture(),");
  replace("  const editOpContext = (): OpContext => ({\n    readOnly,", "  const editOpContext = (): OpContext => ({\n    readOnly: readOnly || wbHistoryBusyRef.current,");
  replace("    readOnly: () => readOnly,", "    readOnly: () => readOnly || wbHistoryBusyRef.current,");
  replace("    setStampCfg(s.stampCfg)", "    stampRef.current = s.stampCfg\n    setStampCfg(s.stampCfg)");
  const start = code.indexOf("  const undo = () => {"), end = code.indexOf("  // ── Full-text search", start);
  if (start < 0 || end < 0 || !code.slice(start, end).includes("  const redo = () => {")) throw new Error("Original PDF undo/redo handlers changed");
  code = code.slice(0, start) + `  const travelHistory = (direction: 'undo' | 'redo') => {
    if (readOnly || wbHistoryBusyRef.current || saveInFlightRef.current) return
    const stack = direction === 'undo' ? undoStack : redoStack
    const top = stack[stack.length - 1]
    if (!top) return
    const cur = snapshot()
    // Pending redaction regions have page coordinates too. Keep the original
    // structure barrier until those regions are resolved; never move them blindly.
    if (top.wbBase !== cur.wbBase && redactions.length > 0) {
      showNotice(t('redactStructureBlocked'))
      return
    }
    wbHistoryBusyRef.current = true
    setWbHistoryBusy(true)
    const run = (async () => {
      try {
        if (top.wbBase !== cur.wbBase) {
          await pdfHistory.restore(top.wbBase, () => loadDoc(filePath, doc, undefined, [], true))
        }
        // the marked places may be the ones this takes back (as v0.13.0's own undo does)
        setAiMarks(null)
        applySnapshot(top)
        setRestoredUnsaved(pdfHistory.unsaved())
        if (direction === 'undo') {
          setRedoStack((r) => [...r, cur])
          setUndoStack((u) => u.slice(0, -1))
        } else {
          setUndoStack((u) => [...u, cur])
          setRedoStack((r) => r.slice(0, -1))
        }
        coalesceKeyRef.current = null
        await pdfHistoryRendered()
      } catch (error) {
        showNotice(t(direction) + ': ' + (error instanceof Error ? error.message : String(error)))
      } finally {
        wbHistoryBusyRef.current = false
        setWbHistoryBusy(false)
      }
    })()
    pdfHistory.track(run)
  }
  const undo = () => travelHistory('undo')
  const redo = () => travelHistory('redo')
  // office-leftovers point 2: a new revision (a hidden tab's 문서 AI result) is loaded into this viewer in place —
  // its own load path (the page serves the new bytes to readFile), the pages, zoom and scroll element kept.
  ;(window as unknown as Record<string, unknown>).__workbenchPdfReload = () => loadDoc(filePath, doc, undefined, [])

` + code.slice(end);
  replace("  const saveInPlace = (autosave = false, flushAll = false): Promise<boolean> => {", "  const saveInPlace = (autosave = false, flushAll = false): Promise<boolean> => {\n    if (wbHistoryBusyRef.current) return Promise.resolve(false)");
  replace("      inert={redactionCopyInFlight}", "      inert={redactionCopyInFlight || wbHistoryBusy}");
  replace("      aria-busy={redactionCopyInFlight}", "      aria-busy={redactionCopyInFlight || wbHistoryBusy}");
  for (const [stack, steps] of [["undoStack", "written.undo"], ["redoStack", "written.redo"]]) replace(`disabled={${stack}.length === 0 && ${steps} === 0}`, `disabled={${stack}.length === 0 && ${steps} === 0 || readOnly || saveState === 'saving'}`);
  // Upstream's written steps: none recorded (above). The page operation reloads as it did before v0.13.0,
  // without first reading a whole-file "before" copy for a step that would never be used.
  replace(`    const kept = writtenRef.current.undo
    const pageCount = await loadDoc(filePath, doc)
    const after = await window.pdfApi.readFile(filePath)
    setWritten({ undo: [...kept.slice(-(MAX_WRITTEN_STEPS - 1)), { before, after }], redo: [] })
    return pageCount`, "    void before\n    return loadDoc(filePath, doc)");
  replace("      held.before = await window.pdfApi.readFile(filePath)\n", "");
  return `import { pdfHistory, pdfHistoryRendered, type PdfHistoryBase } from ${JSON.stringify(modulePath)};\ntype WorkbenchPdfSnapshot = EditSnapshot & { wbBase: PdfHistoryBase };\n${code}`;
}
