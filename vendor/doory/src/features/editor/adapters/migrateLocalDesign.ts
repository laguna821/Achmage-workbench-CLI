import { ApiError, assetsApi, designsApi, isApiError } from '@/lib/api'
import { collectLocalAssetIds, rewriteLocalAssetSrcs } from '@/lib/document'
import { localRepository, type LocalAsset, type LocalRepository } from '@/lib/local'
import type { SaveInput } from '@/types/adapter'
import type { DesignSummary } from '@/types/api'
import type { DocObject, DocPage, DoryDocument } from '@/types/document'
import { MigrationError, type MigrationPhase } from './errors'

export interface MigrationProgress {
  phase: MigrationPhase
  done: number
  total: number
}

export interface MigrateOptions {
  onProgress?: (progress: MigrationProgress) => void
  /** Non-fatal problems (e.g. an image whose local copy was already gone). */
  onWarning?: (message: string) => void
  signal?: AbortSignal
  /** Parallel uploads. Default 3. */
  concurrency?: number
  /** Extra attempts for transient failures (network, 5xx, 429). Default 2. */
  retries?: number
  /** Base back-off in ms (doubles each attempt). Default 400. */
  retryDelayMs?: number
  repository?: LocalRepository
}

interface Uploaded {
  localId: string
  serverId: string
  url: string
}

const inflight = new Map<string, Promise<string>>()

/**
 * A guest design whose last attempt ended while it was unknown whether the server had created the design (the connection dropped
 * or the server failed after reading the request) and the account could not be asked either. The server has no idempotency key,
 * so the next attempt first looks for the design among those created since: that is how a lost response does not become a second
 * copy, and why the uploads of such an attempt are kept instead of rolled back.
 */
interface Unknown {
  /** Ids of the newest designs before the attempt started. */
  before: ReadonlySet<string>
  uploads: readonly Uploaded[]
}
const unresolved = new Map<string, Unknown>()

/** The request may have been processed although no answer came: a dropped connection or a server-side failure. */
function outcomeUnknown(error: unknown): boolean {
  return isApiError(error) && (error.isNetwork || error.status >= 500)
}

async function newestDesignIds(): Promise<Set<string> | null> {
  try {
    return new Set((await designsApi.list({ ordering: '-created_at', page_size: 10 })).results.map((design) => design.id))
  } catch {
    return null
  }
}

/**
 * A design that appeared since `before` and looks like the one being saved (same title, size and page count); null when there is
 * none, and `'unknown'` when the account could not be asked (then another request to create it would risk a second copy).
 */
async function findCreated(before: ReadonlySet<string>, title: string, document: DoryDocument): Promise<DesignSummary | null | 'unknown'> {
  try {
    const { results } = await designsApi.list({ ordering: '-created_at', page_size: 10 })
    return results.find((design) => !before.has(design.id) && design.title === title && design.width === document.width && design.height === document.height && design.page_count === document.pages.length) ?? null
  } catch {
    return 'unknown'
  }
}

/** The create request ended without an answer and the account could not be asked whether it went through: do not send it again. */
class CreateUnverified extends Error {
  constructor(readonly original: unknown) {
    super('It is not known whether the design was created.')
    this.name = 'CreateUnverified'
  }
}

/** Friendlier wording for the server's well-known refusal codes; otherwise the server's own message. */
function reasonFor(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback
  switch (error.code) {
    case 'quota_exceeded':
      return 'Your account storage is full. Delete some uploads, then try again.'
    case 'document_too_large':
      return 'This design is larger than the size limit for saved designs.'
    case 'limit_reached':
      return 'Your account has reached its limit for this.'
    default:
      return error.message
  }
}

function isTransient(error: unknown): boolean {
  return isApiError(error) && (error.isNetwork || error.status >= 500 || error.status === 429)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

async function withRetry<T>(task: () => Promise<T>, retries: number, delayMs: number, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= retries || !isTransient(error) || signal?.aborted) throw error
      await wait(delayMs * 2 ** attempt, signal)
    }
  }
}

