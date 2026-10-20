/**
 * Local-only undo and redo for a shared design, on top of `Y.UndoManager`.
 *
 * Only transactions with the local origin are tracked, so undo never reverts what somebody else did. When a
 * property was changed by somebody else after this user changed it, undoing the user's change leaves the other
 * person's value alone (Yjs does not restore a property that has been overwritten by another client); every
 * other property of the same step is restored. Steps are grouped like the snapshot history groups them: edits
 * that carry the same `coalesceKey` within `COALESCE_MS`, and nothing sealed in between, are one step.
 */
import * as Y from 'yjs'
import type { HistoryStatus } from '../store/editorStore'
import type { YRoots } from './schema'

export const UNDO_LIMIT = 200
export const COALESCE_MS = 1200
/** Origin of the write that puts back a value an undo or redo left out (not tracked: it is part of the step it repairs). */
export const REPAIR_ORIGIN = Symbol('doory.undo-repair')

/** Where the user was: the page and the selection. */
export interface Place {
  activePageId: string
  selection: string[]
}

export interface StepInfo {
  label: string
  /** Restored by undo. */
  before: Place
  /** Restored by redo. */
  after: Place
}

export interface EditInfo {
  label: string
  coalesceKey?: string
  before: Place
  after: Place
}

interface Popped {
  item: Y.UndoManager['undoStack'][number]
  info: StepInfo | undefined
}

/**
 * Yjs does not put an old value back over a key that somebody else wrote at the same time, and removes the value the user
 * wrote: when the user's value had won, the key ends up with no value for anybody (two people set the same property at
 * once, the winner undoes; the shape loses its fill, the design its width). These are the keys a step emptied.
 */
function emptiedKeys(transaction: Y.Transaction): { map: Y.Map<unknown>; key: string }[] {
  const out: { map: Y.Map<unknown>; key: string }[] = []
  for (const [type, keys] of transaction.changed) {
    if (!(type instanceof Y.Map)) continue
    for (const key of keys) if (key !== null && !type.has(key)) out.push({ map: type as Y.Map<unknown>, key })
  }
  return out
}

/**
 * Array entries that a step created with the same item as their left and their right neighbour (`origin` equals
 * `rightOrigin`). Yjs' undo builds such an entry when the neighbours it traces on both sides lead to one and the same
 * restored item; here it sits after that item, and every other replica puts it before. These are the entries to replace.
 */
function ambiguousEntries(doc: Y.Doc, transaction: Y.Transaction): { array: Y.Array<unknown>; item: Y.Item }[] {
  const out: { array: Y.Array<unknown>; item: Y.Item }[] = []
  for (const [client, end] of transaction.afterState) {
    for (let clock = transaction.beforeState.get(client) ?? 0; clock < end; ) {
      const struct = Y.getItem(doc.store, Y.createID(client, clock))
      clock = struct.id.clock + struct.length
      if (!(struct instanceof Y.Item) || struct.deleted || struct.parentSub !== null || !struct.origin || !struct.rightOrigin) continue
      if (struct.origin.client !== struct.rightOrigin.client || struct.origin.clock !== struct.rightOrigin.clock) continue
      if (struct.parent instanceof Y.Array) out.push({ array: struct.parent as Y.Array<unknown>, item: struct })
    }
  }
  return out
}

/** The value the step replaced on `key` (what was there before the user's change), if the step replaced one. */
function replacedValue(doc: Y.Doc, step: Popped['item'], map: Y.Map<unknown>, key: string): { value: unknown } | null {
  for (const [client, ranges] of step.deletions.clients) {
    for (const range of ranges) {
      for (let clock = range.clock; clock < range.clock + range.len; ) {
        const struct = Y.getItem(doc.store, Y.createID(client, clock))
        clock = struct.id.clock + struct.length
        if (!(struct instanceof Y.Item) || struct.parent !== map || struct.parentSub !== key || struct.content instanceof Y.ContentType) continue
        if (Y.isDeleted(step.insertions, struct.id)) continue
        const [value] = struct.content.getContent()
        if (value !== undefined) return { value }
      }
    }
  }
  return null
}

export class LocalUndo {
  private readonly manager: Y.UndoManager
  private pending: StepInfo | null = null
  private lastKey: string | undefined
  private lastAt = 0
  private sealed = true
  private popping: Popped | null = null

