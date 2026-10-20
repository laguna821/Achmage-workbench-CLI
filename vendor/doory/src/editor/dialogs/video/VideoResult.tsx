import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatBytes, formatLength } from '../../engine/export/video/estimate'
import type { VideoResult as Result } from '../../engine/export/video/types'
import { t } from '../../strings'
import styles from './video.module.css'

interface VideoResultProps {
  result: Result
  /** Object URL of the file, for the preview. */
  url: string
}

/** The finished file: what it is, a player (or the picture, for a GIF) to look at it before downloading, and what to know about it. */
export function VideoResult({ result, url }: VideoResultProps) {
  const p = t.video
  const gif = result.format === 'gif'
  const [unplayable, setUnplayable] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // On a narrow screen the settings above the result fill the dialog: bring the result into view.
  useEffect(() => root.current?.scrollIntoView?.({ block: 'nearest' }), [])
  return (
    <div ref={root} className={styles.result} data-testid="video-result" data-format={result.format} data-width={result.width} data-height={result.height} data-duration={result.durationMs} data-frames={result.frames}>
      <div className={styles.resultHead}>
        <span className={styles.tick} aria-hidden="true">
          <Check size={14} />
        </span>
        <h3>{gif ? p.readyGif : p.readyVideo}</h3>
      </div>
      <p className={styles.facts} data-testid="video-facts">
        {p.facts(result.width, result.height, formatLength(result.durationMs), formatBytes(result.blob.size))} · {p.madeWith(result.video, result.audio)}
      </p>
      <div className={styles.stage}>
        {unplayable ? (
          <p className={styles.hint} role="status" data-testid="video-preview-failed">
            {p.previewFailed}
          </p>
        ) : gif ? (
          <img className={styles.player} src={url} alt={p.previewGif} data-testid="video-preview" />
        ) : (
          <video className={styles.player} src={url} controls preload="auto" aria-label={p.previewVideo} data-testid="video-preview" onError={() => setUnplayable(true)} />
        )}
      </div>
      {result.warnings.length > 0 ? (
        <ul className={styles.notes} data-testid="video-result-notes">
          {result.warnings.map((w) => (
            <li key={w} className={styles.warning}>
              {p.warned[w]}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