/** Runs `worker` over `items` with bounded concurrency; stops scheduling after the first failure. */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>, stop: AbortController): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null
  const lane = async (): Promise<void> => {
    while (!failure && !stop.signal.aborted) {
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        await worker(items[index])
      } catch (error) {
        failure ??= { error }
        stop.abort()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  if (failure) throw (failure as { error: unknown }).error
}

const LOCAL_SRC = /^idb:\/\/([0-9a-f-]{36})$/i
const localIdOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const match = LOCAL_SRC.exec(value)
  return match ? match[1].toLowerCase() : null
}

function pruneObjects(objects: DocObject[], missing: ReadonlySet<string>): DocObject[] {
  return objects.flatMap((object) => {
    const id = localIdOf(object.src)
    if (id && missing.has(id)) return []
    if (Array.isArray(object.objects)) return [{ ...object, objects: pruneObjects(object.objects as DocObject[], missing) }]
    return [object]
  })
}

/** Drops references to images and sounds whose local blob no longer exists, so the rest of the design can still be saved. */
export function removeMissingAssetReferences(doc: DoryDocument, missing: ReadonlySet<string>): DoryDocument {
  const pages: DocPage[] = doc.pages.map((page) => {
    const background = page.background.type === 'image' && missing.has(localIdOf(page.background.src) ?? '') ? ({ type: 'solid', color: '#ffffff' } as const) : page.background
    return { ...page, background, objects: pruneObjects(page.objects, missing) }
  })
  const audio = doc.audioTracks?.filter((track) => !missing.has(localIdOf(track.src) ?? ''))
  const { audioTracks: _all, ...rest } = doc
  return { ...rest, pages, ...(audio && audio.length > 0 ? { audioTracks: audio } : {}) }
}

/**
 * Moves a guest design into the signed-in user's account.
 * Order: upload every referenced image → rewrite `idb://` sources → create the design → thumbnail →
 * only then remove the local copy. Any failure leaves the local design untouched (and rolls back uploads).
 * Resolves with the new server design id.
 */
export function migrateLocalDesign(localId: string, snapshot: SaveInput, options: MigrateOptions = {}): Promise<string> {
  const existing = inflight.get(localId)
  if (existing) return existing
  const run = performMigration(localId, snapshot, options).finally(() => {
    inflight.delete(localId)
  })
  inflight.set(localId, run)
  return run
}

