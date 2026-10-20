import type { DocPage, DoryDocument } from '@/types/document'
import { pageSize } from '../docOps'
import type { EditorEngine } from '../editor'
import { canvasToBlob, renderPageToCanvas } from '../render'
import { type ExportFile, type ExportOptions, type ExportStage, exportFormats } from './registry'
import { type FileNaming, type FilenameStyle, unixNow } from './filenames'
import { bundleFiles } from './zip'
import './formats'
import './video/formats'

export type PageSelection = { kind: 'all' } | { kind: 'current' } | { kind: 'pages'; pages: number[] }

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

/** The pages a selection means in `doc`, in document order, with their 0-based index. */
export function pickPages(doc: DoryDocument, activePageId: string, selection: PageSelection): { page: DocPage; index: number }[] {
  const all = doc.pages.map((page, index) => ({ page, index }))
  if (selection.kind === 'all') return all
  if (selection.kind === 'current') return all.filter((p) => p.page.id === activePageId)
  return all.filter((p) => selection.pages.includes(p.index + 1))
}

export function selectPages(engine: EditorEngine, selection: PageSelection): { page: DocPage; index: number }[] {
  return pickPages(engine.state.doc, engine.state.activePageId, selection)
}

export interface RunExportInput {
  formatId: string
  pages: PageSelection
  options: ExportOptions
  onProgress?: (fraction: number, stage?: ExportStage) => void
  signal?: AbortSignal
  /** Pack several files into one ZIP (default). `false` returns the files one by one. */
  bundle?: boolean
  /** File names: simple (default) or structured, with or without the Unix time of this run. */
  filenames?: { style: FilenameStyle; timestamp: boolean }
}

/**
 * Renders the chosen pages in the chosen format. A format that makes one file per page (PNG, JPG, SVG) answers with a
 * single ZIP when more than one page is chosen; a PDF is always one file. Does not download — see `downloadFiles`.
 */
export async function runExport(engine: EditorEngine, input: RunExportInput): Promise<ExportFile[]> {
  const format = exportFormats.get(input.formatId)
  if (!format) throw new ExportError(`Unknown export format "${input.formatId}".`)
  const pages = selectPages(engine, input.pages)
  if (pages.length === 0) throw new ExportError('Select at least one page.')
  const controller = new AbortController()
  const signal = input.signal ?? controller.signal
  // One timestamp for the whole run: every file and the ZIP carry the same seconds.
  const naming: FileNaming = { style: input.filenames?.style ?? 'simple', unix: input.filenames?.timestamp ? unixNow() : null }
  try {
    const files = await format.run({
      engine,
      document: engine.state.doc,
      pages,
      options: input.options,
      title: engine.state.title,
      naming,
      onProgress: input.onProgress ?? (() => undefined),
      signal,
    })
    return input.bundle === false ? files : await bundleFiles(files, engine.state.title, naming)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw err instanceof Error ? err : new ExportError('The export failed.')
  }
}

export function downloadFiles(files: readonly ExportFile[]): void {
  files.forEach((file, i) => {
    setTimeout(() => {
      const url = URL.createObjectURL(file.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }, i * 250)
  })
}

/** Copies the current page to the clipboard as a PNG. */
export async function copyPageAsPng(engine: EditorEngine): Promise<void> {
  const page = engine.getPage(engine.state.activePageId)
  if (!page) throw new ExportError('Nothing to copy.')
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new ExportError('Copying images is not supported in this browser.')
  const size = pageSize(engine.state.doc, page)
  const blobPromise = renderPageToCanvas(page, size, engine.loadContext, { multiplier: 1 }).then((c) => canvasToBlob(c, 'image/png'))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
}
