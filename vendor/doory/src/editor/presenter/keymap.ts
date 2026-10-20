/**
 * The keyboard of a presentation, as one pure table. Both windows use it (the audience window and the presenter
 * view), so a key means the same thing in each. Chords with Ctrl, Cmd or Alt are never taken: they belong to the
 * browser (reload, close the tab, back).
 */

export type PresenterKey =
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'togglePause'
  | 'toggleFullscreen'
  | 'exit'
  | 'toggleNotes'
  | 'toggleBlackout'
  | 'toggleLaser'
  | 'toggleSound'
  | 'restart'
  | 'toggleHelp'

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const BY_KEY: Readonly<Record<string, PresenterKey>> = {
  ' ': 'next',
  Enter: 'next',
  ArrowRight: 'next',
  ArrowDown: 'next',
  PageDown: 'next',
  ArrowLeft: 'prev',
  ArrowUp: 'prev',
  PageUp: 'prev',
  Backspace: 'prev',
  Home: 'first',
  End: 'last',
  Escape: 'exit',
  '?': 'toggleHelp',
  f: 'toggleFullscreen',
  n: 'toggleNotes',
  p: 'togglePause',
  b: 'toggleBlackout',
  l: 'toggleLaser',
  m: 'toggleSound',
  r: 'restart',
}

/** What a key press does in a presentation, or `null` when it does nothing (and must be left to the browser). */
export function actionForKey(e: KeyLike): PresenterKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  // Shift turns "forward" into "back" for the keys that mean it in other players.
  if (e.shiftKey && (key === ' ' || key === 'Enter')) return 'prev'
  return BY_KEY[key] ?? null
}

/** Keys that open or activate a control when it has focus: the presentation leaves them to the control. */
export function isActivationKey(key: string): boolean {
  return key === ' ' || key === 'Enter'
}
