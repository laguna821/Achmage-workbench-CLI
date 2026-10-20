/** True when every selected object is of `kind`. */
export const onlyKind = (kinds: readonly string[], kind: string): boolean => kinds.length === 1 && kinds[0] === kind

function collectColors(obj: Record<string, unknown>, out: Set<string>): void {
  if (typeof obj.origFill === 'string') out.add(obj.origFill)
  if (typeof obj.origStroke === 'string') out.add(obj.origStroke)
  if (Array.isArray(obj.objects)) for (const c of obj.objects as Record<string, unknown>[]) collectColors(c, out)
}

/** The original colours of a catalog element that can be recoloured (none: no recolour controls). */
export function elementColors(obj: Record<string, unknown> | undefined): string[] {
  const colors = new Set<string>()
  if (obj) collectColors(obj, colors)
  return [...colors].slice(0, 8)
}
