/**
 * Where the pixels of a GIF go: to a worker that writes the file (colour reduction, dithering and compression cost
 * around 50 ms a frame at 480p and twice that at 720p, which is a stutter on the page), or, where the browser has no
 * module workers or will not start ours, to the same writer on the page's own thread. The caller sees one interface
 * either way: `push` resolves when the writer can take the next frame, which holds the frames in flight to a few.
 */
import { type GifReply, type GifRequest, type GifSetup, GifTooLargeError } from './gifProtocol'

export interface GifSink {
  /** Hands over a frame (`rgba` must not be used afterwards) shown for `delayCs`; resolves when the writer has room. */
  push(rgba: Uint8ClampedArray, delayCs: number): Promise<void>
  /** The frame before is shown for `delayCs` longer. */
  extend(delayCs: number): void
  /** Bytes of the file so far, as of the last frame the writer has taken in. */
  readonly bytes: number
  readonly frames: number
  finish(): Promise<{ blob: Blob; frames: number }>
  /** Stops the worker; safe to call at any time and more than once. */
  dispose(): void
}

export interface WorkerLike {
  postMessage(message: GifRequest, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent<GifReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

/** Frames sent to the worker and not yet taken in. */
const MAX_IN_FLIGHT = 3
/** How long a worker may take to say it is up before the page writes the file itself. */
const START_TIMEOUT_MS = 4000

class WorkerSink implements GifSink {
  bytes = 0
  frames = 0
  private inFlight = 0
  private failure: Error | null = null
  private waiting: (() => void)[] = []
  private done: ((result: { blob: Blob; frames: number }) => void) | null = null

  constructor(private readonly worker: WorkerLike) {
    worker.onmessage = (event) => this.handle(event.data)
    worker.onerror = () => this.fail(new Error('The GIF writer stopped.'))
  }

  private handle(reply: GifReply): void {
    if (reply.type === 'ack') {
      this.bytes = reply.bytes
      this.frames = reply.frames
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.release()
    } else if (reply.type === 'done') {
      this.done?.({ blob: new Blob([reply.buffer], { type: 'image/gif' }), frames: reply.frames })
      this.done = null
    } else if (reply.type === 'error') {
      this.fail(reply.kind === 'too-large' ? new GifTooLargeError(0) : new Error(reply.message))
    }
  }

  private release(): void {
    const waiting = this.waiting
    this.waiting = []
    for (const resume of waiting) resume()
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.release()
    this.done = null
    this.rejectFinish?.(error)
  }

  private rejectFinish: ((error: Error) => void) | null = null

  async push(rgba: Uint8ClampedArray, delayCs: number): Promise<void> {
    while (this.inFlight >= MAX_IN_FLIGHT && !this.failure) await new Promise<void>((resolve) => this.waiting.push(resolve))
    if (this.failure) throw this.failure
    this.inFlight += 1
    this.worker.postMessage({ type: 'frame', pixels: rgba.buffer as ArrayBuffer, delayCs }, [rgba.buffer as ArrayBuffer])
  }

  extend(delayCs: number): void {
    if (!this.failure) this.worker.postMessage({ type: 'extend', delayCs })
  }

  finish(): Promise<{ blob: Blob; frames: number }> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.done = resolve
      this.rejectFinish = reject
      this.worker.postMessage({ type: 'finish' })
    })
  }

  dispose(): void {
    this.worker.terminate()
    this.release()
  }
}

/** The same writer on the page's thread. Each frame is taken in at once, so `push` never waits. */
async function inThread(setup: GifSetup): Promise<GifSink> {
  const { createGifWriter } = await import('./gif')
  const writer = createGifWriter(setup)
  return {
    get bytes() {
      return writer.bytes
    },
    get frames() {
      return writer.frames
    },
    push: async (rgba, delayCs) => writer.push(rgba, delayCs, true),
    extend: (delayCs) => writer.extend(delayCs),
    finish: async () => {
      const frames = writer.frames
      return { blob: writer.finish(), frames }
    },
    dispose: () => undefined,
  }
}

/** Starts a worker and waits for it to say it is ready; `null` when the browser has none or it does not come up. */
async function startWorker(setup: GifSetup, create: () => WorkerLike): Promise<WorkerSink | null> {
  let worker: WorkerLike
  try {
    worker = create()
  } catch {
    return null
  }
  return new Promise<WorkerSink | null>((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate()
      resolve(null)
    }, START_TIMEOUT_MS)
    worker.onmessage = (event) => {
      if (event.data.type !== 'ready') return
      clearTimeout(timer)
      resolve(new WorkerSink(worker))
    }
    worker.onerror = () => {
      clearTimeout(timer)
      worker.terminate()
      resolve(null)
    }
    worker.postMessage({ type: 'init', setup })
  })
}

/** The default way to make the worker: a module worker next to this file. */
const browserWorker = (): WorkerLike => new Worker(new URL('./gifWorker.ts', import.meta.url), { type: 'module', name: 'doory-gif' })

export async function createGifSink(setup: GifSetup, create: (() => WorkerLike) | null = typeof Worker === 'undefined' ? null : browserWorker): Promise<GifSink> {
  const worker = create ? await startWorker(setup, create) : null
  return worker ?? inThread(setup)
}
