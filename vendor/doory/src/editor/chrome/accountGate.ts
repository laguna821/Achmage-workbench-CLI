import type { AccountReason } from '@/types/adapter'
import type { EditorEngine } from '../engine/editor'

/**
 * Guests have to sign up (and have their local design moved to the account) before account features such as sharing,
 * version history, comments or brand kits. Resolves true when the feature can be used: always for signed-in modes,
 * otherwise once the shell reports that the sign-up and the migration finished.
 */
export async function ensureAccount(editor: EditorEngine, reason: AccountReason): Promise<boolean> {
  if (editor.state.mode !== 'guest') return true
  try {
    return await editor.adapter.requireAccount(reason, async () => ({ document: editor.getDocument(), title: editor.state.title }))
  } catch {
    return false
  }
}

/** Waits (up to `timeout` ms) for the adapter the shell swaps in after a sign-up to offer `ready`. */
export async function whenAvailable(editor: EditorEngine, ready: (editor: EditorEngine) => boolean, timeout = 3000): Promise<boolean> {
  const end = Date.now() + timeout
  while (!ready(editor)) {
    if (Date.now() >= end) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

/** Opens a dialog that needs an account service: signs a guest up first, then waits for the service to exist. */
export async function openAccountDialog(editor: EditorEngine, reason: AccountReason, dialog: string, ready: (editor: EditorEngine) => boolean, unavailable: string): Promise<void> {
  if (editor.readOnly) return
  if (!(await ensureAccount(editor, reason))) return
  if (!(await whenAvailable(editor, ready))) {
    editor.toast(unavailable, 'info')
    return
  }
  editor.openDialog(dialog)
}
