/**
 * Reads the structure of the files the export makes, from their bytes alone: the boxes of an MP4, the elements of a
 * WebM, the blocks of a GIF. It is what the tests use to check what was written (a muxer that wrote an index but no
 * tracks, a GIF whose delays do not add up) without a player. Pure and free of everything else, so Node can run it too.
 */

const text = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length))
const u16 = (view: DataView, at: number): number => view.getUint16(at)
const u32 = (view: DataView, at: number): number => view.getUint32(at)

/* ------------------------------------------------------------------------------------------------
 * MP4
 * ---------------------------------------------------------------------------------------------- */

export interface Mp4Box {
  type: string
  /** Offset of the box's first byte (its size field). */
  start: number
  /** Offset of the first byte after the box's 8-byte header. */
  body: number
  end: number
  /** Names of the boxes this one is inside, outermost first. */
  path: string[]
}

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf'])

/** Every box of the file in order of appearance, containers included. */
export function mp4Boxes(bytes: Uint8Array): Mp4Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found: Mp4Box[] = []
  const walk = (start: number, end: number, path: string[]): void => {
    let at = start
    while (at + 8 <= end) {
      let size = u32(view, at)
      const type = text(bytes, at + 4, 4)
      let header = 8
      if (size === 1) {
        size = Number(view.getBigUint64(at + 8))
        header = 16
      } else if (size === 0) size = end - at
      if (size < header || at + size > end) throw new Error(`Broken MP4: box "${type}" at ${at} is ${size} bytes`)
      found.push({ type, start: at, body: at + header, end: at + size, path })
      if (MP4_CONTAINERS.has(type)) walk(at + header, at + size, [...path, type])
      at += size
    }
  }
  walk(0, bytes.length, [])
  return found
}

export interface Mp4Track {
  /** `vide` or `soun`. */
  handler: string
  /** `avc1`, `vp09`, `av01`, `mp4a`, `Opus`. */
  sampleEntry: string
  width: number | null
  height: number | null
  samples: number
  timescale: number
  durationMs: number
}

export interface Mp4Info {
  brands: string[]
  topLevel: string[]
  /** The index (`moov`) comes before the media (`mdat`): the file plays while it downloads. */
  fastStart: boolean
  durationMs: number
  tracks: Mp4Track[]
}

export function inspectMp4(bytes: Uint8Array): Mp4Info {
  const boxes = mp4Boxes(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const top = boxes.filter((b) => b.path.length === 0)
  const ftyp = top.find((b) => b.type === 'ftyp')
  const brands: string[] = []
  if (ftyp) {
    brands.push(text(bytes, ftyp.body, 4))
    for (let at = ftyp.body + 8; at + 4 <= ftyp.end; at += 4) brands.push(text(bytes, at, 4))
  }
  const mvhd = boxes.find((b) => b.type === 'mvhd')
  const movieScale = mvhd ? u32(view, mvhd.body + (bytes[mvhd.body] === 1 ? 20 : 12)) : 1
  const movieDuration = mvhd ? (bytes[mvhd.body] === 1 ? Number(view.getBigUint64(mvhd.body + 24)) : u32(view, mvhd.body + 16)) : 0
  const tracks: Mp4Track[] = boxes
    .filter((b) => b.type === 'trak')
    .map((trak) => {
      const inside = (type: string): Mp4Box | undefined => boxes.find((b) => b.type === type && b.start > trak.start && b.end <= trak.end)
      const hdlr = inside('hdlr')
      const mdhd = inside('mdhd')
      const stsd = inside('stsd')
      const stsz = inside('stsz')
      const version = mdhd ? bytes[mdhd.body] : 0
      const timescale = mdhd ? u32(view, mdhd.body + (version === 1 ? 20 : 12)) : 1
      const duration = mdhd ? (version === 1 ? Number(view.getBigUint64(mdhd.body + 24)) : u32(view, mdhd.body + 16)) : 0
      const entry = stsd ? stsd.body + 8 : 0
      const visual = stsd !== undefined && text(bytes, entry + 4, 4) !== 'mp4a' && text(bytes, entry + 4, 4) !== 'Opus'
      return {
        handler: hdlr ? text(bytes, hdlr.body + 8, 4) : '',
        sampleEntry: stsd ? text(bytes, entry + 4, 4) : '',
        width: visual ? u16(view, entry + 8 + 24) : null,
        height: visual ? u16(view, entry + 8 + 26) : null,
        samples: stsz ? u32(view, stsz.body + 8) : 0,
        timescale,
        durationMs: Math.round((duration * 1000) / timescale),
      }
    })
  const moov = top.findIndex((b) => b.type === 'moov')
  const mdat = top.findIndex((b) => b.type === 'mdat')
  return { brands, topLevel: top.map((b) => b.type), fastStart: moov >= 0 && mdat >= 0 && moov < mdat, durationMs: Math.round((movieDuration * 1000) / movieScale), tracks }
}

/* ------------------------------------------------------------------------------------------------
 * WebM
 * ---------------------------------------------------------------------------------------------- */

export interface WebmTrack {
  type: 'video' | 'audio' | 'other'
  codec: string
  width: number | null
  height: number | null
  hasCodecPrivate: boolean
}

export interface WebmInfo {
  /** The file starts with the EBML magic. */
  valid: boolean
  docType: string
  tracks: WebmTrack[]
  clusters: number
  /** Blocks of media (SimpleBlocks and BlockGroups) across all clusters. */
  blocks: number
  /** `Duration` of the Info element at its timecode scale, in ms; `null` when the file has none. */
  durationMs: number | null
  hasCues: boolean
}

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]
/** Elements whose children are read; all others are skipped by their size. */
const WEBM_PARENTS = new Set([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae, 0xe0, 0xe1, 0x1549a966, 0x1f43b675, 0xa0])

