/**
 * A tiny, dependency-free reader for the facts the upload dialog shows before a font leaves the browser: family,
 * weight and style from the `name`, `OS/2`, `head` and `post` tables of a TrueType / OpenType file, or of a WOFF
 * file (whose tables are zlib-compressed). WOFF2 is Brotli-compressed, which the platform cannot unpack, so its
 * facts are left to the server's answer (`FontFileInfo.family === null`).
 *
 * The reader only looks at bytes through a bounds-checked `DataView` and decompresses at most three small
 * tables, so a crafted file can at worst make it give up (`FontFileError`). The server remains the authority: it
 * validates every upload with fontTools and answers with the real family, weight and style.
 */

export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2'
export type FontStyleName = 'normal' | 'italic'

/** Limits the server enforces; the dialog checks them first so a bad file costs no upload. */
export const MAX_FONT_BYTES = 10 * 1024 * 1024
export const MAX_FONT_FILES = 5
export const FONT_EXTENSIONS: readonly FontFormat[] = ['ttf', 'otf', 'woff', 'woff2']

const MAX_TABLES = 128
const MAX_TABLE_BYTES = 2 * 1024 * 1024
const MAX_FAMILY_CHARS = 100

export interface FontFileInfo {
  format: FontFormat
  /** Family name as the server will store it; `null` when it cannot be read here (WOFF2). */
  family: string | null
  weight: number | null
  style: FontStyleName | null
}

export type FontFileProblem = 'empty' | 'too-large' | 'unsupported' | 'collection' | 'corrupt'

export class FontFileError extends Error {
  readonly problem: FontFileProblem
  constructor(problem: FontFileProblem) {
    super(problem)
    this.name = 'FontFileError'
    this.problem = problem
  }
}

/** Container format from the leading bytes (never from the file name). */
export function sniffFormat(bytes: Uint8Array): FontFormat | 'collection' | null {
  if (bytes.length < 4) return null
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (tag === 'wOFF') return 'woff'
  if (tag === 'wOF2') return 'woff2'
  if (tag === 'OTTO') return 'otf'
  if (tag === 'ttcf') return 'collection'
  if (tag === '\u0000\u0001\u0000\u0000' || tag === 'true') return 'ttf'
  return null
}

/** The server's rule for family names: letters, marks, digits, spaces and `-_.&+()`. */
export function cleanFamilyName(raw: string): string {
  const kept = [...raw.normalize('NFC')].filter((ch) => /[\p{L}\p{M}\p{N}]/u.test(ch) || ' -_.&+()'.includes(ch)).join('')
  return kept
    .replace(/\s+/g, ' ')
    .replace(/^[ \-_.]+|[ \-_.]+$/g, '')
    .slice(0, MAX_FAMILY_CHARS)
    .trim()
}

interface TableRecord {
  offset: number
  length: number
  /** Present for WOFF tables: the size once decompressed. */
  inflatedLength?: number
}

function tagAt(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
}

function sfntTables(view: DataView): Map<string, TableRecord> {
  const count = view.getUint16(4)
  if (count === 0 || count > MAX_TABLES) throw new FontFileError('corrupt')
  const tables = new Map<string, TableRecord>()
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16
    tables.set(tagAt(view, at), { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) })
  }
  return tables
}

function woffTables(view: DataView): Map<string, TableRecord> {
  const count = view.getUint16(12)
  if (count === 0 || count > MAX_TABLES) throw new FontFileError('corrupt')
  const tables = new Map<string, TableRecord>()
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20
    tables.set(tagAt(view, at), { offset: view.getUint32(at + 4), length: view.getUint32(at + 8), inflatedLength: view.getUint32(at + 12) })
  }
  return tables
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const body = new Response(data as BodyInit).body
  if (typeof DecompressionStream === 'undefined' || !body) throw new FontFileError('corrupt')
  return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
}

/** The bytes of one table, unpacked when the file is WOFF; `null` when the font has no such table. */
async function tableBytes(buffer: ArrayBuffer, tables: Map<string, TableRecord>, tag: string): Promise<DataView | null> {
  const table = tables.get(tag)
  if (!table) return null
  const inflatedLength = table.inflatedLength ?? table.length
  if (inflatedLength > MAX_TABLE_BYTES || table.offset + table.length > buffer.byteLength) throw new FontFileError('corrupt')
  const raw = new Uint8Array(buffer, table.offset, table.length)
  const compressed = table.inflatedLength !== undefined && table.length < table.inflatedLength
  const data = compressed ? await inflate(raw) : raw
  if (compressed && data.length !== inflatedLength) throw new FontFileError('corrupt')
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

function decodeName(view: DataView, platform: number, offset: number, length: number): string {
  if (platform === 1) {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i))
    return text
  }
  let text = ''
  for (let i = 0; i + 1 < length; i += 2) text += String.fromCharCode(view.getUint16(offset + i))
  return text
}

