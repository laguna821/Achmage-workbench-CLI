import type { ComponentType } from 'react'
import { Registry } from '../engine/registry'

export interface DialogDefinition {
  id: string
  /** Rendered while `editor.openDialog(id, props)` is active; call `editor.closeDialog()` to dismiss. */
  component: ComponentType<{ props?: Record<string, unknown> }>
  /** Starts downloading the dialog's code (lazy dialogs); see `preloadDialog`. */
  preload?(): void
}

export const dialogs = new Registry<DialogDefinition>()

export function registerDialog(dialog: DialogDefinition): () => void {
  return dialogs.register(dialog)
}

/** Warms up a lazy dialog before it is opened (hovering the button that opens it). Unknown ids and eager dialogs do nothing. */
export function preloadDialog(id: string): void {
  dialogs.get(id)?.preload?.()
}
