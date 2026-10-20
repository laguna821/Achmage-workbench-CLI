import { lazy, Suspense } from 'react'
import type { VideoSectionProps } from './video/VideoSection'

/** The video settings, progress and preview are only needed when somebody picks a video format: they load on first use. */
const VideoSection = lazy(() => import('./video/VideoSection').then((m) => ({ default: m.VideoSection })))

export function LazyVideoSection(props: VideoSectionProps) {
  return (
    <Suspense fallback={null}>
      <VideoSection {...props} />
    </Suspense>
  )
}
