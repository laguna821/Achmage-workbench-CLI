import { ChevronLeft, ChevronRight, Clapperboard, LayoutGrid, Plus, StickyNote } from 'lucide-react'
import { useEditor, useEditorState } from '../context'
import { toggleNotes, useNotesOpen } from '../panels/notesVisibility'
import { t } from '../strings'
import { Tooltip } from '../ui/Tooltip'
import { LazyTimelineHost } from './TimelineLoader'
import { toggleTimeline, useTimelineView } from './timelineVisibility'
import styles from './Floating.module.css'

interface PagesPillProps {
  stripOpen: boolean
  onToggleStrip: () => void
}

/** Bottom-left pill: page thumbnails toggle, previous / next page and "Page 2 of 5". */
export function PagesPill({ stripOpen, onToggleStrip }: PagesPillProps) {
  const editor = useEditor()
  const doc = useEditorState((s) => s.doc)
  const activeId = useEditorState((s) => s.activePageId)
  const readOnly = useEditorState((s) => s.readOnly)
  const notesOpen = useNotesOpen()
  const timelineOpen = useTimelineView().open
  const index = Math.max(0, doc.pages.findIndex((p) => p.id === activeId))
  return (
    <div className={styles.pages} role="group" aria-label={t.pagesPill.group} data-testid="ed-pages-pill">
      <Tooltip label={stripOpen ? t.pagesPill.hide : t.pagesPill.toggle} side="top">
        <button type="button" className={styles.zoomBtn} aria-label={stripOpen ? t.pagesPill.hide : t.pagesPill.toggle} aria-pressed={stripOpen} data-testid="ed-pages-toggle" onClick={onToggleStrip}>
          <LayoutGrid size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={t.statusBar.previous} shortcut="PageUp" side="top" disabled={index === 0}>
        <button type="button" className={styles.zoomBtn} aria-label={t.statusBar.previous} disabled={index === 0} onClick={() => editor.pages.activate(doc.pages[index - 1].id)}>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      <span className={styles.pagesText} data-testid="ed-pages-text">
        {t.workspace.pageOf(index + 1, doc.pages.length)}
      </span>
      <Tooltip label={t.statusBar.next} shortcut="PageDown" side="top" disabled={index >= doc.pages.length - 1}>
        <button type="button" className={styles.zoomBtn} aria-label={t.statusBar.next} disabled={index >= doc.pages.length - 1} onClick={() => editor.pages.activate(doc.pages[index + 1].id)}>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={t.notes.title} shortcut="Shift+N" side="top">
        <button type="button" className={`${styles.zoomBtn} ${styles.roomy}`} aria-label={t.notes.title} aria-pressed={notesOpen} data-testid="ed-notes-toggle" onClick={() => toggleNotes(editor)}>
          <StickyNote size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={timelineOpen ? t.animation.timeline.hide : t.animation.timeline.show} shortcut="Shift+T" side="top">
        <button type="button" className={`${styles.zoomBtn} ${styles.roomy}`} aria-label={timelineOpen ? t.animation.timeline.hide : t.animation.timeline.show} aria-pressed={timelineOpen} data-testid="ed-timeline-toggle" onPointerEnter={() => void LazyTimelineHost.preload()} onFocus={() => void LazyTimelineHost.preload()} onClick={() => toggleTimeline(editor)}>
          <Clapperboard size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      {readOnly ? null : (
        <Tooltip label={t.pagesPill.add} side="top">
          <button type="button" className={styles.zoomBtn} aria-label={t.pagesPill.add} data-testid="ed-pages-add" onClick={() => editor.pages.add(doc.pages.length)}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
