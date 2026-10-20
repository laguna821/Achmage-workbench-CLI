import { useEffect, useState } from 'react'
import { useDocument, useEditor } from '../context'
import { getPageSize, fitBox } from '../engine/pageSizes'
import { type ResizeMode, resizePageContent } from '../engine/magicResize'
import { renderPageToCanvas } from '../engine/render'
import { t } from '../strings'
import { usePageSnapshot } from '../workspace/useSnapshot'
import styles from './ResizeDialog.module.css'

/** Longest side of a preview, in CSS px. */
const BOX = { width: 136, height: 112 }
/** Typing in the size fields re-renders the preview only once they rest. */
const DEBOUNCE_MS = 200
/** The page is drawn at its full size before it is scaled down, so a preview of a huge page is skipped (the frame stays). */
const MAX_PREVIEW_PIXELS = 25_000_000

interface ResizePreviewProps {
  pageId: string
  /** The size the fields describe (whole px); a preview is drawn only while it is a usable size. */
  to: { width: number; height: number }
  mode: ResizeMode
}

/**
 * The page as it is next to the page as the chosen mode would leave it. The second picture is drawn from the
 * document with the same content mapping Resize uses (`resizePageContent`), so what it shows is what happens.
 */
export function ResizePreview({ pageId, to, mode }: ResizePreviewProps) {
  const editor = useEditor()
  const doc = useDocument()
  const page = doc.pages.find((p) => p.id === pageId)
  const from = getPageSize(doc, pageId)
  const before = usePageSnapshot(page ?? doc.pages[0], from)
  const [after, setAfter] = useState<string | null>(null)
  const usable = Number.isFinite(to.width) && Number.isFinite(to.height) && to.width >= 1 && to.height >= 1
  const drawable = usable && to.width * to.height <= MAX_PREVIEW_PIXELS
  const { width: toW, height: toH } = to

  useEffect(() => {
    if (!page || !drawable) return
    let cancelled = false
    const timer = setTimeout(() => {
      const resized = resizePageContent(page, { w: from.width, h: from.height }, { w: toW, h: toH }, mode)
      const box = fitBox({ width: toW, height: toH }, BOX.width, BOX.height)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      void renderPageToCanvas(resized, { width: toW, height: toH }, editor.loadContext, { multiplier: (box.width * dpr) / toW })
        .then((canvas) => {
          if (!cancelled) setAfter(canvas.toDataURL('image/png'))
        })
        .catch(() => {
          if (!cancelled) setAfter(null)
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [editor, page, drawable, from.width, from.height, toW, toH, mode])

  const beforeBox = fitBox(from, BOX.width, BOX.height)
  const afterBox = usable ? fitBox({ width: toW, height: toH }, BOX.width, BOX.height) : null
  return (
    <figure className={styles.preview} aria-label={t.dialog.resizePreview} data-testid="resize-preview">
      <figcaption className={styles.previewTitle}>{t.dialog.resizePreview}</figcaption>
      <div className={styles.previewRow}>
        <div className={styles.previewCell}>
          <div className={styles.previewFrame} style={BOX}>
            <div className={styles.previewPage} style={beforeBox}>
              {before ? <img src={before} alt={t.dialog.resizePreviewAlt(t.dialog.resizePreviewBefore, from.width, from.height)} draggable={false} /> : null}
            </div>
          </div>
          <span>{t.dialog.resizePreviewBefore}</span>
        </div>
        <div className={styles.previewCell}>
          <div className={styles.previewFrame} style={BOX}>
            {afterBox ? (
              <div className={styles.previewPage} style={afterBox} data-testid="resize-preview-after">
                {drawable && after ? <img src={after} alt={t.dialog.resizePreviewAlt(t.dialog.resizePreviewAfter, toW, toH)} draggable={false} /> : null}
              </div>
            ) : null}
          </div>
          <span>{t.dialog.resizePreviewAfter}</span>
        </div>
      </div>
    </figure>
  )
}
