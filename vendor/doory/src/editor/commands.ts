/**
 * Command registry. Commands drive keyboard shortcuts, the context menu, the File menu and toolbar
 * buttons, so a feature registers once and shows up everywhere:
 *
 * ```ts
 * registerCommand({ id: 'my.cmd', label: 'Do it', shortcut: 'Mod+Shift+K', run: (ed) => ed.arrange.duplicate() })
 * ```
 */
import type { ReactNode } from 'react'
import type { EditorEngine } from './engine/editor'
import { Registry } from './engine/registry'
import type { EditorState } from './store/editorStore'

export interface CommandContext {
  editor: EditorEngine
  state: EditorState
}

export interface Command {
  id: string
  label: string
  /** Chord(s), e.g. `Mod+Shift+Z` or `Delete|Backspace` (see shortcuts.ts). */
  shortcut?: string
  /** Heading in the shortcuts dialog. */
  group?: string
  icon?: ReactNode
  run(editor: EditorEngine): void | Promise<void>
  /** Re-evaluated whenever the editor state changes. Default: enabled. */
  enabled?(ctx: CommandContext): boolean
  /**
   * Shortcut is displayed but not handled by the key handler (the browser's own clipboard events do it).
   */
  displayOnly?: boolean
  /** Also fire while a text field or text object is being edited (undo/redo, bold…). */
  whileEditing?: boolean
}

export const commands = new Registry<Command>()

export function registerCommand(command: Command): () => void {
  return commands.register(command)
}

export function isCommandEnabled(command: Command, ctx: CommandContext): boolean {
  if (ctx.state.readOnly && !command.id.startsWith('view.') && !command.id.startsWith('file.')) return false
  return command.enabled ? command.enabled(ctx) : true
}

export function runCommand(editor: EditorEngine, id: string): void {
  const command = commands.get(id)
  if (!command) return
  if (!isCommandEnabled(command, { editor, state: editor.state })) return
  void command.run(editor)
}
