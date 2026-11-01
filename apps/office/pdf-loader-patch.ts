/** Add only the runtime/setup boundary; the original OCR/search/markup UI stays intact. */
export function patchPdfLoader(code: string, module: string) {
  const button = '<span className="ribbon-tabs-spacer" />';
  const effect = "  const ocrPending = ocrRun?.stop === 'cap' ? (ocrRun.pending ?? null) : null";
  const passage = "pageText={async (origIdx) => (doc ? readPageText(doc, origIdx) : '')}";
  if (code.split(button).length !== 2 || code.split(effect).length !== 2 || code.split(passage).length !== 2) throw new Error("Original PDF OCR integration boundary changed");
  return `import { PdfLoaderButton } from ${JSON.stringify(module)};\n` + code.replace(passage, "pageText={async (origIdx) => ocrPages.get(origIdx)?.entry.text ?? (doc ? readPageText(doc, origIdx) : '')}").replace(button, `<PdfLoaderButton />${button}`).replace(effect, `${effect}
  useEffect(() => {
    const ready = () => { ocrAbortRef.current?.abort(); startOcrPass(null); };
    window.addEventListener('workbench:pdf-ocr-ready', ready);
    return () => window.removeEventListener('workbench:pdf-ocr-ready', ready);
  }, [startOcrPass]);`);
}
