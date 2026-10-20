/**
 * Linear undo/redo stack over immutable snapshots.
 *
 * Snapshots are whole `DoryDocument`s, but the editor builds each one with structural sharing (only the
 * edited page — and within it only the edited objects — are new references), so a long stack costs
 * roughly "one changed object per step", not "one document per step".
 *
 * Continuous edits (dragging, slider scrubbing, typing bursts) pass a `coalesceKey`: while the same
 * key keeps arriving within `coalesceMs`, the newest snapshot replaces the top of the stack instead of
 * adding a step.
 */
export interface HistoryEntry<T> {
  state: T
  label: string
  key?: string
  at: number
}

export interface HistoryOptions {
  limit?: number
  coalesceMs?: number
  now?: () => number
}

export interface PushOptions {
  label: string
  coalesceKey?: string
}

export class History<T> {
  private entries: HistoryEntry<T>[]
  private index = 0
  private readonly limit: number
  private readonly coalesceMs: number
  private readonly now: () => number
  private sealed = false

  constructor(initial: T, options: HistoryOptions = {}) {
    this.limit = Math.max(2, options.limit ?? 200)
    this.coalesceMs = options.coalesceMs ?? 1200
    this.now = options.now ?? (() => Date.now())
    this.entries = [{ state: initial, label: 'Initial', at: this.now() }]
  }

  get current(): T {
    return this.entries[this.index].state
  }

  get canUndo(): boolean {
    return this.index > 0
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1
  }

  /** Number of undoable steps. */
  get depth(): number {
    return this.index
  }

  /** Label of the step `undo()` would revert. */
  get undoLabel(): string | null {
    return this.canUndo ? this.entries[this.index].label : null
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.entries[this.index + 1].label : null
  }

  /** Ends the current coalescing run: the next push always creates a new step. */
  seal(): void {
    this.sealed = true
  }

  push(state: T, { label, coalesceKey }: PushOptions): void {
    const t = this.now()
    const top = this.entries[this.index]
    const atTip = this.index === this.entries.length - 1
    if (
      coalesceKey !== undefined &&
      !this.sealed &&
      atTip &&
      this.index > 0 &&
      top.key === coalesceKey &&
      t - top.at <= this.coalesceMs
    ) {
      this.entries[this.index] = { state, label, key: coalesceKey, at: t }
      return
    }
    this.entries = this.entries.slice(0, this.index + 1)
    this.entries.push({ state, label, key: coalesceKey, at: t })
    this.sealed = false
    if (this.entries.length > this.limit) this.entries.shift()
    this.index = this.entries.length - 1
  }

  /** Replaces the current snapshot without creating a step (e.g. normalisation after load). */
  replaceCurrent(state: T): void {
    this.entries[this.index] = { ...this.entries[this.index], state }
  }

  undo(): T | null {
    if (!this.canUndo) return null
    this.index -= 1
    this.sealed = true
    return this.entries[this.index].state
  }

  redo(): T | null {
    if (!this.canRedo) return null
    this.index += 1
    this.sealed = true
    return this.entries[this.index].state
  }

  clear(state: T): void {
    this.entries = [{ state, label: 'Initial', at: this.now() }]
    this.index = 0
    this.sealed = false
  }
}
