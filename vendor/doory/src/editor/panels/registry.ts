/**
 * Tool registry: every entry is a button in the tool rail (icon over label) that opens its component in a panel docked
 * beside the rail, which stays open until it is closed. Features add tools without touching core files:
 *
 * ```tsx
 * registerPanel({ id: 'charts', label: 'Charts', icon: <ChartBar size={18} />, order: 45, placement: 'drawer', component: ChartsDrawer })
 * ```
 *
 * Below the desktop breakpoint every tool opens as a bottom sheet.
 */
import type { ComponentType, ReactNode } from 'react'
import type { EditorEngine } from '../engine/editor'
import { Registry } from '../engine/registry'
import type { EditorState } from '../store/editorStore'

export interface PanelProps {
  /** Closes the tool (drawers call it after an item was added). */
  close(): void
}

export interface PanelDefinition {
  id: string
  /** Label under the icon in the rail. */
  label: string
  icon: ReactNode
  /** Lower comes first in the rail. Built-ins use 10, 20, 30… */
  order: number
  /** Rendered inside the drawer / sidebar; use `useEditor()` & friends for state. */
  component: ComponentType<PanelProps>
  /** Hide the tool when this returns false (e.g. needs an account service). */
  requires?(ctx: { editor: EditorEngine; state: EditorState }): boolean
  /** Sidebar / sheet heading (defaults to `label`). */
  title?: string
  /** `drawer`: sections that scroll as one column, and adding from it keeps it open. `sidebar`: the panel lays itself out. Default `sidebar`. */
  placement?: 'drawer' | 'sidebar'
  /** Panel width in px (at least 320). */
  width?: number
  /** Shortcut hint for the tooltip. */
  shortcut?: string
  /** `tools`: an entry in the rail (default). `end`: an icon button at the right end of the top bar. */
  slot?: 'tools' | 'end'
  /** Starts downloading the panel's code (lazy panels); its button calls it when it is hovered or focused. */
  preload?(): void
  /** Also offered while the design is open view-only or comment-only (a shared link), e.g. Comments. */
  readOnly?: boolean
}

export const panels = new Registry<PanelDefinition>((a, b) => a.order - b.order)

export function registerPanel(panel: PanelDefinition): () => void {
  return panels.register(panel)
}
