import { ChevronLeft, ChevronRight, Keyboard, Maximize, Minimize, MonitorOff, MonitorPlay, MousePointer2, Pause, Play, Repeat, RotateCcw, StickyNote, Timer, Volume2, VolumeX, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SlideshowAction, SlideshowState } from '../presenter/machine'
import type { ShowSound } from '../presenter/useShowAudio'
import { t } from '../strings'
import { Tooltip } from '../ui/Tooltip'
import styles from './Presenter.module.css'

interface ControlProps {
  label: string
  /** Not offered on a phone (it needs a keyboard, a pop-up window or a mouse); every control keeps its shortcut. */
  phoneHidden?: boolean
  shortcut?: string
  pressed?: boolean
  disabled?: boolean
  testId: string
  onClick: () => void
  children: ReactNode
}

function Control({ label, phoneHidden, shortcut, pressed, disabled, testId, onClick, children }: ControlProps) {
  return (
    <span className={styles.slot} data-phone-hidden={phoneHidden || undefined}>
      <Tooltip label={label} shortcut={shortcut} side="top" disabled={disabled}>
        <button type="button" className={styles.ctl} aria-label={label} aria-pressed={pressed} disabled={disabled} data-testid={testId} onClick={onClick}>
          {children}
        </button>
      </Tooltip>
    </span>
  )
}

/** A run of related controls; a thin rule separates it from the one before. */
function Group({ children }: { children: ReactNode }) {
  return <div className={styles.group}>{children}</div>
}

interface PresenterControlsProps {
  state: SlideshowState
  count: number
  /** What the page countdown reads: "0:03 left", "Waits for you", or nothing while auto-advance is off. */
  countdown: string | null
  notesOpen: boolean
  laser: boolean
  fullscreen: boolean
  canFullscreen: boolean
  viewOpen: boolean
  /** The sound of the show, or `null` when the design has none (the control is then not offered). */
  sound: ShowSound | null
  dispatch: (action: SlideshowAction) => void
  onNotes: () => void
  onLaser: () => void
  onFullscreen: () => void
  onView: () => void
  onHelp: () => void
  onExit: () => void
}

/** The control pill at the bottom of the stage. It fades while the pointer rests and is back at the first movement or focus. */
export function PresenterControls(p: PresenterControlsProps) {
  const { state, count, dispatch } = p
  const running = state.autoAdvance && !state.paused
  return (
    <div className={styles.controls} role="toolbar" aria-label={t.presenter.controls} data-testid="present-controls">
      <Group>
        <Control label={t.presenter.previous} shortcut="ArrowLeft" disabled={state.index === 0 && !state.ended} testId="present-prev" onClick={() => dispatch({ type: 'prev' })}>
          <ChevronLeft size={20} aria-hidden="true" />
        </Control>
        <span className={styles.count} aria-live="off" data-testid="present-counter">
          {t.presenter.pageOf(Math.min(count, state.index + 1), count)}
        </span>
        <Control label={t.presenter.next} shortcut="ArrowRight" disabled={state.ended} testId="present-next" onClick={() => dispatch({ type: 'next' })}>
          <ChevronRight size={20} aria-hidden="true" />
        </Control>
      </Group>
      <Group>
        <Control label={t.presenter.autoAdvance} pressed={state.autoAdvance} testId="present-auto" onClick={() => dispatch({ type: 'setAutoAdvance', on: !state.autoAdvance })}>
          <Timer size={18} aria-hidden="true" />
        </Control>
        {state.autoAdvance ? (
          <>
            <Control label={running ? t.presenter.pause : t.presenter.resume} shortcut="P" testId="present-pause" onClick={() => dispatch({ type: 'togglePause' })}>
              {running ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
            </Control>
            {p.countdown ? (
              <span className={styles.countdown} data-testid="present-countdown">
                {state.paused ? t.presenter.paused : p.countdown}
              </span>
            ) : null}
          </>
        ) : null}
        <Control label={t.presenter.loop} phoneHidden pressed={state.loop} testId="present-loop" onClick={() => dispatch({ type: 'toggleLoop' })}>
          <Repeat size={18} aria-hidden="true" />
        </Control>
        <Control label={t.presenter.restart} phoneHidden shortcut="R" testId="present-restart" onClick={() => dispatch({ type: 'restart' })}>
          <RotateCcw size={18} aria-hidden="true" />
        </Control>
      </Group>
      <Group>
        <Control label={t.presenter.laser} phoneHidden shortcut="L" pressed={p.laser} testId="present-laser" onClick={p.onLaser}>
          <MousePointer2 size={18} aria-hidden="true" />
        </Control>
        <Control label={t.presenter.blackout} shortcut="B" pressed={state.blackout} disabled={state.ended} testId="present-blackout" onClick={() => dispatch({ type: 'toggleBlackout' })}>
          <MonitorOff size={18} aria-hidden="true" />
        </Control>
        {p.sound ? (
          <Control label={t.audio.presenter.sound} shortcut="M" pressed={!p.sound.muted} testId="present-sound" onClick={() => p.sound?.setMuted(!p.sound.muted)}>
            {p.sound.muted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
          </Control>
        ) : null}
        <Control label={t.presenter.notes} shortcut="N" pressed={p.notesOpen} testId="present-notes-toggle" onClick={p.onNotes}>
          <StickyNote size={18} aria-hidden="true" />
        </Control>
        <Control label={t.presenter.presenterView} phoneHidden pressed={p.viewOpen} testId="present-view" onClick={p.onView}>
          <MonitorPlay size={18} aria-hidden="true" />
        </Control>
      </Group>
      <Group>
        <Control label={t.presenter.fullscreen} phoneHidden shortcut="F" pressed={p.fullscreen} disabled={!p.canFullscreen} testId="present-fullscreen" onClick={p.onFullscreen}>
          {p.fullscreen ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}
        </Control>
        <Control label={t.presenter.help} phoneHidden shortcut="?" testId="present-help" onClick={p.onHelp}>
          <Keyboard size={18} aria-hidden="true" />
        </Control>
        <Control label={t.presenter.exit} shortcut="Escape" testId="present-exit" onClick={p.onExit}>
          <X size={20} aria-hidden="true" />
        </Control>
      </Group>
    </div>
  )
}
