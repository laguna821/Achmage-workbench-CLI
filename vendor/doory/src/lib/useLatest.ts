import { useEffect, useState } from 'react'

/** A stable box whose content is always the most recent value passed to `useLatest`. */
export class Latest<T> {
  private value: T

  constructor(initial: T) {
    this.value = initial
  }

  get(): T {
    return this.value
  }

  set(next: T): void {
    this.value = next
  }
}

/**
 * Lets long-lived objects (an editor adapter created once) call the freshest callbacks without being
 * re-created on every render.
 */
export function useLatest<T>(value: T): Latest<T> {
  const [box] = useState(() => new Latest(value))
  useEffect(() => {
    box.set(value)
  })
  return box
}
