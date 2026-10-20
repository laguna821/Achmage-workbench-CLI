/**
 * Opening the presenter view window. `window.open` only works inside a user gesture (a click, a shortcut), so the
 * command that starts "Present with notes" opens the window itself, before the slideshow mounts, and leaves the
 * handle here for the slideshow to pick up by session id. A blocked pop-up gives `null`.
 */
import { presenterViewUrl } from './channel'

const WINDOW_NAME = 'doory-presenter-view'
const FEATURES = 'popup=yes,width=1180,height=780,left=40,top=40'

const handoff = new Map<string, Window>()

/** Opens (or re-uses) the presenter view window for `session`. Call it from the handler of a click or key press. */
export function openViewWindow(session: string): Window | null {
  let win: Window | null = null
  try {
    win = window.open(presenterViewUrl(session), WINDOW_NAME, FEATURES)
  } catch {
    win = null
  }
  win?.focus()
  return win
}

/** Leaves an opened window for the slideshow of `session`. */
export function stashViewWindow(session: string, win: Window | null): void {
  if (win) handoff.set(session, win)
}

/** True when a window is stashed for `session`. */
export function hasStashedView(session: string): boolean {
  return handoff.has(session)
}

/** Takes the window stashed for `session` (once). */
export function takeViewWindow(session: string): Window | null {
  const win = handoff.get(session) ?? null
  handoff.delete(session)
  return win
}

/** True while the window is still open (a closed or navigated-away handle reads as closed). */
export function isWindowOpen(win: Window | null): boolean {
  try {
    return win !== null && !win.closed
  } catch {
    return false
  }
}
