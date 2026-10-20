import { BackgroundRemovalError, type BackgroundRemover, type BgRemovalProgress } from '../bgRemoval'
import { loadModel, type ModelStoreDeps } from './modelStore'
import type { ModelDescriptor } from './model'
import type { WorkerReply, WorkerRequest } from './protocol'

/** The part of a `Worker` the remover uses (so tests can stand in for it). */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}

export interface RemoverOptions {
  /** Starts a worker; the bundled one is `createCutoutWorker`. */
  createWorker: () => WorkerLike
  /** URL of the WebAssembly runtime file the worker needs. */
  wasmUrl: string
  /** Feather the edge by this many pixels (0: none). */
  feather?: number
  /** The worker (and its loaded model) is dropped after this many ms without work; a later call reloads it. */
  idleMs?: number
  modelStore?: ModelStoreDeps
  /** Threads for the WebAssembly runtime; defaults to 1 unless the page is cross-origin isolated. */
  threads?: number
  load?: typeof loadModel
}

export const IDLE_MS = 2 * 60 * 1000

function defaultThreads(): number {
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  const cores = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1
  return isolated ? Math.max(1, Math.min(4, cores)) : 1
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
}

/** Rejects as soon as `signal` aborts, while `promise` carries on in the background. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = <R>(done: (value: R) => void) => (value: R): void => {
      signal.removeEventListener('abort', onAbort)
      done(value)
    }
    promise.then(settle(resolve), settle(reject))
  })
}

type Pending = {
  id: number
  progress?: BgRemovalProgress
  resolve(png: Blob): void
  reject(error: Error): void
}

/**
 * Removes backgrounds with a model running in a worker. One removal runs at a time (the next waits its turn);
 * the worker starts on first use, keeps the model loaded between removals and is dropped when idle.
 */
export class WorkerBackgroundRemover implements BackgroundRemover {
  private worker: WorkerLike | null = null
  private ready: Promise<WorkerLike> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private pending: Pending | null = null
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly options: RemoverOptions

  constructor(
    private readonly model: ModelDescriptor,
    options: RemoverOptions,
  ) {
    this.options = options
  }

  remove(image: Blob, onProgress?: BgRemovalProgress, signal?: AbortSignal): Promise<Blob> {
    const run = this.queue.then(() => this.runOne(image, onProgress, signal))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Stops the worker and frees the model. The remover can be used again afterwards. */
  dispose(): void {
    clearTimeout(this.idleTimer)
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.fail(new BackgroundRemovalError('The background-removal engine was stopped.'))
  }

  private async runOne(image: Blob, onProgress?: BgRemovalProgress, signal?: AbortSignal): Promise<Blob> {
    if (signal?.aborted) throw abortError(signal)
    clearTimeout(this.idleTimer)
    try {
      const worker = await raceAbort(this.start(onProgress, signal), signal)
      return await this.execute(worker, image, onProgress, signal)
    } finally {
      this.armIdleTimer()
    }
  }

  private start(onProgress?: BgRemovalProgress, signal?: AbortSignal): Promise<WorkerLike> {
    if (!this.ready) {
      const booting = this.boot(onProgress, signal)
      this.ready = booting
      booting.catch(() => {
        if (this.ready === booting) this.ready = null
      })
    }
    return this.ready
  }

  private async boot(onProgress?: BgRemovalProgress, signal?: AbortSignal): Promise<WorkerLike> {
    const { load = loadModel, modelStore, createWorker, wasmUrl, threads = defaultThreads() } = this.options
    const buffer = await load(this.model, onProgress, signal, modelStore)
    let worker: WorkerLike
    try {
      worker = createWorker()
    } catch {
      throw new BackgroundRemovalError('The background-removal worker could not be started.')
    }
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event) => {
        const reply = event.data
        if (reply.type === 'ready') {
          this.attach(worker)
          resolve()
        } else if (reply.type === 'failed') {
          reject(new BackgroundRemovalError(reply.message, reply.reason === 'cancelled' ? 'unavailable' : reply.reason))
        }
      }
      const failed = (): void => reject(new BackgroundRemovalError('The background-removal worker failed to start.'))
      worker.onerror = failed
      worker.onmessageerror = failed
      worker.postMessage({ type: 'init', model: buffer, descriptor: this.model, wasmUrl, threads }, [buffer])
    }).catch((error: unknown) => {
      worker.terminate()
      throw error
    })
    this.worker = worker
    return worker
  }

  /** After the model is loaded the worker only ever answers a `run`. */
  private attach(worker: WorkerLike): void {
    worker.onmessage = (event) => this.handle(event.data)
    worker.onerror = () => this.crashed(worker)
    worker.onmessageerror = () => this.crashed(worker)
  }

  private handle(reply: WorkerReply): void {
    const job = this.pending
    if (!job || reply.type === 'ready') return
    if (reply.type === 'failed') {
      if (reply.id !== job.id) return
      this.pending = null
      job.reject(new BackgroundRemovalError(reply.message, reply.reason === 'cancelled' ? 'unavailable' : reply.reason))
    } else if (reply.id === job.id) {
      if (reply.type === 'progress') job.progress?.('processing', reply.percent)
      else {
        this.pending = null
        job.resolve(reply.png)
      }
    }
  }

  private crashed(worker: WorkerLike): void {
    if (this.worker !== worker) return
    this.dispose()
  }

  private fail(error: Error): void {
    const job = this.pending
    this.pending = null
    job?.reject(error)
  }

  private execute(worker: WorkerLike, image: Blob, onProgress?: BgRemovalProgress, signal?: AbortSignal): Promise<Blob> {
    const id = this.nextId++
    return new Promise<Blob>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.pending?.id !== id) return
        this.pending = null
        worker.postMessage({ type: 'cancel', id })
        reject(signal ? abortError(signal) : new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending = {
        id,
        progress: onProgress,
        resolve: (png) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(png)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      onProgress?.('processing', 0)
      worker.postMessage({ type: 'run', id, image, feather: this.options.feather ?? 0 })
    })
  }

  private armIdleTimer(): void {
    clearTimeout(this.idleTimer)
    if (!this.worker) return
    this.idleTimer = setTimeout(() => this.dispose(), this.options.idleMs ?? IDLE_MS)
  }
}
