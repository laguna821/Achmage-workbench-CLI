import { type RefObject } from 'react'
import { usePlaybackValue } from '../animation/playback'
import { timelineSections } from '../animation/sections'
import { loadable } from '../ui/loadable'
import { useTimelineView } from './timelineVisibility'
import styles from './TimelineLoader.module.css'

const Preview = loadable(() => import('./TimelinePreview').then((m) => m.TimelinePreview), { fallback: null })

// The timeline and the preview over the page are used by the people who animate, so they download when first needed. The
// timeline comes up only when its sections' code (the audio rows) has arrived too: rows that join afterwards would push
// the lanes, the ruler and the page around under the pointer. The preview starts downloading along with it, because the
// first thing done in a timeline is to play it or to scrub it.
const Timeline = loadable(
  async () => {
    void Preview.preload()
    const [module] = await Promise.all([import('./Timeline'), Promise.allSettled(timelineSections.getSnapshot().map((section) => section.preload?.()))])
    return module.TimelineHost
  },
  { fallback: <div className={styles.placeholder} aria-hidden="true" /> },
)

/** The timeline under the workspace (see `Timeline.tsx`), fetched when it is first opened. */
export function LazyTimelineHost() {
  return useTimelineView().open ? <Timeline /> : null
}

/** Starts downloading the timeline (the button that opens it calls this when it is hovered or focused). */
LazyTimelineHost.preload = Timeline.preload

/** The preview over the page while an animation plays (see `TimelinePreview.tsx`), fetched when the first one starts. */
export function LazyTimelinePreview({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const active = usePlaybackValue((s) => s.active)
  return active ? <Preview scrollRef={scrollRef} /> : null
}