function ebmlId(bytes: Uint8Array, at: number): { id: number; length: number } {
  const length = Math.clz32(bytes[at]) - 23
  let id = 0
  for (let i = 0; i < length; i++) id = id * 256 + bytes[at + i]
  return { id, length }
}

function ebmlSize(bytes: Uint8Array, at: number): { size: number | null; length: number } {
  const length = Math.clz32(bytes[at]) - 23
  let value = bytes[at] & (0xff >> length)
  let ones = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]
    ones &&= bytes[at + i] === 0xff
  }
  return { size: ones ? null : value, length }
}

export function inspectWebm(bytes: Uint8Array): WebmInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const info: WebmInfo = { valid: EBML_MAGIC.every((b, i) => bytes[i] === b), docType: '', tracks: [], clusters: 0, blocks: 0, durationMs: null, hasCues: false }
  if (!info.valid) return info
  let scale = 1_000_000
  let duration: number | null = null
  let track: WebmTrack | null = null
  const walk = (start: number, end: number): void => {
    let at = start
    while (at < end) {
      const { id, length } = ebmlId(bytes, at)
      const { size, length: sizeLength } = ebmlSize(bytes, at + length)
      const body = at + length + sizeLength
      const stop = size === null ? end : Math.min(end, body + size)
      if (id === 0x4282) info.docType = text(bytes, body, stop - body)
      else if (id === 0x2ad7b1) scale = Array.from(bytes.subarray(body, stop)).reduce((v, b) => v * 256 + b, 0)
      else if (id === 0x4489) duration = stop - body === 8 ? view.getFloat64(body) : view.getFloat32(body)
      else if (id === 0x1c53bb6b) info.hasCues = true
      else if (id === 0x1f43b675) info.clusters += 1
      else if (id === 0xa3 || id === 0xa1) info.blocks += 1
      else if (id === 0xae) {
        track = { type: 'other', codec: '', width: null, height: null, hasCodecPrivate: false }
        info.tracks.push(track)
      } else if (track && id === 0x86) track.codec = text(bytes, body, stop - body)
      else if (track && id === 0x83) track.type = bytes[body] === 1 ? 'video' : bytes[body] === 2 ? 'audio' : 'other'
      else if (track && id === 0xb0) track.width = Array.from(bytes.subarray(body, stop)).reduce((v, b) => v * 256 + b, 0)
      else if (track && id === 0xba) track.height = Array.from(bytes.subarray(body, stop)).reduce((v, b) => v * 256 + b, 0)
      else if (track && id === 0x63a2) track.hasCodecPrivate = stop > body
      if (WEBM_PARENTS.has(id)) walk(body, stop)
      at = stop
    }
  }
  walk(0, bytes.length)
  if (duration !== null) info.durationMs = (duration * scale) / 1_000_000
  return info
}

/* ------------------------------------------------------------------------------------------------
 * GIF
 * ---------------------------------------------------------------------------------------------- */

export interface GifInfo {
  version: string
  width: number
  height: number
  /** Image frames in the file. */
  frames: number
  /** The delay of each frame in hundredths of a second. */
  delaysCs: number[]
  totalCs: number
  /** The loop count of the NETSCAPE extension: 0 = forever; `null` = no extension (the animation plays once). */
  loop: number | null
  /** Frames that carry their own palette. */
  localPalettes: number
  trailer: boolean
}

export function inspectGif(bytes: Uint8Array): GifInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = text(bytes, 0, 6)
  const info: GifInfo = { version, width: view.getUint16(6, true), height: view.getUint16(8, true), frames: 0, delaysCs: [], totalCs: 0, loop: null, localPalettes: 0, trailer: false }
  if (!version.startsWith('GIF8')) throw new Error('Not a GIF')
  const flags = bytes[10]
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0)
  const skipBlocks = (): void => {
    while (bytes[at] !== 0) at += bytes[at] + 1
    at += 1
  }
  let pendingDelay = 0
  while (at < bytes.length) {
    const block = bytes[at]
    if (block === 0x3b) {
      info.trailer = true
      break
    }
    if (block === 0x21) {
      const label = bytes[at + 1]
      if (label === 0xf9) {
        pendingDelay = view.getUint16(at + 4, true)
        at += 2 + 1 + bytes[at + 2] + 1
      } else if (label === 0xff) {
        const idText = text(bytes, at + 3, bytes[at + 2])
        at += 3 + bytes[at + 2]
        if (idText.startsWith('NETSCAPE') && bytes[at] === 3 && bytes[at + 1] === 1) info.loop = view.getUint16(at + 2, true)
        skipBlocks()
      } else {
        at += 2
        skipBlocks()
      }
    } else if (block === 0x2c) {
      const local = bytes[at + 9] & 0x80
      info.frames += 1
      info.delaysCs.push(pendingDelay)
      info.totalCs += pendingDelay
      if (local) info.localPalettes += 1
      at += 10 + (local ? 3 * 2 ** ((bytes[at + 9] & 7) + 1) : 0) + 1
      skipBlocks()
    } else throw new Error(`Unexpected GIF block 0x${block.toString(16)} at ${at}`)
  }
  return info
}
