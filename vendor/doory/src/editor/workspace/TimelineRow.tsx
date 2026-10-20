/**
 * One row of the timeline for a section (`animation/sections.ts`): a label that stays in view while the axis scrolls and
 * a track as wide as the axis. What goes on the track is positioned by the section itself (`left = ms * pxPerMs`).
 */
import type { ReactNode } from 'react'
import styles from './Timeline.module.css'

interface RowProps {
  label: ReactNode
  /** Icon in front of the label. */
  icon?: ReactNode
  /** Width of the track, px (`TimelineSectionProps.contentWidth`). */
  contentWidth: number
  testId?: string
  selected?: boolean
  /** The accessible name of the row. */
  name: string
  /** A class for the row, so that its owner can style it (hover states of its own controls). */
  className?: string
  children?: ReactNode
}

export function TimelineRow({ label, icon, contentWidth, testId, selected, name, className, children }: RowProps) {
  return (
    <div className={className ? `${styles.row} ${className}` : styles.row} data-selected={selected || undefined} role="group" aria-label={name} data-testid={testId}>
      <div className={styles.laneLabel} data-static>
        {icon}
        <span className={styles.laneName}>{label}</span>
      </div>
      <div className={styles.track} style={{ width: contentWidth }}>
        {children}
      </div>
    </div>
  )
}
