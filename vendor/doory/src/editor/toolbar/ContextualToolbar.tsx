import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useEditorState } from '../context'
import { t } from '../strings'
import { Toolbar } from '../ui/Toolbar'
import { toolbarSections } from './registry'
import ed from '../chrome/ed.module.css'

/** Which ends of the scroller have more tools beyond them. */
function useOverflow(scroller: React.RefObject<HTMLDivElement | null>, key: string): { start: boolean; end: boolean } {
  const [edges, setEdges] = useState({ start: false, end: false })
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => {
      const start = el.scrollLeft > 1
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [scroller, key])
  return edges
}

/**
 * The row above the workspace that morphs with the selection (text, shape, image, sticker, several objects).
 * It is always there (page tools when nothing is selected), so selecting an object never shifts the page under the pointer.
 * When the workspace is too narrow for every tool (an open panel, a small window) the row scrolls sideways: arrows at
 * the edges say there is more and scroll to it, and the mouse wheel scrolls it too.
 */
export function ContextualToolbar() {
  const sections = useSyncExternalStore(toolbarSections.subscribe, toolbarSections.getSnapshot)
  const state = useEditorState((s) => s)
  const scroller = useRef<HTMLDivElement>(null)
  const applicable = sections.filter((s) => s.appliesTo(state.selection, state))
  // While cropping only the crop controls make sense.
  const shown = state.ui.cropping ? applicable.filter((s) => s.id === 'crop') : applicable
  const key = shown.map((s) => s.id).join(' ')
  const edges = useOverflow(scroller, key)
  if (state.readOnly || shown.length === 0) return null
  const scrollBy = (direction: 1 | -1): void => {
    const el = scroller.current
    if (el) el.scrollLeft += direction * el.clientWidth * 0.7
  }
  return (
    <div className={ed.strip} data-testid="ed-context-strip" data-kind={state.selection.kinds.join(' ') || 'page'}>
      <div
        ref={scroller}
        className={ed.stripInner}
        onWheel={(e) => {
          // A plain mouse wheel only scrolls vertically: turn it sideways here, where there is nothing to scroll up or down.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        <Toolbar label={t.toolbar.label} className={ed.row}>
          {shown.map((s, i) => {
            const Component = s.component
            return (
              <Fragment key={s.id}>
                {i > 0 ? <span className={ed.divider} role="separator" aria-orientation="vertical" /> : null}
                <Component />
              </Fragment>
            )
          })}
        </Toolbar>
      </div>
      {/* Pointer conveniences only: the keyboard moves through the row with the arrow keys, which scrolls it. */}
      {edges.start ? (
        <button type="button" className={ed.stripArrow} data-side="start" tabIndex={-1} aria-label={t.toolbar.scrollBack} onClick={() => scrollBy(-1)}>
          <span>
            <ChevronLeft size={16} aria-hidden="true" />
          </span>
        </button>
      ) : null}
      {edges.end ? (
        <button type="button" className={ed.stripArrow} data-side="end" tabIndex={-1} aria-label={t.toolbar.scrollMore} onClick={() => scrollBy(1)}>
          <span>
            <ChevronRight size={16} aria-hidden="true" />
          </span>
        </button>
      ) : null}
    </div>
  )
}
