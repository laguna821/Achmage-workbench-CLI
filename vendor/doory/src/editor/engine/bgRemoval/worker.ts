/**
 * The cut-out worker: decodes the photo, runs the model, refines the matte and encodes the PNG, all off the
 * editor's main thread. It holds one loaded model for as long as it lives.
 */
import { BackgroundRemovalError } from '../bgRemoval'
import { decodeImage, encodePng } from './image'
import { cutOut } from './pipeline'
import type { WorkerReply, WorkerRequest } from './protocol'
import { createSegmenter, isPolicyBlock, type Segmenter } from './session'
import type { ModelDescriptor } from './model'

/** The slice of the dedicated worker scope used here (the project compiles against the DOM library). */
interface WorkerScope {
  postMessage(message: WorkerReply): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}
const scope = self as unknown as WorkerScope

let segmenter: Segmenter | null = null
let descriptor: ModelDescriptor | null = null
const cancelled = new Set<number>()

function reply(message: WorkerReply): void {
  scope.postMessage(message)
}

/** Lets queued messages (a cancel) be handled between two synchronous stages. */
const yieldToMessages = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

class Cancelled extends Error {}

function failure(error: unknown, id: number | null): WorkerReply {
  if (error instanceof Cancelled) return { type: 'failed', id, reason: 'cancelled', message: 'Cancelled.' }
  if (error instanceof BackgroundRemovalError) return { type: 'failed', id, reason: error.reason, message: error.message }
  if (isPolicyBlock(error)) return { type: 'failed', id, reason: 'blocked', message: 'Blocked by the content security policy.' }
  return { type: 'failed', id, reason: 'unavailable', message: error instanceof Error ? error.message : 'Background removal failed.' }
}

async function init(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  try {
    descriptor = request.descriptor
    segmenter = await createSegmenter(request.model, request.descriptor, request.wasmUrl, request.threads)
    reply({ type: 'ready' })
  } catch (error) {
    reply(failure(error, null))
  }
}

async function run(request: Extract<WorkerRequest, { type: 'run' }>): Promise<void> {
  const { id } = request
  try {
    if (!segmenter || !descriptor) throw new BackgroundRemovalError('The model is not loaded.')
    const model = segmenter
    const check = async (percent: number): Promise<void> => {
      await yieldToMessages()
      if (cancelled.has(id)) throw new Cancelled()
      reply({ type: 'progress', id, percent })
    }
    const image = await decodeImage(request.image)
    await check(10)
    await cutOut(image.rgba, image.width, image.height, descriptor.input, { infer: (input) => model.run(input), step: check }, { feather: request.feather })
    const png = await encodePng(image.rgba, image.width, image.height)
    if (cancelled.has(id)) throw new Cancelled()
    reply({ type: 'progress', id, percent: 100 })
    reply({ type: 'done', id, png })
  } catch (error) {
    reply(failure(error, id))
  } finally {
    cancelled.delete(id)
  }
}

/**
 * With threads on, the model runtime starts its helper threads from this very script (their names start with
 * `em-pthread`) and listens to them itself, so only the cut-out worker installs its handler.
 */
if (!self.name.startsWith('em-pthread')) {
  scope.onmessage = (event) => {
    const request = event.data
    if (request.type === 'init') void init(request)
    else if (request.type === 'run') void run(request)
    else cancelled.add(request.id)
  }
}
