/**
 * Packs the files of a multi-page export into one ZIP, so "all pages" is a single download whatever the browser
 * thinks about several downloads at once. fflate (MIT) is loaded only when a ZIP is made.
 */
import { type FileNaming, SIMPLE_NAMING, structuredFilename } from './filenames'
import { type ExportFile, sanitizeFilename } from './registry'

/** Formats that are already compressed: stored as they are, deflating them again only costs time. */
const STORED = /\.(png|jpe?g|webp|gif|pdf|zip)$/i

// jsdom's Blob has no arrayBuffer(); the browsers all do.
function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then((b) => new Uint8Array(b))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read a file for the archive.'))
    reader.readAsArrayBuffer(blob)
  })
}

/** A name that is safe inside an archive: no folders, no leading dots, unique among `taken`. */
function entryName(filename: string, taken: Set<string>): string {
  const flat = filename.replace(/[\\/]+/g, '_').replace(/^\.+/, '')
  const dot = flat.lastIndexOf('.')
  const stem = dot > 0 ? flat.slice(0, dot) : flat || 'file'
  const ext = dot > 0 ? flat.slice(dot) : ''
  let name = `${stem}${ext}`
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`
  taken.add(name)
  return name
}

/** The archive's name: `<title>.zip`, or with structured names `<title>[_<unix>].zip` (the files' timestamp). */
export function zipFilename(title: string, naming: FileNaming = SIMPLE_NAMING): string {
  if (naming.style !== 'structured') return `${sanitizeFilename(title) || 'design'}.zip`
  return structuredFilename({ title, unix: naming.unix, extension: 'zip' })
}

/** The files as one ZIP archive (see `zipFilename`). */
export async function zipFiles(files: readonly ExportFile[], title: string, naming?: FileNaming): Promise<ExportFile> {
  const { zipSync } = await import('fflate')
  const taken = new Set<string>()
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  for (const file of files) {
    const name = entryName(file.filename, taken)
    entries[name] = [await readBytes(file.blob), { level: STORED.test(name) ? 0 : 6 }]
  }
  const bytes = zipSync(entries)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return { blob: new Blob([buffer], { type: 'application/zip' }), filename: zipFilename(title, naming) }
}

/** One file stays as it is; several become one ZIP. */
export async function bundleFiles(files: ExportFile[], title: string, naming?: FileNaming): Promise<ExportFile[]> {
  return files.length > 1 ? [await zipFiles(files, title, naming)] : files
}
