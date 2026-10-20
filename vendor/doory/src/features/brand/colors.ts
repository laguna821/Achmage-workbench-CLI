const HEX6 = /^#[0-9a-f]{6}$/i

/** Accepts "#abc", "abc", "#aabbcc", "AABBCC" and returns lowercase "#rrggbb", or null. */
export function normalizeHex(input: string): string | null {
  let value = input.trim().toLowerCase()
  if (value.startsWith('#')) value = value.slice(1)
  if (/^[0-9a-f]{3}$/.test(value)) value = value.split('').map((char) => char + char).join('')
  const hex = `#${value}`
  return HEX6.test(hex) ? hex : null
}
