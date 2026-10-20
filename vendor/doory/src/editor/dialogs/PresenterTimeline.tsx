import { type SlideshowAction, type SlideshowConfig, type SlideshowState, pageProgress } from '../presenter/machine'
import { t } from '../strings'
import styles from './Presenter.module.css'

interface PresenterTimelineProps {
  config: SlideshowConfig
  state: SlideshowState
  dispatch: (action: SlideshowAction) => void
}

/**
 * One segment per page along the bottom edge: pages already shown are filled, the current page fills as its time runs
 * out while auto-advance is on, and a click on a segment goes to that page.
 */
export function PresenterTimeline({ config, state, dispatch }: PresenterTimelineProps) {
  const progress = pageProgress(config, state)
  return (
    <nav className={styles.timeline} aria-label={t.presenter.timeline} data-testid="present-timeline">
      {Array.from({ length: config.count }, (_, i) => {
        const done = state.ended || i < state.index
        const current = !state.ended && i === state.index
        return (
          <button
            key={i}
            type="button"
            className={styles.segment}
            aria-label={t.presenter.goToPage(i + 1)}
            aria-current={current ? 'step' : undefined}
            data-state={done ? 'done' : current ? 'current' : 'todo'}
            tabIndex={current ? 0 : -1}
            onClick={() => dispatch({ type: 'goto', index: i })}
          >
            <span className={styles.fill} style={current ? { transform: `scaleX(${state.autoAdvance ? progress : 1})` } : undefined} />
          </button>
        )
      })}
    </nav>
  )
}
