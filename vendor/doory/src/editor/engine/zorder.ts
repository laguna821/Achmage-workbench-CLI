export type ZMode = 'forward' | 'backward' | 'front' | 'back'

/**
 * Stacking-order change for a set of selected ids. `order[0]` is the bottom of the stack. Selected items
 * keep their relative order, and a selected item never jumps over another selected item one step at a time.
 */
export function reorderIds(order: readonly string[], selected: ReadonlySet<string>, mode: ZMode): string[] {
  const out = [...order]
  switch (mode) {
    case 'front':
      return [...out.filter((id) => !selected.has(id)), ...out.filter((id) => selected.has(id))]
    case 'back':
      return [...out.filter((id) => selected.has(id)), ...out.filter((id) => !selected.has(id))]
    case 'forward':
      for (let i = out.length - 2; i >= 0; i--) {
        if (selected.has(out[i]) && !selected.has(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]]
      }
      return out
    case 'backward':
      for (let i = 1; i < out.length; i++) {
        if (selected.has(out[i]) && !selected.has(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]]
      }
      return out
  }
}

/** Moves one id to `toIndex` (layers drag & drop). */
export function moveId(order: readonly string[], id: string, toIndex: number): string[] {
  const from = order.indexOf(id)
  if (from < 0) return [...order]
  const out = [...order]
  out.splice(from, 1)
  out.splice(Math.max(0, Math.min(out.length, toIndex)), 0, id)
  return out
}
