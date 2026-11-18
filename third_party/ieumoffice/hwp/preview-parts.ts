// Adapted from IeumOffice apps/hwp/src/main/preview-parts.ts @ 8602a39410adb86037f3008588b64efc75b08c60.
// Apache-2.0; see ../LICENSE and ../NOTICE. Changes recorded in hwp.manifest.json.
import { crc32, deflateSync } from 'node:zlib'
import { openHwp, rewriteStreams } from './hwp5-file.ts'
import { rewriteZip, zipEntries } from './tab-widths.ts'
import type { HwpFormat, SavePreview } from '../../../packages/contracts/src/hwp.ts'

/**
 * The preview a file carries for other programs: the first lines of its text
 * (`PrvText`) and a picture of its first page (`PrvImage`). The engine writes back the
 * preview of the file it opened, whatever was changed since; Hangul makes both again on
 * every save. A save here puts in the ones the editor made of the document as it is now
 * (decision 0146), so text deleted before saving does not stay in the file.
 */

const HWPX_TEXT = 'Preview/PrvText.txt'
const HWPX_IMAGE = 'Preview/PrvImage.png'
const HWP_TEXT = '/PrvText'
const HWP_IMAGE = '/PrvImage'

/** Characters of preview text Hangul keeps (2,044 bytes of UTF-16 in a Hangul 2024 file). */
export const PREVIEW_TEXT_CHARS = 1022
/** The largest preview picture taken: Hangul's is 724 × 1024 and some tens of KB. */
export const MAX_PREVIEW_IMAGE_BYTES = 4 * 1024 * 1024

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** A white 1 × 1 PNG: the picture when the editor could not draw the page. */
export const BLANK_PNG = Buffer.concat([
  PNG_SIGNATURE,
  // 1 × 1, 8 bits, RGB
  pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 0xff, 0xff, 0xff]))),
  pngChunk('IEND', Buffer.alloc(0)),
])

/** The preview as it goes into the file: text cut to Hangul's length, a PNG or the blank one. */
function partsOf(preview: SavePreview): { text: string; image: Buffer } {
  const image =
    preview.image &&
    preview.image.length > PNG_SIGNATURE.length &&
    preview.image.length <= MAX_PREVIEW_IMAGE_BYTES &&
    PNG_SIGNATURE.equals(Buffer.from(preview.image.subarray(0, PNG_SIGNATURE.length)))
      ? Buffer.from(preview.image)
      : BLANK_PNG
  return { text: Array.from(preview.text).slice(0, PREVIEW_TEXT_CHARS).join(''), image }
}

/**
 * The file with its preview replaced; null when the preview parts are not where this
 * looks (a file without them keeps what it has: there is nothing in it to go stale).
 */
export function writePreview(
  file: Uint8Array,
  format: HwpFormat,
  preview: SavePreview,
): Uint8Array | null {
  const { text, image } = partsOf(preview)
  if (format === 'hwpx') {
    const zip = Buffer.from(file.buffer, file.byteOffset, file.byteLength)
    const parts = zipEntries(zip)
    if (!parts) return null
    const changed = new Map<string, Buffer>()
    const names = new Set(parts.entries.map((entry) => entry.name))
    if (names.has(HWPX_TEXT)) changed.set(HWPX_TEXT, Buffer.from(text, 'utf8'))
    if (names.has(HWPX_IMAGE)) changed.set(HWPX_IMAGE, image)
    if (changed.size === 0) return null
    return rewriteZip(zip, parts, changed)
  }
  const opened = openHwp(file)
  if (!opened) return null
  const changed = new Map<string, Buffer>()
  const has = (path: string) =>
    opened.cfb.FullPaths.some(
      (full, index) => full.endsWith(path) && opened.cfb.FileIndex[index]?.type === 2,
    )
  if (has(HWP_TEXT)) changed.set(HWP_TEXT, Buffer.from(text, 'utf16le'))
  if (has(HWP_IMAGE)) changed.set(HWP_IMAGE, image)
  if (changed.size === 0) return null
  return rewriteStreams(opened, changed, new Set(changed.keys()))
}
