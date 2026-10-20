/**
 * The GIF worker: colour reduction, dithering and compression of every frame happen here, so the page keeps drawing
 * the next frame (and answering the person) while the last one is being written. It holds one GIF at a time.
 */
import { createGifWriter, type GifWriter } from './gif'
import { type GifReply, type GifRequest, GifTooLargeError } from './gifProtocol'

/** The slice of the dedicated worker scope used here (the project compiles against the DOM library). */
interface WorkerScope {
  postMessage(message: GifReply, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<GifRequest>) => void) | null
}
const scope = self as unknown as WorkerScope

let writer: GifWriter | null = null

function fail(error: unknown): void {
  const tooLarge = error instanceof GifTooLargeError
  scope.postMessage({ type: 'error', kind: tooLarge ? 'too-large' : 'failed', message: error instanceof Error ? error.message : 'The GIF could not be written.' })
}

scope.onmessage = (event) => {
  const request = event.data
  try {
    if (request.type === 'init') {
      writer = createGifWriter(request.setup)
      scope.postMessage({ type: 'ready' })
    } else if (!writer) {
      throw new Error('The GIF writer was not started.')
    } else if (request.type === 'frame') {
      writer.push(new Uint8ClampedArray(request.pixels), request.delayCs, true)
      scope.postMessage({ type: 'ack', bytes: writer.bytes, frames: writer.frames })
    } else if (request.type === 'extend') {
      writer.extend(request.delayCs)
    } else {
      const frames = writer.frames
      const bytes = writer.finishBytes()
      writer = null
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      scope.postMessage({ type: 'done', buffer, frames }, [buffer])
    }
  } catch (error) {
    writer = null
    fail(error)
  }
}
