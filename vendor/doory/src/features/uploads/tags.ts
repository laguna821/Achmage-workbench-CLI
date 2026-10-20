export function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const tag = part.trim().toLowerCase().slice(0, 32)
    if (tag) seen.add(tag)
  }
  return [...seen].slice(0, 20)
}
