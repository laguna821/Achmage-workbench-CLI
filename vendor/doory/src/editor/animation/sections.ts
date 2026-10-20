/**
 * Extra rows for the timeline. The timeline shows the animations of the active page; a feature that has its own things
 * on the page clock (an audio track, subtitles) registers a section and gets rows under the animated elements, on the
 * same time axis, with the same playhead, zoom and scroll. A section is a component: it reads what it shows from the
 * editor itself and lays its rows out with `TimelineRow` (`workspace/TimelineRow.tsx`) at the scale it is given.
 */
import type { ComponentType } from 'react'
import type { DocPage } from '@/types/document'
import type { EditorEngine } from '../engine/editor'
import { Registry, type Registered } from '../engine/registry'

/** What a section is told about the axis it is drawn on. */
export interface TimelineSectionProps {
  pageId: string
  /** Pixels per millisecond of the page clock (`x = ms * pxPerMs`, from the start of the track). */
  pxPerMs: number
  /** Width of a track in px: the time axis plus the room behind its end. */
  contentWidth: number
  /** The length the axis shows, ms. */
  lengthMs: number
  readOnly: boolean
}

export interface TimelineSection extends Registered {
  /** Sections are listed in this order, after the animated elements. */
  order: number
  /** The rows of the section on the axis (`TimelineRow`s). */
  Section: ComponentType<TimelineSectionProps>
  /** The compact list of a narrow screen; without it the section is not shown there. */
  List?: ComponentType<{ pageId: string; readOnly: boolean }>
  /**
   * How far on the page clock the section's content reaches, ms: the axis is at least this long. The editor is given
   * for content that lives beside the pages (the document's audio tracks); it is re-asked whenever the document changes.
   */
  extentMs?(page: DocPage, editor: EditorEngine): number
  /** Whether the section has anything to show on the page; the timeline is not "empty" while one has. */
  hasContent?(page: DocPage, editor: EditorEngine): boolean
  /**
   * Downloads the code of a section that lives in a chunk of its own. The timeline waits for it (a failed download counts
   * as done) before it comes up, so that rows never appear after the timeline did and push everything else around.
   */
  preload?(): Promise<unknown>
}

export const timelineSections = new Registry<TimelineSection>((a, b) => a.order - b.order)

/** Adds a section to the timeline. Returns the function that takes it away again. */
export function registerTimelineSection(section: TimelineSection): () => void {
  return timelineSections.register(section)
}
