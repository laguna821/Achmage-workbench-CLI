import { useEffect, useMemo, useRef, useState } from 'react'
import { type DocPage, type DoryDocument, MAX_DIMENSION_PX } from '@/types/document'
import { getPageSize } from '../engine/pageSizes'
import { useLatest } from '../hooks/useLatest'
import { canvasToBlob } from '../engine/render'
import { type ChannelLike, canLink, openLink, type PagePreview, type PresenterLink, type ViewCommand } from './channel'
import type { FrameCache } from './frames'
import type { SlideshowAction, SlideshowState } from './machine'
import { pageNotes } from './pageProps'
import { NOTES_MAX_LENGTH } from './timing'
import { t } from '../strings'

/** How often the state is re-sent while a presenter view is connected, so its clocks stay true. */
const HEARTBEAT_MS = 1000

export interface ViewHostOptions {
  session: string
  title: string
  /** The pages of the presentation and their sizes (the snapshot the slideshow works on). */
  doc: DoryDocument
  /** Seconds per page under auto-advance (`null` = waits), as the slideshow uses them. */
  durations: readonly (number | null)[]
  state: SlideshowState
  dispatch: (action: SlideshowAction) => void
  onExit: () => void
  /** Renders the small pictures the view shows. Separate from the stage's cache: different sizes. */
  previews: FrameCache
  /** Tests stand in for BroadcastChannel. */
  createChannel?: (name: string) => ChannelLike | null
}

export interface ViewHost {
  /** The browser can link two windows at all. */
  supported: boolean
  /** A presenter view has said hello and has not left. */
  connected: boolean
}

export function previewsOf(doc: DoryDocument, durations: readonly (number | null)[]): PagePreview[] {
  return doc.pages.map((page: DocPage, index) => {
    const size = getPageSize(doc, page.id)
    return {
      id: page.id,
      // The channel refuses oversized values, so what a hand-made document holds is cut to what it can carry.
      name: (page.name ?? '').trim().slice(0, 200),
      notes: pageNotes(page).slice(0, NOTES_MAX_LENGTH),
      durationSec: durations[index] ?? null,
      width: Math.min(MAX_DIMENSION_PX, size.width),
      height: Math.min(MAX_DIMENSION_PX, size.height),
    }
  })
}

function actionOf(command: ViewCommand): SlideshowAction | 'exit' {
  switch (command.action) {
    case 'next':
    case 'prev':
    case 'first':
    case 'last':
    case 'restart':
      return { type: command.action }
    case 'toggle-pause':
      return { type: 'togglePause' }
    case 'toggle-loop':
      return { type: 'toggleLoop' }
    case 'toggle-blackout':
      return { type: 'toggleBlackout' }
    case 'goto':
      return { type: 'goto', index: command.index }
    case 'exit':
      return 'exit'
  }
}

function currentTheme(): 'light' | 'dark' | null {
  const theme = document.documentElement.dataset.theme
  return theme === 'light' || theme === 'dark' ? theme : null
}

/**
 * The audience window's side of the presenter view: answers its hello with everything it needs, sends the state when
 * it changes (and every second), renders the pictures it asks for and carries out its commands.
 */
export function useViewHost(options: ViewHostOptions): ViewHost {
  const { session, createChannel } = options
  const latest = useLatest(options)
  const previews = useMemo(() => previewsOf(options.doc, options.durations), [options.doc, options.durations])
  const previewsRef = useLatest(previews)
  const [connected, setConnected] = useState(false)
  const supported = createChannel !== undefined || canLink()
  const linkRef = useRef<PresenterLink | null>(null)

  useEffect(() => {
    const opened = openLink(session, 'show', createChannel)
    linkRef.current = opened
    if (!opened) return
    const off = opened.subscribe((message) => {
      const o = latest.current
      switch (message.kind) {
        case 'hello':
          setConnected(true)
          opened.send({ kind: 'init', title: o.title.slice(0, 300) || t.untitled, theme: currentTheme(), pages: previewsRef.current, state: o.state })
          break
        case 'command': {
          const action = actionOf(message.command)
          if (action === 'exit') o.onExit()
          else o.dispatch(action)
          break
        }
        case 'need-frame':
          void sendFrame(opened, o.previews, o.doc.pages.find((p) => p.id === message.pageId), message.width)
          break
        case 'bye':
          setConnected(false)
          break
        default:
          break
      }
    })
    // A closed tab never unmounts: tell the view then too.
    const leave = (): void => opened.send({ kind: 'bye' })
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      leave()
      off()
      opened.close()
      linkRef.current = null
    }
  }, [session, createChannel, latest, previewsRef])

  // The state goes out when something other than a clock changed, and again every second while a view is listening.
  const { index, ended, autoAdvance, paused, loop, blackout } = options.state
  useEffect(() => {
    if (connected) linkRef.current?.send({ kind: 'state', state: latest.current.state })
  }, [connected, index, ended, autoAdvance, paused, loop, blackout, latest])
  useEffect(() => {
    if (!connected) return
    const timer = window.setInterval(() => linkRef.current?.send({ kind: 'state', state: latest.current.state }), HEARTBEAT_MS)
    return () => window.clearInterval(timer)
  }, [connected, latest])

  return { supported, connected }
}

async function sendFrame(link: PresenterLink, cache: FrameCache, page: DocPage | undefined, width: number): Promise<void> {
  if (!page) return
  try {
    const canvas = await cache.get(page, width)
    const image = await canvasToBlob(canvas, 'image/png')
    link.send({ kind: 'frame', pageId: page.id, width, image })
  } catch {
    /* the view keeps showing "Loading…" for this page and asks again when it needs it */
  }
}
