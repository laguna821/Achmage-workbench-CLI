/**
 * Contextual toolbar registry. Each section decides whether it applies to the current selection; all
 * applicable sections render in `order`, so the toolbar "morphs" per selection:
 *
 * ```tsx
 * registerToolbarSection({
 *   id: 'chart',
 *   order: 25,
 *   appliesTo: (selection) => selection.kinds.includes('chart'),
 *   component: ChartTools,
 * })
 * ```
 */
import type { ComponentType } from 'react'
import { Registry } from '../engine/registry'
import type { EditorState, SelectionState } from '../store/editorStore'

export interface ToolbarSectionDefinition {
  id: string
  order: number
  appliesTo(selection: SelectionState, state: EditorState): boolean
  component: ComponentType
}

export const toolbarSections = new Registry<ToolbarSectionDefinition>((a, b) => a.order - b.order)

export function registerToolbarSection(section: ToolbarSectionDefinition): () => void {
  return toolbarSections.register(section)
}
