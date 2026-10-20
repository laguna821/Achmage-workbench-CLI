/** What the comment UI shares: the controller as hooks, and the actions that change the pins' state in the editor store. */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { CommentT } from '@/types/api'
import { useEditor, useEditorState, useEditorStateShallow } from '../context'
import type { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { type CommentRights, type Thread, buildThreads, countThreads, filterThreads, rightsFor } from './commentOps'
import { describeCommentFailure } from './commentFailure'
import { type CommentsController, type CommentsSnapshot, commentsOf } from './commentsController'
import { patchComments } from './commentsMode'

/** The controller of this editor. An adapter swap (guest → account) comes with a mode change, which re-renders the callers. */
export function useCommentsController(): CommentsController {
  const editor = useEditor()
  useEditorState((s) => s.mode)
  return commentsOf(editor)
}

export function useCommentsSnapshot(controller: CommentsController): CommentsSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
}

/** Every thread of the design, numbered, with the page ids it is checked against. */
export function useThreads(controller: CommentsController): { threads: Thread[]; snapshot: CommentsSnapshot; pageIds: string[] } {
  const snapshot = useCommentsSnapshot(controller)
  const pageIds = useEditorStateShallow((s) => s.doc.pages.map((p) => p.id))
  const threads = useMemo(() => buildThreads(snapshot.comments, new Set(pageIds)), [snapshot.comments, pageIds])
  return { threads, snapshot, pageIds }
}

/** The threads the filter shows. The open thread always stays in the list. */
export function useVisibleThreads(controller: CommentsController): { all: Thread[]; shown: Thread[]; snapshot: CommentsSnapshot; pageIds: string[] } {
  const { threads, snapshot, pageIds } = useThreads(controller)
  const filter = useEditorState((s) => s.comments.filter)
  const active = useEditorState((s) => s.comments.activeThreadId)
  // "Mine" means nothing to somebody who is not signed in: the list falls back to everything, like the filter control does.
  const shown = useMemo(() => filterThreads(threads, filter === 'mine' && !snapshot.viewer ? 'all' : filter, snapshot.viewer ?? null, active), [threads, filter, snapshot.viewer, active])
  return { all: threads, shown, snapshot, pageIds }
}

export function useThreadCounts(controller: CommentsController): ReturnType<typeof countThreads> {
  const { threads, snapshot } = useThreads(controller)
  return useMemo(() => countThreads(threads, snapshot.viewer ?? null), [threads, snapshot.viewer])
}

/* ---------------------------------------------------------------- store actions */

/** Opens (or closes, with `null`) the card of a thread next to its pin. */
export function openThread(editor: EditorEngine, id: string | null): void {
  patchComments(editor, id ? { activeThreadId: id, draft: null } : { activeThreadId: null })
}

/** Starts a new comment at a spot of a page; a text typed before stays when the spot changes. */
export function startDraft(editor: EditorEngine, pageId: string, x: number, y: number): void {
  const body = editor.state.comments.draft?.body ?? ''
  patchComments(editor, { draft: { pageId, x, y, body }, activeThreadId: null })
}

export function setDraftBody(editor: EditorEngine, body: string): void {
  const draft = editor.state.comments.draft
  if (draft) patchComments(editor, { draft: { ...draft, body } })
}

export function cancelDraft(editor: EditorEngine): void {
  if (editor.state.comments.draft) patchComments(editor, { draft: null })
}

/** Shows a thread on the page: opens its card, scrolls its pin into view and makes it pulse. The pin does the scrolling once it exists. */
export function revealThread(editor: EditorEngine, thread: Thread, focus = false): void {
  const pageId = thread.root.page_id
  if (thread.placement !== 'pinned' || !pageId) return
  const nonce = (editor.state.comments.reveal?.nonce ?? 0) + 1
  patchComments(editor, { activeThreadId: thread.root.id, draft: null, reveal: { id: thread.root.id, nonce, focus } })
  editor.view.scrollToPage(pageId, 'auto')
}

/**
 * True when the person may write comments: signed in, or the adapter does not say. Somebody who is not signed in (a visitor
 * of a comment link) is sent through the shell's sign-up flow first, and only goes on when they came out signed in.
 */
export async function ensureCommenter(editor: EditorEngine, controller: CommentsController): Promise<boolean> {
  if (controller.getSnapshot().viewer !== null) return true
  const signedIn = await editor.adapter.requireAccount('comment', async () => ({ document: editor.getDocument(), title: editor.state.title }))
  return signedIn && (await controller.refreshViewer()) !== null
}

/* ---------------------------------------------------------------- actions with feedback */

export interface CommentActions {
  rights(comment: CommentT): CommentRights
  /** True while the server has not confirmed the comment. */
  isPending(id: string): boolean
  /** Posts a reply; rejects with the failure so the composer can show it, resolves `false` when the person declined to sign in. */
  reply(rootId: string, body: string): Promise<void | false>
  resolve(id: string, resolved: boolean): void
  remove(id: string): void
  move(id: string, to: { page_id: string; x: number; y: number }): void
}

/** The things a thread card can do. Failures that roll back (resolve, delete, move) are reported as a toast. */
export function useCommentActions(controller: CommentsController): CommentActions {
  const editor = useEditor()
  const snapshot = useCommentsSnapshot(controller)
  const { viewer, pending } = snapshot
  const offered = editor.adapter.services.comments

  const fail = useCallback(
    (error: unknown): void => {
      editor.toast(describeCommentFailure(error), 'error')
    },
    [editor],
  )

  return useMemo<CommentActions>(
    () => ({
      rights: (comment) => rightsFor(offered ?? {}, viewer, comment),
      isPending: (id) => pending.has(id),
      async reply(rootId, body) {
        if (!(await ensureCommenter(editor, controller))) return false
        await controller.create({ body, parent: rootId })
        editor.announce(t.comments.announce.added)
      },
      resolve(id, resolved) {
        controller.setResolved(id, resolved).then(
          () => editor.announce(resolved ? t.comments.announce.resolved : t.comments.announce.reopened),
          fail,
        )
      },
      remove(id) {
        controller.remove(id).then(() => editor.announce(t.comments.announce.removed), fail)
      },
      move(id, to) {
        controller.move(id, to).then(() => editor.announce(t.comments.announce.moved), () => editor.toast(t.comments.pin.moveFailed, 'error'))
      },
    }),
    [controller, editor, fail, offered, pending, viewer],
  )
}
