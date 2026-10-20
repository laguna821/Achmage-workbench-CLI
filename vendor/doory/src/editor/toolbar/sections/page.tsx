import { Copy, Plus, Trash2 } from 'lucide-react'
import { ColorTool } from '../../chrome/ColorTool'
import { useDocument, useEditor, useEditorState } from '../../context'
import { backgroundFill, fillToBackground } from '../../panels/backgroundFill'
import { t } from '../../strings'
import { ToolButton } from '../parts'
import ed from '../../chrome/ed.module.css'

/**
 * What the contextual row offers while nothing is selected: the page's colour and the page actions. The row is
 * always there (like the selection tools replace it), so selecting an object never moves the page under the pointer.
 */
export function PageSection() {
  const editor = useEditor()
  const doc = useDocument()
  const activeId = useEditorState((s) => s.activePageId)
  const index = Math.max(0, doc.pages.findIndex((p) => p.id === activeId))
  const page = doc.pages[index]
  return (
    <>
      <span className={ed.stripLabel} data-testid="ed-page-label">
        {page.name?.trim() || t.workspace.pageOf(index + 1, doc.pages.length)}
      </span>
      <ColorTool label={t.panels.pageBackground} value={backgroundFill(page.background)} allowGradient testId="ed-page-bg" onChange={(f, key) => editor.pages.setBackground(page.id, fillToBackground(f), key ?? 'bg-fill')} />
      <span className={ed.divider} role="separator" aria-orientation="vertical" />
      <ToolButton label={t.pagesPill.add} testId="ed-page-add" onClick={() => editor.pages.add(index + 1)}>
        <Plus size={18} aria-hidden="true" />
      </ToolButton>
      <ToolButton label={t.workspace.duplicatePage} testId="ed-page-duplicate" onClick={() => editor.pages.duplicate(page.id)}>
        <Copy size={18} aria-hidden="true" />
      </ToolButton>
      <ToolButton label={t.workspace.deletePage} danger disabled={doc.pages.length < 2} testId="ed-page-delete" onClick={() => editor.pages.remove(page.id)}>
        <Trash2 size={18} aria-hidden="true" />
      </ToolButton>
    </>
  )
}
