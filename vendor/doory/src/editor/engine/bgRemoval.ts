/**
 * Background removal seam. The editor never knows which engine cuts the background out: a
 * `BackgroundRemover` is registered at start-up (the bundled one lives in `./bgRemoval/`
 * "Background removal"). The toolbar button only appears while a remover is registered, so nothing is shown
 * that cannot work.
 */
export type BgRemovalPhase = 'downloading' | 'processing'

/** The task id of background removal on the server (`POST /api/v1/ai/background-removal/`). */
export const BACKGROUND_REMOVAL_TASK = 'background-removal'
/** The option id of the in-browser model. */
export const DEVICE_OPTION = 'device'

export type BgRemovalFailure = 'unavailable' | 'blocked' | 'no-subject'

export class BackgroundRemovalError extends Error {
  constructor(
    message: string,
    /**
     * `blocked`: the page's security policy forbids what the model runtime needs (WebAssembly or code
     * generation). `no-subject`: the model found nothing to keep in the picture.
     */
    readonly reason: BgRemovalFailure = 'unavailable',
  ) {
    super(message)
    this.name = 'BackgroundRemovalError'
  }
}

export type BgRemovalProgress = (phase: BgRemovalPhase, percent: number) => void

export interface BackgroundRemover {
  /**
   * Returns a PNG with a transparent background at the size of `image`. `onProgress` reports 0..100 per
   * phase; aborting `signal` stops the work and rejects.
   */
  remove(image: Blob, onProgress?: BgRemovalProgress, signal?: AbortSignal): Promise<Blob>
}

let remover: BackgroundRemover | null = null

export function registerBackgroundRemover(next: BackgroundRemover | null): void {
  remover = next
}

export function isBackgroundRemovalAvailable(): boolean {
  return remover !== null
}

export async function removeBackground(image: Blob, onProgress?: BgRemovalProgress, signal?: AbortSignal): Promise<Blob> {
  if (!remover) throw new BackgroundRemovalError('No background-removal engine is installed.')
  try {
    return await remover.remove(image, onProgress, signal)
  } catch (err) {
    // Cancelling is the caller's own doing, not a failure of the engine: keep the abort error as it is.
    if (signal?.aborted || err instanceof BackgroundRemovalError) throw err
    if (err instanceof EvalError) throw new BackgroundRemovalError('Blocked by the content security policy.', 'blocked')
    throw new BackgroundRemovalError(err instanceof Error ? err.message : 'Background removal failed.')
  }
}
