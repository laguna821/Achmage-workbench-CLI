/** Pinned doory export seam. A changed upstream call site must be reviewed before building. */
export function patchDesign(path: string, source: string): string {
  const replace = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error(`doory adapter mismatch: ${path}: ${from.slice(0, 90)}`);
    source = source.replace(from, to);
  };
  if (path.endsWith("/engine/export/exporter.ts")) {
    const start = source.indexOf("export function downloadFiles(");
    const end = source.indexOf("/** Copies the current page", start);
    if (start < 0 || end < 0) throw new Error("doory downloadFiles boundary changed");
    const original = `export function downloadFiles(files: readonly ExportFile[]): void {\n  files.forEach((file, i) => {\n    setTimeout(() => {\n      const url = URL.createObjectURL(file.blob)\n      const a = document.createElement('a')\n      a.href = url\n      a.download = file.filename\n      document.body.appendChild(a)\n      a.click()\n      a.remove()\n      setTimeout(() => URL.revokeObjectURL(url), 10_000)\n    }, i * 250)\n  })\n}\n\n`;
    replace(original, `export async function downloadFiles(files: readonly ExportFile[]): Promise<void> {\n  if (!globalThis.workbenchDesignDownloads) throw new Error('디자인 저장 연결을 확인해 주세요.')\n  await globalThis.workbenchDesignDownloads(files)\n}\n\n`);
    replace("  const format = exportFormats.get(input.formatId)", "  const workbenchRevision = globalThis.workbenchDesignSource?.(engine.state.doc) ?? null\n  const format = exportFormats.get(input.formatId)");
    replace("    return input.bundle === false ? files : await bundleFiles(files, engine.state.title, naming)", "    const output = input.bundle === false ? files : await bundleFiles(files, engine.state.title, naming)\n    return globalThis.workbenchDesignTag?.(output, workbenchRevision) ?? output");
  } else if (path.endsWith("/TopBar.tsx") || path.endsWith("/dialogs/DownloadDialog.tsx")) {
    replace("downloadFiles(files)", "await downloadFiles(files)");
  } else if (path.endsWith("/presenter/commands.tsx")) {
    replace("function downloadNotes(editor: EditorEngine, format: NotesFormat): void {", "async function downloadNotes(editor: EditorEngine, format: NotesFormat): Promise<void> {");
    replace("  downloadFiles([file])\n  editor.toast(t.notes.downloaded(file.filename), 'success')", "  try {\n    await downloadFiles([file])\n    editor.toast(t.notes.downloaded(file.filename), 'success')\n  } catch (error) { editor.toast(error instanceof Error ? error.message : t.dialog.downloadFailed, 'error') }");
  } else if (path.endsWith("/dialogs/video/VideoSection.tsx")) {
    replace("  const download = (): void => {", "  const download = async (): Promise<void> => {");
    replace("    downloadFiles([{ blob: state.result.blob, filename: state.result.filename }])\n    editor.toast(p.downloadStarted, 'success')", "    try {\n      await downloadFiles([{ blob: state.result.blob, filename: state.result.filename }])\n      editor.toast(p.downloadStarted, 'success')\n    } catch (error) { editor.toast(error instanceof Error ? error.message : t.dialog.downloadFailed, 'error') }");
  }
  return source;
}
