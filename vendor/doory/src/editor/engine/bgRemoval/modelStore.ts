import { BackgroundRemovalError, type BgRemovalProgress } from '../bgRemoval'
import type { ModelDescriptor } from './model'

/** Cache Storage bucket of the downloaded models; the key is the (hash-named) model URL. */
export const MODEL_CACHE = 'doory-models-v1'

export interface ModelStoreDeps {
  fetchImpl?: typeof fetch
  /** Where downloads are kept; `null` for none (every use downloads). Defaults to the page's Cache Storage. */
  caches?: CacheStorage | null
  /** Hashes the bytes; `null` skips verification (only the size is checked). Defaults to `crypto.subtle`. */
  digest?: ((data: ArrayBuffer) => Promise<string>) | null
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** `crypto.subtle` and Cache Storage exist only in secure contexts (https, localhost). */
function pageDefaults(): Required<ModelStoreDeps> {
  return {
    fetchImpl: (...args) => fetch(...args),
    caches: typeof caches === 'undefined' ? null : caches,
    digest: typeof crypto !== 'undefined' && crypto.subtle ? sha256Hex : null,
  }
}

function aborted(signal?: AbortSignal): never {
  throw signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
}

/** Reads a response body into one buffer of exactly `bytes`, reporting progress. Throws on any other length. */
async function readBody(response: Response, bytes: number, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const buffer = new Uint8Array(bytes)
  if (!response.body) throw new BackgroundRemovalError('The model download has no content.')
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      if (signal?.aborted) aborted(signal)
      const { done, value } = await reader.read()
      if (done) break
      if (received + value.length > bytes) throw new BackgroundRemovalError('The model file is larger than expected.')
      buffer.set(value, received)
      received += value.length
      onProgress(Math.floor((received / bytes) * 100))
    }
  } finally {
    reader.releaseLock()
  }
  if (received !== bytes) throw new BackgroundRemovalError('The model file is incomplete.')
  return buffer.buffer
}

async function verified(data: ArrayBuffer, model: ModelDescriptor, digest: Required<ModelStoreDeps>['digest']): Promise<boolean> {
  if (data.byteLength !== model.bytes) return false
  return !digest || (await digest(data)) === model.sha256
}

/**
 * The model file, from Cache Storage when a verified copy is there, otherwise downloaded from the same origin
 * (with progress), verified against the size and SHA-256 the server announced, and cached for next time.
 * Anything that does not match is thrown away: a damaged or substituted file never reaches the runtime.
 */
export async function loadModel(
  model: ModelDescriptor,
  onProgress?: BgRemovalProgress,
  signal?: AbortSignal,
  deps: ModelStoreDeps = {},
): Promise<ArrayBuffer> {
  const defaults = pageDefaults()
  const fetchImpl = deps.fetchImpl ?? defaults.fetchImpl
  const storage = deps.caches === undefined ? defaults.caches : deps.caches
  const digest = deps.digest === undefined ? defaults.digest : deps.digest
  const report = (percent: number): void => onProgress?.('downloading', percent)
  report(0)

  const cache = storage ? await storage.open(MODEL_CACHE).catch(() => undefined) : undefined
  if (cache) {
    try {
      const hit = await cache.match(model.url)
      if (hit) {
        const data = await hit.arrayBuffer()
        if (await verified(data, model, digest)) {
          report(100)
          return data
        }
      }
    } catch {
      // an unreadable cache entry is the same as a missing one
    }
    await cache.delete(model.url).catch(() => false)
  }
  if (signal?.aborted) aborted(signal)

  let response: Response
  try {
    response = await fetchImpl(model.url, { signal, credentials: 'same-origin', cache: 'no-store' })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new BackgroundRemovalError('The background-removal model could not be downloaded.')
  }
  if (!response.ok) {
    throw new BackgroundRemovalError(
      response.status === 404 ? 'The background-removal model is not installed on this server.' : `The model download failed (HTTP ${response.status}).`,
    )
  }
  let data: ArrayBuffer
  try {
    data = await readBody(response, model.bytes, report, signal)
  } catch (error) {
    if (signal?.aborted || error instanceof BackgroundRemovalError) throw error
    throw new BackgroundRemovalError('The background-removal model could not be downloaded.')
  }
  if (!(await verified(data, model, digest))) {
    throw new BackgroundRemovalError('The downloaded model does not match the file the server announced.')
  }
  report(100)
  if (cache) {
    // The cache is an optimisation: a full disk or a blocked cache must not fail the removal.
    await cache
      .put(model.url, new Response(data, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength) } }))
      .catch(() => undefined)
  }
  return data
}
