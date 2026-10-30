/** Adapt the pinned renderer's undo boundary without modifying vendor files or
 * the PDF serialization engine. Every marker is checked when the app is built. */
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
  replace("      const data = await window.pdfApi.readFile(path)", "      const data = await window.pdfApi.readFile(path)\n      const wbLoadedBase = pdfHistory.capture()");
  // A corrupt/unavailable historical base must leave the current pending edits
  // and catalog intact. Adopt UI state only after PDF.js has validated the file.
  const resetStart = code.indexOf("      setFormHasXfa(hasXfaMarker(bytes))"), resetEnd = code.indexOf("      const task = getDocument({", resetStart);
  if (resetStart < 0 || resetEnd < 0) throw new Error("Original PDF load preparation changed");
  const resetForm = code.slice(resetStart, resetEnd);
  code = code.slice(0, resetStart) + code.slice(resetEnd);
  replace("      const userUnits: number[] = []", "      const userUnits: number[] = []\n      let wbDocInfo = { title: '', author: '', subject: '', keywords: '' }\n      let wbFormFeatures = { hasXfa: false, encrypted: false }");
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
  replace(`        const formFeatures = documentFormFeatures(documentInfo, bytes)
        setFormHasXfa(formFeatures.hasXfa)
        setDocumentEncrypted(formFeatures.encrypted)`, "        wbFormFeatures = documentFormFeatures(documentInfo, bytes)");
  replace("      try {\n        setFormCatalog(await buildFormCatalog(loaded))", resetForm + "      setDocInfo(wbDocInfo)\n      setFormHasXfa(wbFormFeatures.hasXfa)\n      setDocumentEncrypted(wbFormFeatures.encrypted)\n      try {\n        setFormCatalog(await buildFormCatalog(loaded))");
  replace("      setUndoStack([])\n      setRedoStack([])", "      wbDisplayedBase.current = wbLoadedBase\n      if (!saved && !wbKeepHistory) {\n        setUndoStack([])\n        setRedoStack([])\n      }\n      coalesceKeyRef.current = null");
  replace("  const readOnly = status === 'ready' && (passwordRef.current !== undefined || documentEncrypted)", "  const readOnly = wbHistoryBusy || !pdfHistory.writable() || (status === 'ready' && (passwordRef.current !== undefined || documentEncrypted))");
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

` + code.slice(end);
  replace("  const saveInPlace = (autosave = false, flushAll = false): Promise<boolean> => {", "  const saveInPlace = (autosave = false, flushAll = false): Promise<boolean> => {\n    if (wbHistoryBusyRef.current) return Promise.resolve(false)");
  replace("      inert={redactionCopyInFlight}", "      inert={redactionCopyInFlight || wbHistoryBusy}");
  replace("      aria-busy={redactionCopyInFlight}", "      aria-busy={redactionCopyInFlight || wbHistoryBusy}");
  for (const stack of ["undoStack", "redoStack"]) replace(`disabled={${stack}.length === 0}`, `disabled={${stack}.length === 0 || readOnly || saveState === 'saving'}`);
  return `import { pdfHistory, pdfHistoryRendered, type PdfHistoryBase } from ${JSON.stringify(modulePath)};\ntype WorkbenchPdfSnapshot = EditSnapshot & { wbBase: PdfHistoryBase };\n${code}`;
}
