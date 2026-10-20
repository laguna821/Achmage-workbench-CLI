import { useMemo } from 'react'
import { useEditorState } from '../context'
import type { EditorEngine } from '../engine/editor'
import { clockOf } from './clock'
import { readTracks } from './model'
import { type TimelineItem, timelineItems } from './timelineModel'

/** The audio that sounds on page `pageId`, from the document, as the timeline draws it. */
export function useTimelineItems(pageId: string): TimelineItem[] {
  const pages = useEditorState((s) => s.doc.pages)
  const stored = useEditorState((s) => s.doc.audioTracks)
  return useMemo(() => timelineItems(readTracks({ audioTracks: stored }), clockOf({ pages }), pageId), [pages, stored, pageId])
}

/** The same, read once from the editor (for the section's registration, which has no component to hold a hook). */
export function timelineItemsOf(editor: EditorEngine, pageId: string): TimelineItem[] {
  const doc = editor.getDocument()
  return timelineItems(readTracks(doc), clockOf(doc), pageId)
}
