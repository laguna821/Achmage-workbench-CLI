/** Loads the peaks a waveform is drawn from: the catalogue's for a library sound (at once), else from the decoded file. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AudioTrack } from '@/types/document'
import { useEditor } from '../context'
import { catalogueStore } from './library'
import { type Peaks, peaksFor, peaksFromCatalogue } from './peaks'

export type WaveformState = { status: 'loading'; peaks: Peaks | null } | { status: 'ready'; peaks: Peaks } | { status: 'error'; peaks: Peaks | null }

/**
 * Peaks of `track`'s source. A library track shows the catalogue's coarse peaks immediately; with `precise` the decoded
 * file's finer peaks replace them (needed by the trim editor, not by a thumbnail). Uploads and recordings are decoded.
 */
export function useWaveform(track: Pick<AudioTrack, 'src' | 'name' | 'libraryId' | 'durationMs'>, options: { precise?: boolean } = {}): WaveformState {
  const editor = useEditor()
  const precise = options.precise ?? true
  const catalogue = useSyncExternalStore(catalogueStore.subscribe, catalogueStore.getSnapshot)
  const known = useMemo(() => {
    if (catalogue.status !== 'ready' || !track.libraryId) return null
    const entry = catalogue.catalogue.entries.find((e) => e.id === track.libraryId && e.url === track.src)
    return entry && entry.peaks.length > 0 ? peaksFromCatalogue(entry.peaks, entry.durationMs) : null
  }, [catalogue, track.libraryId, track.src])
  const [state, setState] = useState<WaveformState>({ status: 'loading', peaks: null })
  const library = track.libraryId !== undefined

  useEffect(() => {
    if (!precise && known) return
    let cancelled = false
    const key = track.src
    peaksFor(
      key,
      () => editor.audio.sources.loadSrc(track.src, track.name),
      { persist: !library },
    ).then(
      (peaks) => {
        if (!cancelled) setState({ status: 'ready', peaks })
      },
      () => {
        if (!cancelled) setState({ status: 'error', peaks: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [editor, track.src, track.name, library, precise, known])

  if (state.status === 'ready') return state
  if (known) return { status: state.status === 'error' ? 'error' : 'loading', peaks: known }
  return state
}
