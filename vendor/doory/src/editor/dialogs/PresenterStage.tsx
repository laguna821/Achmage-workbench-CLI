import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DocPage, DoryDocument } from '@/types/document'
import { getPageSize } from '../engine/pageSizes'
import { type Size, frameGeometry } from '../presenter/fit'
import { useElementSize } from '../presenter/useElementSize'
import type { FrameCache } from '../presenter/frames'
import { t } from '../strings'
import styles from './Presenter.module.css'

/** How long the stage may hold still before the pages are rendered again for its new size (window drag, notes opening). */
const RESIZE_SETTLE_MS = 150
const NO_SIZE: Size = { width: 0, height: 0 }

interface Frame {
  page: DocPage
  canvas: HTMLCanvasElement
}

interface PresenterStageProps {
  doc: DoryDocument
  index: number
  cache: FrameCache
  /** Handlers for the pointer: tap, click and swipe are interpreted by the slideshow. */
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  children?: React.ReactNode
}

/**
 * The page on the black stage, letterboxed by its own size: the largest rectangle of the page's shape that fits, never
 * cut and never stretched, rendered at the stage size times the device pixel ratio. While the next page is still being
 * rendered the stage shows a quiet placeholder of the right shape, not the page before it.
 */
export function PresenterStage({ doc, index, cache, onPointerDown, onPointerUp, children }: PresenterStageProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [settled, setSettled] = useState<Size>(NO_SIZE)
  const [frame, setFrame] = useState<Frame | null>(null)
  const [failed, setFailed] = useState<DocPage | null>(null)
  const [attempt, setAttempt] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const page = doc.pages[index]

  // The first size renders at once; later ones wait until the stage stops changing.
  if (settled.width === 0 && size.width > 0) setSettled(size)
  useEffect(() => {
    if (size.width === 0) return
    const timer = window.setTimeout(() => setSettled(size), RESIZE_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [size])

  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const shown = frameGeometry(size, getPageSize(doc, page.id), dpr)
  const pixelWidth = frameGeometry(settled, getPageSize(doc, page.id), dpr).pixels.width

  useEffect(() => {
    cache.clear()
  }, [cache, settled.width, settled.height, dpr])

  useEffect(() => {
    if (pixelWidth === 0) return
    let alive = true
    cache
      .get(page, pixelWidth)
      .then((canvas) => {
        if (!alive) return
        setFailed(null)
        setFrame({ page, canvas })
      })
      .catch(() => {
        if (alive) setFailed(page)
      })
    // The pages on either side are rendered while this one is on screen, so the next click shows them at once.
    for (const neighbour of [doc.pages[index + 1], doc.pages[index - 1]]) {
      if (neighbour) cache.prefetch(neighbour, frameGeometry(settled, getPageSize(doc, neighbour.id), dpr).pixels.width)
    }
    return () => {
      alive = false
    }
  }, [cache, doc, index, page, pixelWidth, settled, dpr, attempt])

  const ready = frame !== null && frame.page === page
  useLayoutEffect(() => {
    const target = canvasRef.current
    if (!target || !frame || frame.page !== page) return
    target.width = frame.canvas.width
    target.height = frame.canvas.height
    target.getContext('2d')?.drawImage(frame.canvas, 0, 0)
  }, [frame, page])

  const name = (page.name ?? '').trim()
  const label = t.presenter.stage(index + 1, doc.pages.length, name)
  const missing = !ready && failed === page
  return (
    <div ref={ref} className={styles.stage} data-testid="present-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <div className={styles.frameBox} style={{ left: shown.css.x, top: shown.css.y, width: shown.css.width, height: shown.css.height }} data-testid="present-frame-box">
        <canvas ref={canvasRef} className={styles.frame} data-ready={ready} role="img" aria-label={label} data-testid="present-frame" data-page-id={page.id} />
        {!ready && !missing ? <div className={styles.preparing} role="status" aria-label={t.presenter.preparing} data-testid="present-preparing" /> : null}
        {missing ? (
          <div className={styles.failed} role="alert">
            <p>{t.presenter.renderFailed}</p>
            <button type="button" className={styles.textButton} onClick={() => setAttempt((n) => n + 1)}>
              {t.presenter.retry}
            </button>
          </div>
        ) : null}
      </div>
      {children}
    </div>
  )
}
