/**
 * The presenter view: the second window of "Present with notes". It shows the current page, the next page, the
 * current page's notes at a size the speaker picks, the clocks, and controls that drive the audience window. It holds
 * no document and loads no fonts: everything arrives over the channel (see `../channel.ts`), pictures included, so it
 * works the same for guests, shared links and designs of any size.
 */
import { ChevronLeft, ChevronRight, MonitorOff, Minus, Pause, Play, Plus, Repeat, RotateCcw, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { t } from '../../strings'
import type { ChannelLike, PagePreview } from '../channel'
import { fitContain } from '../fit'
import { actionForKey, isActivationKey } from '../keymap'
import { formatClock } from '../timing'
import { useElementSize } from '../useElementSize'
import { bestFrame, configOf, extrapolate, frameWidthFor, pageClock, VIEW_TICK_MS } from './model'
import { type Show, useShow } from './useShow'
import styles from './PresenterView.module.css'

const NOTES_SIZES = [14, 18, 22, 28, 36, 48, 64] as const
const DEFAULT_SIZE_INDEX = 3
const SIZE_KEY = 'doory.presenterView.notesSize'

function storedSizeIndex(): number {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    const n = raw === null ? Number.NaN : Number(raw)
    return Number.isInteger(n) && n >= 0 && n < NOTES_SIZES.length ? n : DEFAULT_SIZE_INDEX
  } catch {
    return DEFAULT_SIZE_INDEX
  }
}

interface PreviewProps {
  which: string
  index: number
  page: PagePreview | undefined
  frames: Show['frames']
  request: Show['request']
  testId: string
  /** Shown instead of a page (the end of the presentation). */
  empty?: string
}

/** One page picture, letterboxed in its box by the page's own size; asks the audience window for the picture it needs. */
function Preview({ which, index, page, frames, request, testId, empty }: PreviewProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const fit = page ? fitContain(size, page) : null
  const wanted = fit ? frameWidthFor(fit.width, dpr) : 0
  const pageId = page?.id
  useEffect(() => {
    if (pageId && wanted > 0) request(pageId, wanted)
  }, [pageId, wanted, request])
  const frame = page && wanted > 0 ? bestFrame(frames.get(page.id) ?? [], wanted) : null
  return (
    <div ref={ref} className={styles.box} data-testid={testId}>
      {page && fit && fit.width > 0 ? (
        <div className={styles.picture} style={{ left: fit.x, top: fit.y, width: fit.width, height: fit.height }} data-testid={`${testId}-picture`}>
          {frame ? <img src={frame.url} alt={t.presenterView.previewAlt(which, index + 1, page.name)} draggable={false} /> : <span className={styles.loading}>{t.presenterView.previewLoading}</span>}
        </div>
      ) : (
        <p className={styles.endOfShow}>{empty}</p>
      )}
    </div>
  )
}

interface PresenterViewProps {
  /** The session id from the address (`?session=`), or null when there is none. */
  session: string | null
  /** Tests stand in for BroadcastChannel. */
  createChannel?: (name: string) => ChannelLike | null
}

