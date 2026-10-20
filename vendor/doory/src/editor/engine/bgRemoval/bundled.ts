import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import type { ModelDescriptor } from './model'
import { WorkerBackgroundRemover } from './remover'

/**
 * The remover the app ships: the cut-out worker (built as its own chunk with the model runtime) and the
 * WebAssembly file (an asset of the build, served from the app's own origin like every other file).
 */
export function createBundledRemover(model: ModelDescriptor): WorkerBackgroundRemover {
  return new WorkerBackgroundRemover(model, {
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'doory-cutout' }),
    wasmUrl,
  })
}
