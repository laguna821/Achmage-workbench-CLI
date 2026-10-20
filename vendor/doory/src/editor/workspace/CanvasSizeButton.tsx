import { useRef, useState } from 'react'
import { I } from '../chrome/icons'
import { useEditorState } from '../context'
import { isUniform } from '../engine/pageSizes'
import { t } from '../strings'
import { Popover } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import { SizePanel } from './SizePanel'
import styles from './Floating.module.css'

/**
 * The round button at the top right of the workspace: canvas size presets, custom size and flip, for the page in
 * view. A design whose pages already differ in size starts with "this page" selected, so a resize cannot flatten it.
 */
export function CanvasSizeButton() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const uniform = useEditorState((s) => isUniform(s.doc))
  const activePageId = useEditorState((s) => s.activePageId)
  return (
    <div className={styles.fabWrap}>
      <Tooltip label={t.canvasSize.button} side="left" disabled={open}>
        <button ref={ref} type="button" className={styles.fab} aria-label={t.canvasSize.button} aria-haspopup="dialog" aria-expanded={open} data-testid="ed-canvas-size" onClick={() => setOpen((o) => !o)}>
          {I.canvasSize}
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} label={t.canvasSize.title} placement="bottom-end" variant="plain" cover gap={8}>
        <SizePanel close={() => setOpen(false)} pageId={activePageId} defaultScope={uniform ? 'all' : 'page'} showFlip />
      </Popover>
    </div>
  )
}
