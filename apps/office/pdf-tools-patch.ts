/** v0.13.0's PDF tools in Workbench (unit pdf-tools). Applied after pdf-history-patch.ts (it uses that patch's
 * snapshot base and its `wbKeepHistory` load). Every marker is checked when the app is built.
 * - 붙여넣기 (paste pages) writes a new revision; ONE undo goes back to the view as it was before the paste
 *   (Workbench's history restores the earlier revision with its pending edits).
 * - 잘라내기 (cut) = copy + delete, written at once as one revision (upstream leaves the deletion pending).
 * - 파일 크기 줄이기 says the sizes before and after, beside upstream's percentage. */
export function patchPdfTools(code: string): string {
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2) throw new Error(`Original PDF tools boundary changed: ${before.slice(0, 90)}`);
    code = code.replace(before, after);
  };
  replace(`    // the flush bakes the visible order into the file, so the anchor becomes its visible position
    const afterPageIndex = visListOf(orderRef.current).indexOf(afterOrigIdx)
    await flushThen(async () => {
      const result = await paste({ path: filePath, afterPageIndex })`, `    // the view before the paste, with its pending edits: what one undo brings back
    const wbBefore = snapshot()
    // the flush bakes the visible order into the file, so the anchor becomes its visible position
    const afterPageIndex = visListOf(orderRef.current).indexOf(afterOrigIdx)
    await flushThen(async () => {
      const result = await paste({ path: filePath, afterPageIndex })`);
  replace(`      if (result.insertedCount === 0) return
      await aiReadRef.current?.afterPageOperation().catch(() => null)
      await loadDoc(filePath, doc)
`, `      if (result.insertedCount === 0) return
      await aiReadRef.current?.afterPageOperation().catch(() => null)
      await loadDoc(filePath, doc, undefined, [], true)
      setUndoStack((u) => [...u.slice(-49), wbBefore])
      setRedoStack([])
      coalesceKeyRef.current = null
`);
  replace("    if (cut) deletePages(origIdxs)\n", "    if (cut) {\n      deletePages(origIdxs)\n      wbSaveCut.current = true\n    }\n");
  replace("  const [copiedPageCount, setCopiedPageCount] = useState(0)\n", `  const [copiedPageCount, setCopiedPageCount] = useState(0)
  // a cut is written at once: the deletion's render first, then the save of exactly that state
  const wbSaveCut = useRef(false)
  useEffect(() => {
    if (!wbSaveCut.current || !dirty) return
    wbSaveCut.current = false
    void save(false, true)
  })
`);
  replace("    showNotice(savedPct > 0 ? t('reduceDone', { pct: savedPct }) : t('reduceAlreadySmall'))", `    const wbSize = (n: number) => (n >= 1048576 ? \`\${(n / 1048576).toFixed(1)}MB\` : \`\${Math.max(1, Math.round(n / 1024))}KB\`)
    showNotice(
      savedPct > 0
        ? \`\${t('reduceDone', { pct: savedPct })} (\${wbSize(outcome.bytesBefore)} → \${wbSize(outcome.bytesAfter)})\`
        : t('reduceAlreadySmall'),
    )`);
  return code;
}
