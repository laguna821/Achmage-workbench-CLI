import { useRef, useState } from 'react'
import { useEditor, useEditorState } from '../context'
import { formatSize, getPageSize } from '../engine/pageSizes'
import { t } from '../strings'
import { Popover } from '../ui/Popover'
import { SizePanel } from './SizePanel'
import styles from './PageSlot.module.css'

interface PageSizeChipProps {
  pageId: string
  /** 1-based number of the page, for the accessible name. */
  number: number
}

/**
 * The size of a page in its header ("1080 × 1080 px"). In an editable design it is a button that opens the size
 * menu of that page (presets, custom size, "apply to all pages"); in a view-only link it is plain text.
 */
export function PageSizeChip({ pageId, number }: PageSizeChipProps) {
  const editor = useEditor()
  const readOnly = useEditorState((s) => s.readOnly)
  const width = useEditorState((s) => getPageSize(s.doc, pageId).width)
  const height = useEditorState((s) => getPageSize(s.doc, pageId).height)
  const unit = useEditorState((s) => s.doc.unit)
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const text = formatSize({ width, height }, unit)

  if (readOnly) {
    return (
      <span className={styles.size} data-testid="ed-page-size">
        {text}
      </span>
    )
  }
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`${styles.size} ${styles.sizeButton}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t.workspace.sizeChipLabel(number, text)}
        data-testid="ed-page-size"
        onClick={() => {
          editor.pages.activate(pageId, false)
          setOpen((o) => !o)
        }}
      >
        {text}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} label={t.canvasSize.pageTitle(number)} placement="bottom-start" variant="plain" cover gap={6}>
        <SizePanel close={() => setOpen(false)} pageId={pageId} defaultScope="page" />
      </Popover>
    </>
  )
}
