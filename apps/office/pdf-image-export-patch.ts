/** The original save destroys its old PDF.js proxy. Export from the committed
 * post-save renderer, preserving the original page order/rotation/150dpi loop. */
export function patchPdfImageExport(code: string, historyModule: string): string {
  const before = "  const exportImages = (allPages: boolean) =>\n    flushThen(async () => {";
  const after = "    })\n\n  /** Commit the margin draft card";
  if (code.split(before).length !== 2 || code.split(after).length !== 2) throw new Error("Original PDF image-export boundary changed");
  code = code.replace(before, `  const wbExportImages = useRef<(allPages: boolean) => Promise<void>>(async () => {})
  const exportImages = async (allPages: boolean) => {
    if ((await flushThen(async () => true)) !== true) return
    await waitForPdfImageRender()
    return wbExportImages.current(allPages)
  }
  wbExportImages.current = async (allPages: boolean) => {`);
  code = code.replace(after, "    }\n\n  /** Commit the margin draft card");
  return `import { pdfHistoryRendered as waitForPdfImageRender } from ${JSON.stringify(historyModule)};\n${code}`;
}
