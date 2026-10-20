import { type RefObject, useEffect } from 'react'
import { commands, isCommandEnabled } from '../commands'
import type { EditorEngine } from '../engine/editor'
import { matchesShortcut } from '../shortcuts'

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'range', 'submit'].includes(type)
  }
  return false
}

/**
 * Global editor shortcuts, driven entirely by the command registry. Native text fields keep their own
 * shortcuts; Fabric's hidden text-editing textarea only receives commands flagged `whileEditing`.
 */
export function useKeyboardShortcuts(engine: EditorEngine, rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const root = rootRef.current
      const target = e.target as HTMLElement | null
      if (!root || !target) return
      const inside = root.contains(target) || target === document.body || target === document.documentElement
      if (!inside || e.defaultPrevented || engine.state.ui.dialog) return
      const fabricText = target.dataset?.fabric === 'textarea'
      const editable = isEditableTarget(target)
      // A focused slider steps with the arrow, Home, End and Page keys itself; they must not nudge the selection.
      if (target instanceof HTMLInputElement && target.type === 'range' && /^(Arrow(Left|Right|Up|Down)|Home|End|Page(Up|Down))$/.test(e.key)) return

      if (e.key === ' ' && !editable && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (target.tagName === 'BUTTON' || target.getAttribute('role') === 'menuitem' || target.getAttribute('role') === 'option') return
        e.preventDefault()
        if (!engine.state.ui.spaceDown) engine.patchUi({ spaceDown: true })
        return
      }

      // Escape inside the text editor leaves edit mode (Fabric handled it); it must not also deselect.
      if (fabricText && e.key === 'Escape') return

      for (const cmd of commands.list()) {
        if (!cmd.shortcut || cmd.displayOnly || !matchesShortcut(e, cmd.shortcut)) continue
        if (editable && !(fabricText && cmd.whileEditing)) continue
        // Plain-key shortcuts must not hijack buttons/menus that use Enter/Escape themselves.
        if (!editable && (e.key === 'Enter') && (target.tagName === 'BUTTON' || target.getAttribute('role'))) continue
        if (!isCommandEnabled(cmd, { editor: engine, state: engine.state })) continue
        e.preventDefault()
        void cmd.run(engine)
        return
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === ' ' && engine.state.ui.spaceDown) engine.patchUi({ spaceDown: false })
    }
    const onBlur = (): void => {
      if (engine.state.ui.spaceDown) engine.patchUi({ spaceDown: false })
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [engine, rootRef])
}

/** Copy / cut / paste via the DOM clipboard events (works across tabs and with the system clipboard). */
export function useClipboardEvents(engine: EditorEngine, rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const applicable = (e: Event): boolean => {
      const root = rootRef.current
      const target = e.target as HTMLElement | null
      if (!root || !target || engine.state.ui.dialog || engine.state.selection.editing) return false
      if (!(root.contains(target) || target === document.body)) return false
      return !isEditableTarget(target)
    }
    const onCopy = (e: ClipboardEvent): void => {
      if (!applicable(e) || !e.clipboardData) return
      if (engine.clipboard.writeTo(e.clipboardData)) e.preventDefault()
    }
    const onCut = (e: ClipboardEvent): void => {
      if (!applicable(e) || !e.clipboardData) return
      if (engine.clipboard.writeTo(e.clipboardData)) {
        e.preventDefault()
        engine.arrange.delete()
      }
    }
    const onPaste = (e: ClipboardEvent): void => {
      if (!applicable(e) || engine.readOnly) return
      e.preventDefault()
      void engine.clipboard.pasteFrom(e.clipboardData)
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCut)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCut)
      document.removeEventListener('paste', onPaste)
    }
  }, [engine, rootRef])
}
