/**
 * Keeps a long job on the main thread from freezing the page. The work is cut into slices of a few milliseconds;
 * between slices the browser is given the thread back (input, painting, the progress bar) with a message-channel task,
 * which, unlike a timer, is not slowed to once a second in a background tab, so an export that is left running in
 * another tab keeps its pace.
 */

/**
 * Hands the thread to the browser and resumes after whatever else is already waiting for it (`scheduler.yield()` would
 * put the continuation first, and the page's own updates, the progress bar among them, would starve).
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

export class Slicer {
  private started = performance.now()

  /** @param budgetMs how long work may run before the thread is given back. */
  constructor(private readonly budgetMs = 10) {}

  /** Call between units of work: yields when the slice is used up. Returns true when it yielded. */
  async tick(): Promise<boolean> {
    if (performance.now() - this.started < this.budgetMs) return false
    await yieldToBrowser()
    this.started = performance.now()
    return true
  }
}

/** Resolves once the encoder's queue has shrunk to `max` (or the encoder is closed); bounded so a missed event cannot hang. */
export async function waitForQueue(encoder: { readonly encodeQueueSize: number; readonly state: string; addEventListener(type: 'dequeue', listener: () => void, options?: { once: boolean }): void }, max: number): Promise<void> {
  while (encoder.encodeQueueSize > max && encoder.state === 'configured') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50)
      encoder.addEventListener(
        'dequeue',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}
