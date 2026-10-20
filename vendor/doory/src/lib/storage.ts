/** localStorage access that never throws (private mode, blocked storage, SSR/tests). */
export function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function safeRemoveItem(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* storage unavailable: nothing to remove */
  }
}
