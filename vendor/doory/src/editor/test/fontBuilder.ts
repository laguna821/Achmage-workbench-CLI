/**
 * Builds the smallest byte sequences the font-file reader understands (a table directory with `name`, `OS/2`,
 * `head` and `post` tables, plain or as WOFF). They are not drawable fonts: tests that need a real one use the
 * fixtures under `e2e/editor/fixtures/fonts`.
 */
import { deflateSync } from 'node:zlib'

export interface SfntSpec {
  family: string
  /** Typographic family (name id 16); the reader prefers it over `family`. */
  typographicFamily?: string
  weightClass?: number
  italicSelection?: boolean
  macStyle?: number
  italicAngle?: number
  /** Names are written as UTF-16BE on the Windows platform unless this is `mac`. */
  platform?: 'windows' | 'mac'
}

function utf16(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i))
  return out
}

function nameTable(spec: SfntSpec): Uint8Array {
  const platform = spec.platform ?? 'windows'
  const entries: { id: number; text: string }[] = [{ id: 1, text: spec.family }]
  if (spec.typographicFamily) entries.push({ id: 16, text: spec.typographicFamily })
  const strings = entries.map((e) => (platform === 'mac' ? Uint8Array.from([...e.text].map((c) => c.charCodeAt(0))) : utf16(e.text)))
  const header = 6 + entries.length * 12
  const total = header + strings.reduce((n, s) => n + s.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint16(2, entries.length)
  view.setUint16(4, header)
  let offset = 0
  entries.forEach((entry, i) => {
    const at = 6 + i * 12
    view.setUint16(at, platform === 'mac' ? 1 : 3)
    view.setUint16(at + 2, platform === 'mac' ? 0 : 1)
    view.setUint16(at + 4, platform === 'mac' ? 0 : 0x409)
    view.setUint16(at + 6, entry.id)
    view.setUint16(at + 8, strings[i].length)
    view.setUint16(at + 10, offset)
    out.set(strings[i], header + offset)
    offset += strings[i].length
  })
  return out
}

function tables(spec: SfntSpec): [string, Uint8Array][] {
  const os2 = new Uint8Array(78)
  const os2View = new DataView(os2.buffer)
  os2View.setUint16(4, spec.weightClass ?? 400)
  os2View.setUint16(62, spec.italicSelection ? 1 : 0)
  const head = new Uint8Array(54)
  new DataView(head.buffer).setUint16(44, spec.macStyle ?? 0)
  const post = new Uint8Array(32)
  new DataView(post.buffer).setInt32(4, (spec.italicAngle ?? 0) * 65536)
  return [
    ['OS/2', os2],
    ['head', head],
    ['name', nameTable(spec)],
    ['post', post],
  ]
}

const pad4 = (n: number): number => (n + 3) & ~3

/** A TrueType-flavoured sfnt container (`flavor` 0x00010000) or an OpenType one (`OTTO`). */
export function buildSfnt(spec: SfntSpec, flavor: 'ttf' | 'otf' = 'ttf'): ArrayBuffer {
  const list = tables(spec)
  const directory = 12 + list.length * 16
  let offset = directory
  const out = new Uint8Array(directory + list.reduce((n, [, data]) => n + pad4(data.length), 0))
  const view = new DataView(out.buffer)
  out.set(flavor === 'otf' ? [0x4f, 0x54, 0x54, 0x4f] : [0, 1, 0, 0], 0)
  view.setUint16(4, list.length)
  list.forEach(([tag, data], i) => {
    const at = 12 + i * 16
    out.set([...tag].map((c) => c.charCodeAt(0)), at)
    view.setUint32(at + 8, offset)
    view.setUint32(at + 12, data.length)
    out.set(data, offset)
    offset += pad4(data.length)
  })
  return out.buffer
}

/** The same tables in a WOFF container, each deflated when `compress` is set. */
export function buildWoff(spec: SfntSpec, compress = true): ArrayBuffer {
  const list = tables(spec).map(([tag, data]) => {
    const packed = compress ? new Uint8Array(deflateSync(data)) : data
    return { tag, data: packed.length < data.length ? packed : data, original: data.length }
  })
  const directory = 44 + list.length * 20
  let offset = directory
  const out = new Uint8Array(directory + list.reduce((n, t) => n + pad4(t.data.length), 0))
  const view = new DataView(out.buffer)
  out.set([0x77, 0x4f, 0x46, 0x46], 0)
  view.setUint16(12, list.length)
  list.forEach((entry, i) => {
    const at = 44 + i * 20
    out.set([...entry.tag].map((c) => c.charCodeAt(0)), at)
    view.setUint32(at + 4, offset)
    view.setUint32(at + 8, entry.data.length)
    view.setUint32(at + 12, entry.original)
    out.set(entry.data, offset)
    offset += pad4(entry.data.length)
  })
  return out.buffer
}

export function asFile(buffer: ArrayBuffer, name: string): File {
  return new File([buffer], name, { type: 'application/octet-stream' })
}
