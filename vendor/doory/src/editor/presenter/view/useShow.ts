import { useCallback, useEffect, useRef, useState } from 'react'
import { canLink, type ChannelLike, isSessionId, openLink, type PagePreview, type PresenterLink, type ViewCommand } from '../channel'
import type { SlideshowState } from '../machine'
import { type ReceivedFrame, SIGNAL_LOST_MS } from './model'

export type Phase = 'connecting' | 'live' | 'ended' | 'unsupported' | 'invalid'

export interface ShowSnapshot {
  title: string
  theme: 'light' | 'dark' | null
  pages: PagePreview[]
  state: SlideshowState
  /** `performance.now()` when `state` arrived: the view's clocks run on from there. */
  receivedAt: number
}

export interface Show {
  phase: Phase
  show: ShowSnapshot | null
  /** No message for a while: the audience window may be gone. */
  lost: boolean
  /** Pictures received so far, per page id. */
  frames: ReadonlyMap<string, readonly ReceivedFrame[]>
  send(command: ViewCommand): void
  /** Asks for a picture of the page at that width unless it is already here or was asked for a moment ago. */
  request(pageId: string, width: number): void
}

/** Pictures kept at once (the current page, the next, the one after, at a couple of sizes). */
const MAX_FRAMES = 8
/** A picture request that got no answer is asked again after this long. */
const REQUEST_RETRY_MS = 3000
const HELLO_EVERY_MS = 1500

/**
 * The presenter view's side of the conversation (see `channel.ts`): says hello until the presentation answers, keeps
 * the latest state and the pictures it is sent, notices when the presentation ends or goes quiet.
 */
export function useShow(session: string | null, createChannel?: (name: string) => ChannelLike | null): Show {
  const initial: Phase = !isSessionId(session) ? 'invalid' : createChannel === undefined && !canLink() ? 'unsupported' : 'connecting'
  const [phase, setPhase] = useState<Phase>(initial)
  const [show, setShow] = useState<ShowSnapshot | null>(null)
  const [lost, setLost] = useState(false)
  const [frames, setFrames] = useState<ReadonlyMap<string, readonly ReceivedFrame[]>>(() => new Map())
  const linkRef = useRef<PresenterLink | null>(null)
  const lastSeen = useRef(0)
  const phaseRef = useRef(phase)
  const asked = useRef(new Map<string, number>())
  const urls = useRef<{ pageId: string; width: number; url: string }[]>([])

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    if (initial !== 'connecting' || !session) return
    const link = openLink(session, 'view', createChannel)
    linkRef.current = link
    if (!link) return
    const stored = urls.current
    const off = link.subscribe((message) => {
      lastSeen.current = performance.now()
      setLost(false)
      switch (message.kind) {
        case 'init':
          setShow({ title: message.title, theme: message.theme, pages: message.pages, state: message.state, receivedAt: performance.now() })
          setPhase('live')
          break
        case 'state':
          setShow((cur) => (cur ? { ...cur, state: message.state, receivedAt: performance.now() } : cur))
          break
        case 'frame': {
          const url = URL.createObjectURL(message.image)
          const same = stored.findIndex((f) => f.pageId === message.pageId && f.width === message.width)
          if (same >= 0) URL.revokeObjectURL(stored.splice(same, 1)[0].url)
          stored.push({ pageId: message.pageId, width: message.width, url })
          while (stored.length > MAX_FRAMES) URL.revokeObjectURL(stored.shift()?.url ?? '')
          const next = new Map<string, ReceivedFrame[]>()
          for (const f of stored) next.set(f.pageId, [...(next.get(f.pageId) ?? []), { width: f.width, url: f.url }])
          setFrames(next)
          break
        }
        case 'bye':
          setPhase('ended')
          break
        default:
          break
      }
    })
    const hello = (): void => {
      if (phaseRef.current === 'connecting') link.send({ kind: 'hello' })
    }
    hello()
    const helloTimer = window.setInterval(hello, HELLO_EVERY_MS)
    const watchdog = window.setInterval(() => {
      if (phaseRef.current === 'live' && performance.now() - lastSeen.current > SIGNAL_LOST_MS) setLost(true)
    }, 1000)
    const leave = (): void => link.send({ kind: 'bye' })
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      window.clearInterval(helloTimer)
      window.clearInterval(watchdog)
      leave()
      off()
      link.close()
      linkRef.current = null
      for (const f of stored.splice(0)) URL.revokeObjectURL(f.url)
    }
  }, [session, createChannel, initial])

  const send = useCallback((command: ViewCommand) => linkRef.current?.send({ kind: 'command', command }), [])
  const request = useCallback(
    (pageId: string, width: number) => {
      const key = `${pageId}@${width}`
      if (frames.get(pageId)?.some((f) => f.width === width)) return
      const at = asked.current.get(key)
      if (at !== undefined && performance.now() - at < REQUEST_RETRY_MS) return
      asked.current.set(key, performance.now())
      linkRef.current?.send({ kind: 'need-frame', pageId, width })
    },
    [frames],
  )

  return { phase: initial === 'connecting' ? phase : initial, show, lost, frames, send, request }
}