  constructor(
    roots: YRoots,
    origin: unknown,
    private readonly onChange: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.manager = new Y.UndoManager([roots.meta, roots.pageOrder, roots.pages], {
      trackedOrigins: new Set([origin]),
      // Steps are closed by `begin`, never by a timer.
      captureTimeout: Number.MAX_SAFE_INTEGER,
    })
    const stamp = ({ stackItem, type }: { stackItem: Popped['item']; type: 'undo' | 'redo' }): void => {
      if (this.popping) {
        if (this.popping.info) stackItem.meta.set('info', this.popping.info)
      } else if (this.pending) {
        stackItem.meta.set('info', this.pending)
      }
      if (type === 'undo') while (this.manager.undoStack.length > UNDO_LIMIT) this.manager.undoStack.shift()
      this.onChange()
    }
    this.manager.on('stack-item-added', stamp)
    this.manager.on('stack-item-updated', ({ stackItem }: { stackItem: Popped['item'] }) => {
      if (this.pending) stackItem.meta.set('info', this.pending)
      this.onChange()
    })
    this.manager.on('stack-item-popped', () => this.onChange())
  }

  /**
   * Call right before the transaction of a user edit. Decides whether it joins the previous step and remembers
   * what to show for the step.
   */
  begin(edit: EditInfo): void {
    const t = this.now()
    const joins =
      edit.coalesceKey !== undefined &&
      !this.sealed &&
      this.manager.undoStack.length > 0 &&
      this.manager.redoStack.length === 0 &&
      this.lastKey === edit.coalesceKey &&
      t - this.lastAt <= COALESCE_MS
    if (joins) {
      const previous = this.manager.undoStack[this.manager.undoStack.length - 1].meta.get('info') as StepInfo | undefined
      this.pending = { label: edit.label, before: previous?.before ?? edit.before, after: edit.after }
    } else {
      this.manager.stopCapturing()
      this.pending = { label: edit.label, before: edit.before, after: edit.after }
    }
    this.lastKey = edit.coalesceKey
    this.lastAt = t
    this.sealed = false
  }

  /** Ends the current run of coalesced edits. */
  seal(): void {
    this.sealed = true
  }

  undo(): StepInfo | null {
    return this.step('undo')
  }

  redo(): StepInfo | null {
    return this.step('redo')
  }

  private step(direction: 'undo' | 'redo'): StepInfo | null {
    const stack = direction === 'undo' ? this.manager.undoStack : this.manager.redoStack
    const item = stack[stack.length - 1]
    if (!item) return null
    const info = item.meta.get('info') as StepInfo | undefined
    this.popping = { item, info }
    this.sealed = true
    this.pending = null
    const doc = this.manager.doc
    let emptied: { map: Y.Map<unknown>; key: string }[] = []
    let ambiguous: { array: Y.Array<unknown>; item: Y.Item }[] = []
    const watch = (transaction: Y.Transaction): void => {
      if (transaction.origin !== this.manager) return
      emptied = emptiedKeys(transaction)
      ambiguous = ambiguousEntries(doc, transaction)
    }
    doc.on('afterTransaction', watch)
    try {
      const done = direction === 'undo' ? this.manager.undo() : this.manager.redo()
      if (done) this.restore(doc, done, emptied, ambiguous)
      return done ? (info ?? null) : null
    } finally {
      doc.off('afterTransaction', watch)
      this.popping = null
    }
  }

  private restore(doc: Y.Doc, step: Popped['item'], emptied: { map: Y.Map<unknown>; key: string }[], ambiguous: { array: Y.Array<unknown>; item: Y.Item }[]): void {
    const writes: { map: Y.Map<unknown>; key: string; value: unknown }[] = []
    for (const { map, key } of emptied) {
      const old = replacedValue(doc, step, map, key)
      if (old) writes.push({ map, key, value: old.value })
    }
    if (writes.length === 0 && ambiguous.length === 0) return
    doc.transact(() => {
      writes.forEach(({ map, key, value }) => map.set(key, value))
      for (const { array, item } of ambiguous) {
        let index = 0
        for (let at = array._start; at !== null && at !== item; at = at.right) if (!at.deleted) index += at.length
        const values = item.content.getContent()
        array.delete(index, values.length)
        array.insert(index, values)
      }
    }, REPAIR_ORIGIN)
  }

  status(): HistoryStatus {
    const undo = this.manager.undoStack[this.manager.undoStack.length - 1]
    const redo = this.manager.redoStack[this.manager.redoStack.length - 1]
    return {
      canUndo: this.manager.canUndo(),
      canRedo: this.manager.canRedo(),
      undoLabel: (undo?.meta.get('info') as StepInfo | undefined)?.label ?? null,
      redoLabel: (redo?.meta.get('info') as StepInfo | undefined)?.label ?? null,
    }
  }

  /** Forgets every step (the design was replaced under the user). */
  clear(): void {
    this.manager.clear()
    this.sealed = true
    this.pending = null
    this.onChange()
  }

  destroy(): void {
    this.manager.destroy()
  }
}
