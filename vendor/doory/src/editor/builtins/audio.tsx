import { pageHoldEndMs } from '../animation/timelineMath'
import { registerTimelineSection } from '../animation/sections'
import { timelineItemsOf } from '../audio/useTimelineItems'
import { loadable } from '../ui/loadable'

// The rows are drawn by the timeline, which is itself loaded on first use; their code comes with it (and not before).
const AudioSection = loadable(() => import('../workspace/TimelineAudio').then((m) => m.AudioSection), { fallback: null })
const AudioList = loadable(() => import('../workspace/TimelineAudio').then((m) => m.AudioList), { fallback: null })

/** The audio rows of the timeline (see `workspace/TimelineAudio.tsx`); they come after the rows of the animated elements. */
export function registerBuiltinAudio(): void {
  registerTimelineSection({
    id: 'audio',
    order: 100,
    Section: AudioSection,
    List: AudioList,
    preload: () => Promise.all([AudioSection.preload(), AudioList.preload()]),
    // Sound plays to the end of its page, so the axis reaches the page's end whenever the page has any.
    extentMs: (page, editor) => (timelineItemsOf(editor, page.id).length > 0 ? pageHoldEndMs(page) : 0),
    hasContent: (page, editor) => timelineItemsOf(editor, page.id).length > 0,
  })
}

registerBuiltinAudio()
