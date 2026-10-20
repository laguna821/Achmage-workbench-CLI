/**
 * Colours that tell collaborators apart. Each one is dark enough for white text (name tags and avatars) and for a
 * 3:1 outline on a white page, none is a red or a pink (the editor's own selection is red, so a collaborator's never is),
 * and the same user gets the same colour on every screen.
 */
export const USER_COLORS: readonly string[] = [
  '#2563eb', // blue
  '#4338ca', // indigo
  '#7c3aed', // violet
  '#a21caf', // fuchsia
  '#c2410c', // orange
  '#a16207', // gold
  '#4d7c0f', // olive
  '#0f766e', // teal
  '#0e7490', // cyan
  '#475569', // slate
]

const HEX = /^#[0-9a-fA-F]{6}$/

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

/** The colour of a user: a stable pick from the palette by hashing the id (FNV-1a). */
export function colorForUser(userId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return USER_COLORS[hash % USER_COLORS.length]
}

function channel(value: number): number {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** White or near-black, whichever reads better on `background`. */
export function textOn(background: string): '#ffffff' | '#111111' {
  return contrast(background, '#ffffff') >= contrast(background, '#111111') ? '#ffffff' : '#111111'
}

/** Up to two letters for an avatar: first letters of the first and last word, or the first two of a single word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length === 1 ? Array.from(words[0]).slice(0, 2) : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]]
  return letters.join('').toUpperCase()
}
