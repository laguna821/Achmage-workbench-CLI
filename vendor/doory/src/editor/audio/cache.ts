/**
 * Fetching with an offline copy. The audio library is a static catalogue, so what has been used once is kept in the
 * browser's Cache Storage and served from there afterwards, online or not. Only the library's own files and catalogue
 * go in (`/media/audio/…`); everything else is an ordinary request that the browser's HTTP cache handles.
 */
export const CACHE_NAME = 'doory-audio-v1'

function cacheStorage(): CacheStorage | null {
  try {
    return typeof caches === 'undefined' ? null : caches
  } catch {
    return null
  }
}

/** Whether `url` is one of the library's files (so it may be kept for offline use). */
export function isLibraryUrl(url: string): boolean {
  try {
    const parsed = new URL(url, globalThis.location?.href ?? 'http://localhost/')
    return parsed.origin === (globalThis.location?.origin ?? parsed.origin) && parsed.pathname.startsWith('/media/audio/')
  } catch {
    return false
  }
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'FetchError'
  }
}

/** The cached response for `url`, if there is one. Never throws: a blocked or full cache is a miss. */
export async function cachedResponse(url: string): Promise<Response | undefined> {
  try {
    return await cacheStorage()?.open(CACHE_NAME).then((c) => c.match(url))
  } catch {
    return undefined
  }
}

async function remember(url: string, response: Response): Promise<void> {
  try {
    const cache = await cacheStorage()?.open(CACHE_NAME)
    await cache?.put(url, response)
  } catch {
    // A full or blocked cache only costs the offline copy.
  }
}

/**
 * `fetch(url)` for an audio file. Library files are served from the offline copy when there is one and stored after
 * the first download. Throws `FetchError` for an HTTP error and rethrows network failures and aborts as they are.
 */
export async function fetchAudio(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const library = isLibraryUrl(url)
  if (library) {
    const hit = await cachedResponse(url)
    if (hit) return hit.arrayBuffer()
  }
  const response = await fetch(url, { signal, credentials: 'same-origin' })
  if (!response.ok) throw new FetchError(`HTTP ${response.status}`, response.status)
  if (library) void remember(url, response.clone())
  return response.arrayBuffer()
}

/**
 * The catalogue: the freshest copy the network has, falling back to the offline copy when the network fails (`fromCache`
 * says which one was returned). A missing catalogue (404) is reported as such, never hidden behind an old copy.
 */
export async function fetchCatalogueText(url: string, signal?: AbortSignal): Promise<{ text: string; fromCache: boolean }> {
  try {
    const response = await fetch(url, { signal, credentials: 'same-origin', cache: 'no-cache' })
    if (!response.ok) throw new FetchError(`HTTP ${response.status}`, response.status)
    void remember(url, response.clone())
    return { text: await response.text(), fromCache: false }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof FetchError && error.status === 404) throw error
    const hit = await cachedResponse(url)
    if (hit) return { text: await hit.text(), fromCache: true }
    throw error
  }
}
