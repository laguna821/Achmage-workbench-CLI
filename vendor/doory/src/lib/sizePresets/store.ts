import { useEffect, useSyncExternalStore } from 'react'
import { http } from '@/lib/api/client'
import { BUILTIN_PRESET_TREE } from './builtin'
import { buildCatalogue, type SizePresetCatalogue } from './catalogue'

export const BUILTIN_CATALOGUE = buildCatalogue(BUILTIN_PRESET_TREE) as SizePresetCatalogue

/** How long a page that needs the catalogue (`/create?preset=…`) waits for it before using the built-in one. */
const WAIT_MS = 4000

let current: SizePresetCatalogue = BUILTIN_CATALOGUE
let request: Promise<SizePresetCatalogue> | null = null
const listeners = new Set<() => void>()

function publish(next: SizePresetCatalogue): void {
  current = next
  for (const listener of listeners) listener()
}

/** The catalogue as known now: the server's once it has loaded, the built-in one until then (or if it cannot). */
export function getSizePresets(): SizePresetCatalogue {
  return current
}

/** Loads the server's catalogue once per page load; always resolves, with the built-in catalogue on any failure. */
export function loadSizePresets(): Promise<SizePresetCatalogue> {
  request ??= http
    .get<unknown>('/size-presets/')
    .then((tree) => {
      const loaded = buildCatalogue(tree)
      if (loaded) publish(loaded)
      return current
    })
    .catch(() => current)
  return request
}

/** `loadSizePresets()`, but given up on after a few seconds so a slow server never blocks creating a design. */
export function sizePresetsReady(timeoutMs = WAIT_MS): Promise<SizePresetCatalogue> {
  return Promise.race([loadSizePresets(), new Promise<SizePresetCatalogue>((resolve) => setTimeout(() => resolve(current), timeoutMs))])
}

/** Calls `listener` whenever the catalogue changes (the server's arrives); returns the unsubscribe function. */
export function subscribeSizePresets(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The size preset catalogue; starts loading the server's on first use and re-renders when it arrives. */
export function useSizePresets(): SizePresetCatalogue {
  useEffect(() => {
    void loadSizePresets()
  }, [])
  return useSyncExternalStore(subscribeSizePresets, getSizePresets, getSizePresets)
}

/** Tests: use `catalogue` (or the built-in one) and treat it as loaded, so nothing is fetched. */
export function setSizePresetsForTests(catalogue: SizePresetCatalogue | null = null): void {
  request = Promise.resolve(catalogue ?? BUILTIN_CATALOGUE)
  publish(catalogue ?? BUILTIN_CATALOGUE)
}

/** Tests: forget the loaded catalogue, so the next use fetches it again. */
export function resetSizePresetsForTests(): void {
  request = null
  publish(BUILTIN_CATALOGUE)
}
