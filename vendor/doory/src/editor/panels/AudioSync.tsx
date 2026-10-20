/**
 * Headless glue between the editor and the audio runtime, mounted by `AudioSyncHost` while the design has sound:
 *
 *  - The timeline's playhead drives the sound of the page: play starts it from the playhead, pause pauses it, a scrub or
 *    a loop restart moves it, stop (or the end of the page) silences it. Sound plays at normal speed only; at another
 *    speed of the timeline the page plays without it.
 */
import { useEffect } from 'react'
import { useEditor } from '../context'
import { playbackOf, type PlaybackState } from '../animation/playback'
import { audioRuntime } from '../audio/runtime'

/** A jump of the playhead bigger than this while playing is a seek (the clock itself moves by about a frame). */
const SEEK_MS = 250
/** The sound may start later than the picture (files load first); beyond this it is moved to the playhead. */
const DRIFT_MS = 150

export function AudioSync() {
  const editor = useEditor()

  useEffect(() => {
    const playback = playbackOf(editor)
    const { player } = audioRuntime(editor)
    let previous: PlaybackState = playback.state
    /** The page the timeline's sound is playing, or null when the timeline does not own the player. */
    let owned: string | null = null

    const pageStart = (pageId: string): number => player.clock().pages.find((p) => p.pageId === pageId)?.startMs ?? 0
    const release = (): void => {
      if (owned === null) return
      owned = null
      player.stop()
    }

    const start = (s: PlaybackState): void => {
      const pageId = editor.state.activePageId
      const range = { mode: 'page', pageId } as const
      if (s.speed !== 1 || !player.hasAudio(range)) return
      owned = pageId
      void player.play(range, pageStart(pageId) + s.timeMs)
    }

    const stopListening = playback.subscribe(() => {
      const s = playback.state
      const p = previous
      previous = s
      if (!s.active) {
        release()
        return
      }
      if (owned !== null && owned !== editor.state.activePageId) release()
      if (s.speed !== 1) {
        release()
        return
      }
      if (s.playing && !p.playing) {
        if (owned !== null && player.getSnapshot().status === 'paused') {
          void player.resume()
        } else {
          release()
          start(s)
        }
        return
      }
      if (!s.playing && p.playing) {
        if (owned !== null) void player.pause()
        return
      }
      if (owned !== null && s.timeMs !== p.timeMs && (s.timeMs < p.timeMs || Math.abs(s.timeMs - p.timeMs) > SEEK_MS)) {
        void player.seek(pageStart(owned) + s.timeMs)
      }
    })

    // The sound may come up later than the picture: once it plays, put it where the playhead is.
    const stopFollowing = player.subscribe(() => {
      const state = player.getSnapshot()
      if (owned === null || state.status !== 'playing' || !playback.state.playing) return
      const wanted = pageStart(owned) + playback.state.timeMs
      if (Math.abs(state.positionMs - wanted) > DRIFT_MS) void player.seek(wanted)
    })

    return () => {
      stopListening()
      stopFollowing()
      release()
    }
  }, [editor])

  return null
}
