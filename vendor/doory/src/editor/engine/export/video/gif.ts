/**
 * The animated GIF writer. `gifenc` (MIT, loaded only when a GIF is made) does the colour reduction and the LZW
 * compression; the dithering and the removal of repeated frames are ours (`gifPixels.ts`).
 *
 * A GIF holds at most 256 colours per frame, so each frame gets its own palette (a global one would need every frame
 * first, which a streaming export does not have). A frame that equals the one before it is not stored again: the
 * previous frame is shown for longer. A still page therefore costs one frame whatever its time.
 */
// `gifenc` ships without types; this brings ours in for every TypeScript project that reaches this file (the app, the template scripts).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./gifenc.d.ts" />
import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { type GifSetup, GifTooLargeError } from './gifProtocol'
import { framesEqual, ditherToPalette } from './gifPixels'

export { GifTooLargeError }
export type { GifSetup }

/** The longest a frame may be shown: the delay is a 16-bit number of hundredths of a second. */
const MAX_DELAY_CS = 65_535

export interface GifWriter {
  /** Adds a frame shown for `delayCs` hundredths of a second. The pixels are copied if they are kept, unless `owned` says the caller will not touch them again. */
  push(rgba: Uint8ClampedArray, delayCs: number, owned?: boolean): void
  /** The frame before is shown for `delayCs` longer (the caller knows nothing changed). */
  extend(delayCs: number): void
  /** Frames stored so far (the one being held back included). */
  readonly frames: number
  /** Bytes written so far. */
  readonly bytes: number
  finish(): Blob
  /** The bytes of the finished file, for a caller that sends them on (the worker). */
  finishBytes(): Uint8Array
}

export function createGifWriter(setup: GifSetup): GifWriter {
  const encoder = GIFEncoder({ initialCapacity: 1 << 18 })
  const { width, height } = setup
  const repeat = setup.loops === 0 ? 0 : setup.loops === 1 ? -1 : setup.loops - 1
  let held: Uint8ClampedArray | null = null
  let heldDelay = 0
  let written = 0

  const write = (): void => {
    if (!held) return
    // `gifenc` accepts only the plain byte array types; the view is the same memory.
    const bytes = new Uint8Array(held.buffer, held.byteOffset, held.byteLength)
    const palette = quantize(bytes, 256, { format: 'rgb565' })
    const index = setup.dither ? ditherToPalette(held, width, height, palette) : applyPalette(bytes, palette, 'rgb565')
    let remaining = heldDelay
    // A frame shown for longer than the format can count is written again.
    do {
      const delay = Math.min(remaining, MAX_DELAY_CS)
      encoder.writeFrame(index, width, height, { palette, delay: delay * 10, repeat, first: written === 0 })
      written += 1
      remaining -= delay
    } while (remaining > 0)
    if (encoder.bytesView().length > setup.maxBytes) throw new GifTooLargeError(setup.maxBytes)
    held = null
    heldDelay = 0
  }

  return {
    push(rgba, delayCs, owned = false) {
      if (held && framesEqual(held, rgba)) {
        heldDelay += delayCs
        return
      }
      write()
      held = owned ? rgba : new Uint8ClampedArray(rgba)
      heldDelay = delayCs
    },
    extend(delayCs) {
      if (held) heldDelay += delayCs
    },
    get frames() {
      return written + (held ? 1 : 0)
    },
    get bytes() {
      return encoder.bytesView().length
    },
    finishBytes() {
      write()
      encoder.finish()
      return encoder.bytes()
    },
    finish() {
      return new Blob([this.finishBytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' })
    },
  }
}
