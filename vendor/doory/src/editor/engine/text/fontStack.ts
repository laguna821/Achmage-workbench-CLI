/** Font family strings may be CSS stacks (`"Playfair Display", serif`); these helpers split/join them. */
import type { FontCategory } from '@/types/api'

const GENERIC: Record<FontCategory, string> = {
  'sans-serif': 'sans-serif',
  serif: 'serif',
  display: 'sans-serif',
  handwriting: 'cursive',
  monospace: 'monospace',
}

const GENERIC_NAMES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'])

/** First family of a CSS font stack, unquoted. */
export function primaryFamily(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? ''
  return first.replace(/^["']|["']$/g, '')
}

export function isGenericFamily(name: string): boolean {
  return GENERIC_NAMES.has(name.trim().toLowerCase())
}

/** `"Name", generic` — keeps text legible with a sensible fallback while the web font loads or fails. */
export function fontStack(family: string, category: FontCategory | undefined): string {
  const name = primaryFamily(family)
  return `"${name.replace(/"/g, '')}", ${GENERIC[category ?? 'sans-serif']}`
}
