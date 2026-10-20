import {
  BackgroundRemovalError,
  registerBackgroundRemover,
  type BackgroundRemover,
  type BgRemovalProgress,
} from '../bgRemoval'
import { parseModelDescriptor, sameModel, type ModelDescriptor } from './model'
import type { WorkerBackgroundRemover } from './remover'

/** The slice of `GET /api/v1/config/` this module reads; either field may be missing on an older server. */
export interface BackgroundRemovalConfig {
  features?: { background_removal?: boolean }
  assets?: { background_removal_model?: unknown }
}

interface Installed {
  model: ModelDescriptor
  remover: LazyRemover
}

let installed: Installed | null = null

/**
 * The registered remover. It costs a few hundred bytes until it is used: the first removal loads the engine
 * chunk (worker, model runtime) and later ones reuse it.
 */
class LazyRemover implements BackgroundRemover {
  private engine: Promise<WorkerBackgroundRemover> | null = null

  constructor(private readonly model: ModelDescriptor) {}

  remove(image: Blob, onProgress?: BgRemovalProgress, signal?: AbortSignal): Promise<Blob> {
    return this.load().then((engine) => engine.remove(image, onProgress, signal))
  }

  dispose(): void {
    void this.engine?.then((engine) => engine.dispose()).catch(() => undefined)
    this.engine = null
  }

  private load(): Promise<WorkerBackgroundRemover> {
    this.engine ??= import('./bundled')
      .then(({ createBundledRemover }) => createBundledRemover(this.model))
      .catch((error: unknown) => {
        this.engine = null // the next removal tries again (a flaky network may have lost the chunk)
        throw new BackgroundRemovalError(error instanceof Error ? error.message : 'The background-removal engine could not be loaded.')
      })
    return this.engine
  }
}

/**
 * Registers the bundled remover when the server says background removal is available and describes a usable
 * model, and unregisters it when it stops being so. Call it with every `/config/` response: it does nothing
 * when the model has not changed.
 */
export function configureBackgroundRemoval(config: BackgroundRemovalConfig): void {
  const model = config.features?.background_removal === true ? parseModelDescriptor(config.assets?.background_removal_model) : null
  if (!model) {
    if (installed) {
      installed.remover.dispose()
      installed = null
      registerBackgroundRemover(null)
    }
    return
  }
  if (installed && sameModel(installed.model, model)) return
  installed?.remover.dispose()
  const remover = new LazyRemover(model)
  installed = { model, remover }
  registerBackgroundRemover(remover)
}
