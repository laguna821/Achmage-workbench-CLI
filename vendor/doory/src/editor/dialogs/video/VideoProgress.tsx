import { useEffect, useRef, useState } from 'react'
import { formatBytes } from '../../engine/export/video/estimate'
import type { VideoProgress as Progress } from '../../engine/export/video/types'
import { t } from '../../strings'
import { describeEta } from './videoSettings'
import styles from './video.module.css'

/** A screen reader hears the progress every ten per cent, not every frame. */
const ANNOUNCE_EVERY = 10

export function VideoProgress({ progress }: { progress: Progress | null }) {
  const p = t.video
  const percent = Math.round((progress?.fraction ?? 0) * 100)
  const [announcement, setAnnouncement] = useState<string>(p.stage.starting)
  const lastStep = useRef(-1)
  useEffect(() => {
    const step = Math.floor(percent / ANNOUNCE_EVERY)
    if (step === lastStep.current) return
    lastStep.current = step
    setAnnouncement(p.announce(step * ANNOUNCE_EVERY))
  }, [percent, p])
  const stage = !progress ? p.stage.starting : progress.stage === 'frames' ? p.frameOf(progress.frame, progress.frames) : p.stage[progress.stage]
  const eta = progress?.etaMs != null && progress.stage === 'frames' ? p.left(describeEta(progress.etaMs)) : progress?.bytes ? p.gifSoFar(formatBytes(progress.bytes)) : ''
  return (
    <div className={styles.progress} data-testid="video-progress">
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={p.progressLabel} className={styles.bar}>
        <div style={{ width: `${Math.max(3, percent)}%` }} />
      </div>
      <p className={styles.progressLine}>
        <span data-testid="video-stage">{stage}</span>
        <span data-testid="video-eta">{eta}</span>
      </p>
      <p className={styles.sr} role="status" aria-live="polite">
        {announcement}
      </p>
      <p className={styles.hint}>{t.video.warnings.keepOpen}</p>
    </div>
  )
}
