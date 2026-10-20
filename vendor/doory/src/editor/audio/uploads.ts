/** The audio files uploaded or recorded in this editing session, so the Uploads tab shows them at once and keeps them when you switch tabs. */
import { useSyncExternalStore } from 'react'
import type { AssetRef } from '@/types/adapter'
import { useEditor } from '../context'
import type { EditorEngine } from '../engine/editor'

export interface UploadedAudio {
  ref: AssetRef
  durationMs: number
  size: number
}

export interface UploadsState {
  items: readonly UploadedAudio[]
  /** Files being stored right now. */
  busy: number
  /** The name of the file being read, for the status line. */
  reading: string | null
}

const EMPTY: UploadsState = { items: [], busy: 0, reading: null }

export class UploadsStore {
  private state: UploadsState = EMPTY
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): UploadsState => this.state

  private set(patch: Partial<UploadsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  add(item: UploadedAudio): void {
    this.set({ items: [item, ...this.state.items.filter((i) => i.ref.id !== item.ref.id)] })
  }

  remove(id: string): void {
    this.set({ items: this.state.items.filter((i) => i.ref.id !== id) })
  }

  begin(name: string): void {
    this.set({ busy: this.state.busy + 1, reading: name })
  }

  end(): void {
    this.set({ busy: Math.max(0, this.state.busy - 1), reading: this.state.busy <= 1 ? null : this.state.reading })
  }
}

const stores = new WeakMap<EditorEngine, UploadsStore>()

export function uploadsOf(editor: EditorEngine): UploadsStore {
  let store = stores.get(editor)
  if (!store) {
    store = new UploadsStore()
    stores.set(editor, store)
  }
  return store
}

export function useUploads(): UploadsState {
  const store = uploadsOf(useEditor())
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
