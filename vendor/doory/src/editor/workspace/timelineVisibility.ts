/**
 * Whether the timeline under the workspace is open, and whether it is folded down to its transport bar. A per-editor
 * flag outside the store (the pages pill, the registry command and the timeline itself all reach it), remembered for
 * the viewer's next visit like the notes bar; storage that is missing or refuses to write only means it is forgotten.
 */
import { useSyncExternalStore } from 'react'
import { useEditor } from '../context'
import type { EditorEngine } from '../engine/editor'

const KEY = 'doory.editor.timeline.v1'

export interface TimelineView {
  open: boolean
  collapsed: boolean
}

interface Flag {
  view: TimelineView
  listeners: Set<() => void>
}

const flags = new WeakMap<EditorEngine, Flag>()

function stored(): TimelineView {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { open?: unknown; collapsed?: unknown } | null
    return { open: raw?.open === true, collapsed: raw?.collapsed === true }
  } catch {
    return { open: false, collapsed: false }
  }
}

function flagOf(editor: EditorEngine): Flag {
  let flag = flags.get(editor)
  if (!flag) {
    flag = { view: stored(), listeners: new Set() }
    flags.set(editor, flag)
  }
  return flag
}

export function timelineView(editor: EditorEngine): TimelineView {
  return flagOf(editor).view
}

export function setTimelineView(editor: EditorEngine, patch: Partial<TimelineView>): void {
  const flag = flagOf(editor)
  const next = { ...flag.view, ...patch }
  if (next.open === flag.view.open && next.collapsed === flag.view.collapsed) return
  flag.view = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private window or blocked storage: the choice only lasts for this session */
  }
  for (const listener of flag.listeners) listener()
}

/** Opens a closed timeline (unfolded) and closes an open one. */
export function toggleTimeline(editor: EditorEngine): void {
  const { open } = timelineView(editor)
  setTimelineView(editor, open ? { open: false } : { open: true, collapsed: false })
}

export function useTimelineView(): TimelineView {
  const editor = useEditor()
  const flag = flagOf(editor)
  return useSyncExternalStore(
    (listener) => {
      flag.listeners.add(listener)
      return () => flag.listeners.delete(listener)
    },
    () => flag.view,
  )
}
