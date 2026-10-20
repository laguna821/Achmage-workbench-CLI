import { assetsApi, commentsApi, isApiError, shareApi } from '@/lib/api'
import type { AccountReason, EditorAdapter } from '@/types/adapter'
import type { FontFamily, ShareRole } from '@/types/api'
import { ReadOnlyDesignError, RevisionConflictError } from './errors'
import { createRealtimeConnection } from './realtime'
import { assetToRef, createAccountAssetsService, createPublicServices, createViewerLookup } from './services'

export interface SharedAdapterOptions {
  token: string
  role: ShareRole
  password?: string
  getRevision(): number
  onRevision?(revision: number): void
  /** Opens the sign-in modal (commenting and editing need an account). */
  ensureSignedIn(reason: AccountReason): Promise<boolean>
  /** Uploaded font families that came with the shared design (`fonts` of `GET /shared/{token}/`). */
  fonts?: readonly FontFamily[]
  /**
   * Joins the design's live room: the design id (`design_id` of `GET /shared/{token}/`) and the shell's sign-in flow. Only for
   * visitors who are signed in; everybody in a room is, so anonymous visitors keep the static view.
   */
  live?: { designId: string; requireSignIn(): Promise<boolean>; refreshSession?(): Promise<boolean> }
}

/** Adapter for `/s/:token`. View and comment links never write; edit links patch through the share token. */
export function createSharedAdapter(options: SharedAdapterOptions): EditorAdapter {
  const canEdit = options.role === 'edit'
  const publicServices = createPublicServices()
  const realtime = options.live
    ? createRealtimeConnection({
        designId: options.live.designId,
        auth: { token: options.token, password: options.password },
        setTitle: null,
        requireSignIn: options.live.requireSignIn,
        refreshSession: options.live.refreshSession,
        onRevision: options.onRevision,
      })
    : null
  return {
    realtime,
    async save({ document }) {
      if (!canEdit) throw new ReadOnlyDesignError()
      try {
        const result = await shareApi.saveShared(options.token, { document, base_revision: options.getRevision() }, options.password)
        options.onRevision?.(result.revision)
        return { savedAt: Date.now(), revision: result.revision }
      } catch (error) {
        if (isApiError(error) && error.status === 409 && error.code === 'revision_conflict') {
          const current = (error.data as { current?: { revision?: unknown } } | undefined)?.current?.revision
          throw new RevisionConflictError(typeof current === 'number' ? current : null)
        }
        throw error
      }
    },
    requireAccount: (reason) => options.ensureSignedIn(reason),
    async uploadAsset(file, opts) {
      if (!canEdit) throw new ReadOnlyDesignError()
      return assetToRef(await assetsApi.upload(file, { name: opts?.name }))
    },
    resolveSrc: async (src) => src,
    services: {
      ...publicServices,
      fonts: { ...publicServices.fonts, provided: options.fonts ?? [] },
      assets: canEdit
        ? createAccountAssetsService()
        : {
            list: async () => ({ count: 0, next: null, previous: null, results: [] }),
            remove: async () => {
              throw new ReadOnlyDesignError()
            },
          },
      brand: null,
      stock: null,
      versions: null,
      // Visitors of a comment (or edit) link can read and post comments; posting needs an account.
      comments:
        options.role === 'view'
          ? null
          : {
              list: () => commentsApi.listShared(options.token, options.password),
              create: async (input) => {
                if (!(await options.ensureSignedIn('comment'))) throw new Error('Sign in to comment.')
                return commentsApi.createShared(options.token, input, options.password)
              },
              remove: (id) => commentsApi.removeShared(options.token, id, options.password),
              move: (id, to) => commentsApi.moveShared(options.token, id, to, options.password),
              viewer: createViewerLookup(false),
            },
    },
  }
}