async function performMigration(localId: string, snapshot: SaveInput, options: MigrateOptions): Promise<string> {
  const repo = options.repository ?? localRepository
  const { onProgress, onWarning, signal } = options
  const concurrency = Math.max(1, options.concurrency ?? 3)
  const retries = options.retries ?? 2
  const delay = options.retryDelayMs ?? 400
  const uploaded: Uploaded[] = []
  let designCreated = false
  let before: ReadonlySet<string> | null = null
  const stop = new AbortController()
  signal?.addEventListener('abort', () => stop.abort(), { once: true })

  try {
    onProgress?.({ phase: 'prepare', done: 0, total: 1 })
    // Keep the freshest copy locally first: if anything below fails the guest loses nothing.
    await repo.saveDesign({ id: localId, title: snapshot.title, document: snapshot.document, thumbnail: snapshot.thumbnail }).catch(() => undefined)

    let document = snapshot.document
    const ids = collectLocalAssetIds(document)

    // After an attempt that ended without an answer from the server, check first whether it did create the design.
    const earlier = unresolved.get(localId)
    if (earlier) {
      const created = await findCreated(earlier.before, snapshot.title, document)
      if (created === 'unknown') throw new MigrationError('We couldn’t check whether your design was already saved. Check your connection and try again.', 'prepare')
      if (created) return await finish(created.id, localId, ids, snapshot, repo, onProgress)
      await rollbackUploads(earlier.uploads)
      unresolved.delete(localId)
    }
    const found = new Map<string, LocalAsset>()
    const missing = new Set<string>()
    for (const id of ids) {
      const asset = await repo.getAsset(id)
      if (asset) found.set(id, asset)
      else missing.add(id)
    }
    if (missing.size > 0) {
      document = removeMissingAssetReferences(document, missing)
      if (collectLocalAssetIds(document).some((id) => missing.has(id))) {
        throw new MigrationError('An image used by this design is no longer stored in this browser, so it cannot be saved yet.', 'prepare')
      }
      onWarning?.(`${missing.size} image${missing.size === 1 ? ' was' : 's were'} no longer available in this browser and ${missing.size === 1 ? 'was' : 'were'} left out.`)
    }

    const queue = [...found.values()]
    let done = 0
    onProgress?.({ phase: 'assets', done, total: queue.length })
    await runPool(
      queue,
      concurrency,
      async (asset) => {
        try {
          const created = await withRetry(
            () => assetsApi.upload(new File([asset.blob], asset.name, { type: asset.mime }), { name: asset.name, signal: stop.signal }),
            retries,
            delay,
            stop.signal,
          )
          uploaded.push({ localId: asset.id, serverId: created.id, url: created.url })
          done += 1
          onProgress?.({ phase: 'assets', done, total: queue.length })
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error
          const reason = reasonFor(error, 'The upload failed.')
          throw new MigrationError(`“${asset.name}” couldn’t be uploaded. ${reason}`, 'assets', { cause: error, assetName: asset.name })
        }
      },
      stop,
    )
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const rewritten = rewriteLocalAssetSrcs(document, new Map(uploaded.map((item) => [item.localId, { url: item.url, assetId: item.serverId }])))
    onProgress?.({ phase: 'design', done: 0, total: 1 })
    before = await newestDesignIds()
    const known = before
    let design: { id: string }
    try {
      design = await withRetry(
        async () => {
          try {
            return await designsApi.create({
              title: snapshot.title,
              width: rewritten.width,
              height: rewritten.height,
              preset: rewritten.meta?.presetId,
              document: rewritten,
            })
          } catch (error) {
            // A lost answer must not turn the retry into a second copy.
            if (!outcomeUnknown(error) || !known) throw error
            const found = await findCreated(known, snapshot.title, rewritten)
            if (found === 'unknown') throw new CreateUnverified(error)
            if (found) return found
            throw error
          }
        },
        retries,
        delay,
        signal,
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const cause = error instanceof CreateUnverified ? error.original : error
      if (known && error instanceof CreateUnverified) unresolved.set(localId, { before: known, uploads: [...uploaded] })
      const reason = reasonFor(cause, 'The design could not be created.')
      throw new MigrationError(`Your design couldn’t be saved to your account. ${reason}`, 'design', { cause })
    }

    designCreated = true
    return await finish(design.id, localId, ids, snapshot, repo, onProgress)
  } catch (error) {
    // With the outcome of the create request unknown the uploads may already belong to a stored design: keep them.
    if (!designCreated && !unresolved.has(localId)) await rollbackUploads(uploaded)
    throw error
  }
}

/** The design exists in the account: store its thumbnail, and only then remove the local copy and its images. */
async function finish(designId: string, localId: string, ids: readonly string[], snapshot: SaveInput, repo: LocalRepository, onProgress?: (progress: MigrationProgress) => void): Promise<string> {
  onProgress?.({ phase: 'finish', done: 0, total: 1 })
  const thumbnail = snapshot.thumbnail ?? (await repo.getDesign(localId).catch(() => null))?.thumbnail
  if (thumbnail) await designsApi.uploadThumbnail(designId, thumbnail).catch(() => undefined)
  await repo.deleteDesign(localId).catch(() => undefined)
  await repo.deleteAssetsIfUnused([...ids]).catch(() => undefined)
  unresolved.delete(localId)
  onProgress?.({ phase: 'finish', done: 1, total: 1 })
  return designId
}

async function rollbackUploads(uploaded: readonly Uploaded[]): Promise<void> {
  await Promise.allSettled(uploaded.map((item) => assetsApi.remove(item.serverId)))
}
