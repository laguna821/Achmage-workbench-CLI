import type { SelectionState } from '../store/editorStore'

/**
 * Bold means 700 or heavier (or the keyword). A semi-bold 600 is *not* bold, so the Bold button on the preset
 * subheading makes it bolder instead of lighter.
 */
export function isBold(weight: unknown): boolean {
  if (typeof weight === 'number') return weight >= 700
  if (typeof weight === 'string') return weight === 'bold' || Number.parseInt(weight, 10) >= 700
  return false
}

/** Effective style value for the (first) selected text: caret style while editing, else the object's. */
export function textValue(selection: SelectionState, key: string): unknown {
  if (selection.textStyle && key in selection.textStyle) return selection.textStyle[key]
  return selection.objects[0]?.[key]
}

export function firstObject(selection: SelectionState): Record<string, unknown> | undefined {
  return selection.objects[0]
}
