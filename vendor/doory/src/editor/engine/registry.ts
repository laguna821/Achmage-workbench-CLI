/**
 * Tiny observable registry used by every extension point (panels, toolbar sections, commands,
 * export formats, object kinds). Registering an id twice replaces the earlier entry, which keeps hot
 * reload and tests tidy; `register*` returns an unregister function.
 */
export interface Registered {
  id: string
}

export class Registry<T extends Registered> {
  private items = new Map<string, T>()
  private listeners = new Set<() => void>()
  private snapshot: readonly T[] = []

  constructor(private readonly sort?: (a: T, b: T) => number) {}

  register(item: T): () => void {
    this.items.set(item.id, item)
    this.rebuild()
    return () => {
      if (this.items.get(item.id) === item) {
        this.items.delete(item.id)
        this.rebuild()
      }
    }
  }

  unregister(id: string): void {
    if (this.items.delete(id)) this.rebuild()
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  has(id: string): boolean {
    return this.items.has(id)
  }

  /** Stable array identity until the registry changes (safe for `useSyncExternalStore`). */
  list(): readonly T[] {
    return this.snapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): readonly T[] => this.snapshot

  clear(): void {
    this.items.clear()
    this.rebuild()
  }

  private rebuild(): void {
    const all = [...this.items.values()]
    this.snapshot = this.sort ? all.sort(this.sort) : all
    for (const l of [...this.listeners]) l()
  }
}