/** The best string for the given name ids, in order of preference (Windows English first, then other Windows/Unicode, then Mac). */
function readName(view: DataView, ids: readonly number[]): string {
  const count = view.getUint16(2)
  const stringOffset = view.getUint16(4)
  for (const id of ids) {
    let best: { rank: number; text: string } | null = null
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 12
      const platform = view.getUint16(at)
      if (view.getUint16(at + 6) !== id) continue
      const language = view.getUint16(at + 4)
      const rank = platform === 3 ? (language === 0x409 ? 0 : 1) : platform === 0 ? 2 : platform === 1 ? 3 : 9
      if (rank === 9 || (best && best.rank <= rank)) continue
      const length = view.getUint16(at + 8)
      const text = cleanFamilyName(decodeName(view, platform, stringOffset + view.getUint16(at + 10), length))
      if (text) best = { rank, text }
    }
    if (best) return best.text
  }
  return ''
}

/** Same rounding the server applies to `usWeightClass` (`apps/fonts/probe_worker.py`). */
export function normaliseWeight(weightClass: number, bold: boolean): number {
  const given = weightClass >= 1 && weightClass <= 1000 ? weightClass : bold ? 700 : 400
  return Math.min(900, Math.max(100, Math.round(given / 100) * 100))
}

/** Reads what the dialog shows about one font file. Throws `FontFileError` for a file the server would also refuse. */
export async function readFontInfo(buffer: ArrayBuffer): Promise<FontFileInfo> {
  if (buffer.byteLength === 0) throw new FontFileError('empty')
  if (buffer.byteLength > MAX_FONT_BYTES) throw new FontFileError('too-large')
  const format = sniffFormat(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)))
  if (format === 'collection') throw new FontFileError('collection')
  if (!format) throw new FontFileError('unsupported')
  if (format === 'woff2') return { format, family: null, weight: null, style: null }
  try {
    const view = new DataView(buffer)
    const tables = format === 'woff' ? woffTables(view) : sfntTables(view)
    const name = await tableBytes(buffer, tables, 'name')
    if (!name) throw new FontFileError('corrupt')
    const family = readName(name, [16, 1])
    if (!family) throw new FontFileError('corrupt')
    const os2 = await tableBytes(buffer, tables, 'OS/2')
    const head = await tableBytes(buffer, tables, 'head')
    const post = await tableBytes(buffer, tables, 'post')
    const macStyle = head && head.byteLength >= 46 ? head.getUint16(44) : 0
    const weightClass = os2 && os2.byteLength >= 6 ? os2.getUint16(4) : 0
    const selection = os2 && os2.byteLength >= 64 ? os2.getUint16(62) : 0
    const slanted = post && post.byteLength >= 8 ? post.getInt32(4) !== 0 : false
    return {
      format,
      family,
      weight: normaliseWeight(weightClass, (macStyle & 1) === 1),
      style: (selection & 1) === 1 || (macStyle & 2) === 2 || slanted ? 'italic' : 'normal',
    }
  } catch (error) {
    throw error instanceof FontFileError ? error : new FontFileError('corrupt')
  }
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
}

/** "Bold", "Regular Italic", "Light Italic": how a weight and style are named in the lists. */
export function variantLabel(weight: number, style: FontStyleName): string {
  const name = WEIGHT_NAMES[Math.min(900, Math.max(100, Math.round(weight / 100) * 100))] ?? String(weight)
  if (style !== 'italic') return name
  return weight === 400 ? 'Italic' : `${name} Italic`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The bytes of a file (`FileReader` rather than `Blob.arrayBuffer()`, which older engines and jsdom lack). */
export function readFileBytes(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => (reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new FontFileError('corrupt')))
    reader.onerror = () => reject(new FontFileError('corrupt'))
    reader.readAsArrayBuffer(file)
  })
}

/** The extension of a file name as a font format, or `null` when it is not one the server accepts. */
export function fontExtension(name: string): FontFormat | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return (FONT_EXTENSIONS as readonly string[]).includes(ext) ? (ext as FontFormat) : null
}
