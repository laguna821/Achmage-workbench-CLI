/**
 * Splits items into `columns` columns of similar height: each item goes to the currently shortest column, in order.
 * Appending items never moves the ones already placed, so an endless list does not jump while it loads.
 * `heights` are relative heights (any unit); returns the indices of each column in order.
 */
export function splitColumns(heights: readonly number[], columns: number): number[][] {
  const count = Math.max(1, Math.floor(columns))
  const out: number[][] = Array.from({ length: count }, () => [])
  const filled: number[] = Array.from({ length: count }, () => 0)
  heights.forEach((h, index) => {
    let target = 0
    for (let c = 1; c < count; c++) if (filled[c] < filled[target]) target = c
    out[target].push(index)
    filled[target] += h
  })
  return out
}
