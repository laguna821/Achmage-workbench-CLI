/**
 * Keyboard shortcut parsing/formatting. A shortcut is a `+`-joined chord such as `Mod+Shift+Z`;
 * `Mod` is ⌘ on macOS and Ctrl elsewhere. Several alternatives are separated by `|`.
 */
export interface Chord {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  space: ' ',
  plus: '+',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
}

/** Splits `Mod+Shift+Z` into parts; a trailing `+` (as in `Mod++`) is the plus key itself. */
function splitChord(alt: string): string[] {
  const trimmed = alt.trim()
  if (trimmed === '+') return ['+']
  if (trimmed.endsWith('++')) return [...trimmed.slice(0, -2).split('+').filter(Boolean), '+']
  return trimmed.split('+')
}

export function parseShortcut(shortcut: string): Chord[] {
  return shortcut.split('|').map((alt) => {
    const parts = splitChord(alt).map((p) => p.trim())
    const last = (parts.pop() ?? '').toLowerCase()
    const mods = new Set(parts.map((p) => p.toLowerCase()))
    return {
      mod: mods.has('mod') || mods.has('ctrl') || mods.has('cmd'),
      shift: mods.has('shift'),
      alt: mods.has('alt') || mods.has('option'),
      key: KEY_ALIASES[last] ?? last,
    }
  })
}

export function matchesChord(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, chord: Chord): boolean {
  const mod = e.ctrlKey || e.metaKey
  if (chord.mod !== mod || chord.alt !== e.altKey) return false
  const key = e.key.toLowerCase()
  const isLetterOrDigit = /^[a-z0-9]$/.test(chord.key)
  // Shift is significant unless the chord names a symbol whose character already encodes it (`?`, `+`…).
  if (isLetterOrDigit || chord.key.length > 1) {
    if (chord.shift !== e.shiftKey) return false
  }
  return key === chord.key
}

export function matchesShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, shortcut: string): boolean {
  return parseShortcut(shortcut).some((c) => matchesChord(e, c))
}

const MAC_SYMBOLS: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥' }
const KEY_LABELS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  escape: 'Esc',
  delete: 'Del',
  backspace: '⌫',
  enter: '↵',
  ' ': 'Space',
}

/** First alternative, formatted for the platform (`⌘⇧Z` / `Ctrl+Shift+Z`). */
export function formatShortcut(shortcut: string, mac: boolean = isMac()): string {
  const first = shortcut.split('|')[0]
  const chord = parseShortcut(first)[0]
  const key = KEY_LABELS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key.charAt(0).toUpperCase() + chord.key.slice(1))
  if (mac) return `${chord.alt ? MAC_SYMBOLS.alt : ''}${chord.shift ? MAC_SYMBOLS.shift : ''}${chord.mod ? MAC_SYMBOLS.mod : ''}${key}`
  return [chord.mod ? 'Ctrl' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '', key].filter(Boolean).join('+')
}
