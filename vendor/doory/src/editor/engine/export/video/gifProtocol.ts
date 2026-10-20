/** What the GIF writer and the code that feeds it say to each other (the writer runs in a worker where the browser has one). */

export interface GifSetup {
  width: number
  height: number
  /** 0 = forever, 1 = once, n = n times in all. */
  loops: number
  dither: boolean
  /** The write stops with an error once the file would pass this many bytes. */
  maxBytes: number
}

export type GifRequest =
  | { type: 'init'; setup: GifSetup }
  /** `pixels` is the frame's RGBA bytes (transferred, not copied). */
  | { type: 'frame'; pixels: ArrayBuffer; delayCs: number }
  | { type: 'extend'; delayCs: number }
  | { type: 'finish' }

export type GifReply =
  | { type: 'ready' }
  /** A frame has been taken in; `bytes` and `frames` are what the file holds so far. */
  | { type: 'ack'; bytes: number; frames: number }
  | { type: 'done'; buffer: ArrayBuffer; frames: number }
  | { type: 'error'; kind: 'too-large' | 'failed'; message: string }

export class GifTooLargeError extends Error {
  constructor(readonly limit: number) {
    super('The GIF is larger than the browser can build.')
    this.name = 'GifTooLargeError'
  }
}
