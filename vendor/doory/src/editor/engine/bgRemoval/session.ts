import * as ort from 'onnxruntime-web/wasm'
import { BackgroundRemovalError } from '../bgRemoval'
import type { ModelDescriptor } from './model'

/** An ONNX model loaded into the WebAssembly runtime. */
export interface Segmenter {
  /** Runs the model on a planar `1 x 3 x size x size` tensor and returns the first output's values. */
  run(input: Float32Array): Promise<Float32Array>
}

/** Whether an error means "the page's policy forbids WebAssembly or code generation". */
export function isPolicyBlock(error: unknown): boolean {
  if (error instanceof EvalError) return true
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /unsafe-eval|wasm-unsafe-eval|content security policy|CSP/i.test(text)
}

/**
 * Starts the runtime and loads the model. Threads are used only when the page is cross-origin isolated
 * (`SharedArrayBuffer` needs it); otherwise the single-threaded SIMD build runs, which needs no headers.
 */
export async function createSegmenter(
  model: ArrayBuffer,
  descriptor: ModelDescriptor,
  wasmUrl: string,
  threads: number,
): Promise<Segmenter> {
  ort.env.wasm.wasmPaths = { wasm: wasmUrl }
  ort.env.wasm.numThreads = threads
  ort.env.wasm.proxy = false
  let session: ort.InferenceSession
  try {
    session = await ort.InferenceSession.create(new Uint8Array(model), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  } catch (error) {
    if (isPolicyBlock(error) || error instanceof WebAssembly.CompileError) {
      throw new BackgroundRemovalError('The page blocks WebAssembly.', 'blocked')
    }
    throw new BackgroundRemovalError(`The model could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
  }
  const { size } = descriptor.input
  return {
    async run(input) {
      const feeds = { [descriptor.input.name]: new ort.Tensor('float32', input, [1, 3, size, size]) }
      const results = await session.run(feeds, [descriptor.output])
      const tensor = results[descriptor.output]
      if (!tensor || !(tensor.data instanceof Float32Array)) {
        throw new BackgroundRemovalError('The model returned an unexpected result.')
      }
      return tensor.data
    },
  }
}