export function PresenterView({ session, createChannel }: PresenterViewProps) {
  const link = useShow(session, createChannel)
  const { phase, show, lost, frames, send, request } = link
  const [now, setNow] = useState(() => performance.now())
  const [sizeIndex, setSizeIndex] = useState(storedSizeIndex)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), VIEW_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const showTitle = show?.title
  const showTheme = show?.theme
  useEffect(() => {
    if (showTitle !== undefined) document.title = t.presenterView.pageTitle(showTitle)
    if (showTheme) document.documentElement.dataset.theme = showTheme
  }, [showTitle, showTheme])

  const changeSize = useCallback((delta: number): void => {
    setSizeIndex((i) => {
      const next = Math.min(NOTES_SIZES.length - 1, Math.max(0, i + delta))
      try {
        localStorage.setItem(SIZE_KEY, String(next))
      } catch {
        /* the size is only remembered for this window */
      }
      return next
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (phase !== 'live' && phase !== 'ended') return
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '+' || e.key === '=' || e.key === '-')) {
        e.preventDefault()
        changeSize(e.key === '-' ? -1 : 1)
        return
      }
      const action = actionForKey(e)
      if (!action || phase !== 'live') return
      if (isActivationKey(e.key) && e.target instanceof Element && e.target.closest('button, a, input, textarea, select')) return
      const command = { next: 'next', prev: 'prev', first: 'first', last: 'last', togglePause: 'toggle-pause', toggleBlackout: 'toggle-blackout', restart: 'restart', exit: 'exit' } as const
      const name = action in command ? command[action as keyof typeof command] : null
      if (!name) return
      e.preventDefault()
      send({ action: name })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [phase, send, changeSize])

  const config = useMemo(() => (show ? configOf(show.pages) : null), [show])
  const state = show && config ? extrapolate(config, show.state, now - show.receivedAt) : null

  if (phase === 'invalid' || phase === 'unsupported') {
    return (
      <main className={styles.card}>
        <h1>{t.presenterView.title}</h1>
        <p role="alert">{phase === 'invalid' ? t.presenterView.invalid : t.presenterView.unsupported}</p>
      </main>
    )
  }
  if (!show || !state || !config) {
    return (
      <main className={styles.card} data-testid="view-connecting">
        <h1>{t.presenterView.title}</h1>
        <p role="status">{t.presenterView.connecting}</p>
        <p className={styles.hint}>{t.presenterView.connectingHint}</p>
      </main>
    )
  }

  const count = show.pages.length
  const index = Math.min(state.index, count - 1)
  const page = show.pages[index]
  const nextPage = state.ended || index + 1 >= count ? (state.loop && !state.ended ? show.pages[0] : undefined) : show.pages[index + 1]
  const clock = pageClock(config, state)
  const running = state.autoAdvance && !state.paused
  const finished = phase === 'ended'

  return (
    <div className={styles.view} data-testid="view-root">
      <header className={styles.header}>
        <h1 className={styles.title}>{show.title}</h1>
        <span className={styles.position} data-testid="view-counter">
          {t.presenterView.pageOfTotal(index + 1, count)}
        </span>
        <span className={styles.total} title={t.presenterView.elapsed}>
          <span className={styles.label}>{t.presenterView.elapsed}</span>
          <strong data-testid="view-elapsed">{formatClock(state.totalMs)}</strong>
        </span>
      </header>

      {lost && !finished ? (
        <p className={styles.lost} role="alert" data-testid="view-lost">
          {t.presenterView.lost}
        </p>
      ) : null}

      <main className={styles.grid}>
        <section className={styles.current} aria-label={t.presenterView.current}>
          <h2 className={styles.label}>{t.presenterView.current}</h2>
          <Preview which={t.presenterView.current} index={index} page={state.ended ? undefined : page} frames={frames} request={request} testId="view-current" empty={t.presenterView.endOfShow} />
          <div className={styles.timer} data-testid="view-timer">
            <div className={styles.bar} aria-hidden="true">
              <span style={{ transform: `scaleX(${clock.kind === 'running' ? clock.progress : 0})` }} />
            </div>
            <span className={styles.timerText} data-kind={clock.kind}>
              {clock.kind === 'running'
                ? t.presenterView.remaining(formatClock(Math.ceil(clock.remainingMs / 1000) * 1000))
                : clock.kind === 'waits'
                  ? t.presenterView.waits
                  : clock.kind === 'paused'
                    ? t.presenterView.pausedNote
                    : t.presenterView.off}
              {state.blackout ? ` · ${t.presenterView.blackoutNote}` : ''}
            </span>
          </div>
        </section>

        <aside className={styles.side}>
          <section className={styles.next} aria-label={t.presenterView.next}>
            <h2 className={styles.label}>{nextPage ? t.presenterView.next : t.presenterView.lastPage}</h2>
            <Preview which={t.presenterView.next} index={nextPage ? show.pages.indexOf(nextPage) : index} page={nextPage} frames={frames} request={request} testId="view-next" empty={t.presenterView.endOfShow} />
          </section>
          <section className={styles.notes} aria-label={t.presenterView.notes}>
            <div className={styles.notesHead}>
              <h2 className={styles.label}>{t.presenterView.notes}</h2>
              <span className={styles.sizer}>
                <button type="button" className={styles.mini} aria-label={t.presenterView.smaller} disabled={sizeIndex === 0} data-testid="view-smaller" onClick={() => changeSize(-1)}>
                  <Minus size={14} aria-hidden="true" />
                </button>
                <span className={styles.sizeValue} aria-label={t.presenterView.textSize(NOTES_SIZES[sizeIndex])} data-testid="view-size">
                  {NOTES_SIZES[sizeIndex]}
                </span>
                <button type="button" className={styles.mini} aria-label={t.presenterView.larger} disabled={sizeIndex === NOTES_SIZES.length - 1} data-testid="view-larger" onClick={() => changeSize(1)}>
                  <Plus size={14} aria-hidden="true" />
                </button>
              </span>
            </div>
            <div className={styles.notesBody} tabIndex={0} aria-label={t.presenterView.notes} style={{ fontSize: NOTES_SIZES[sizeIndex] }} data-testid="view-notes">
              {state.ended || page.notes.trim() === '' ? <p className={styles.noNotes}>{t.presenterView.noNotes}</p> : page.notes}
            </div>
          </section>
        </aside>
      </main>

      <footer className={styles.controls} role="toolbar" aria-label={t.presenterView.controls}>
        <button type="button" className={styles.ctl} disabled={finished || (index === 0 && !state.ended)} data-testid="view-prev" onClick={() => send({ action: 'prev' })}>
          <ChevronLeft size={18} aria-hidden="true" />
          <span>{t.presenter.previous}</span>
        </button>
        <button type="button" className={`${styles.ctl} ${styles.primary}`} disabled={finished || state.ended} data-testid="view-next-button" onClick={() => send({ action: 'next' })}>
          <span>{t.presenter.next}</span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <span className={styles.gap} aria-hidden="true" />
        <button type="button" className={styles.ctl} disabled={finished} data-testid="view-pause" onClick={() => send({ action: 'toggle-pause' })}>
          {running ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
          <span>{!state.autoAdvance ? t.presenter.autoAdvance : running ? t.presenter.pause : t.presenter.resume}</span>
        </button>
        <button type="button" className={styles.ctl} disabled={finished} aria-pressed={state.loop} data-testid="view-loop" onClick={() => send({ action: 'toggle-loop' })}>
          <Repeat size={18} aria-hidden="true" />
          <span>{t.presenter.loop}</span>
        </button>
        <button type="button" className={styles.ctl} disabled={finished} data-testid="view-restart" onClick={() => send({ action: 'restart' })}>
          <RotateCcw size={18} aria-hidden="true" />
          <span>{t.presenter.startAgain}</span>
        </button>
        <button type="button" className={styles.ctl} disabled={finished || state.ended} aria-pressed={state.blackout} data-testid="view-blackout" onClick={() => send({ action: 'toggle-blackout' })}>
          <MonitorOff size={18} aria-hidden="true" />
          <span>{t.presenter.blackout}</span>
        </button>
        <span className={styles.gap} aria-hidden="true" />
        <button type="button" className={`${styles.ctl} ${styles.danger}`} disabled={finished} data-testid="view-exit" onClick={() => send({ action: 'exit' })}>
          <Square size={16} aria-hidden="true" />
          <span>{t.presenterView.endShow}</span>
        </button>
      </footer>

      {finished ? (
        <div className={styles.ended} role="alertdialog" aria-label={t.presenterView.ended} data-testid="view-ended">
          <div className={styles.card}>
            <h1>{t.presenterView.ended}</h1>
            <p>{t.presenterView.endedHint}</p>
            <button type="button" className={`${styles.ctl} ${styles.primary}`} onClick={() => window.close()}>
              {t.presenterView.closeWindow}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
