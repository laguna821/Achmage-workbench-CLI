import { Component, Fragment, lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { LoadFailed, LoadingLines } from './LoadStates'

/** A component whose code is downloaded the first time it is rendered. `preload()` starts the download early. */
export interface Loadable<P extends object> {
  (props: P): ReactNode
  /**
   * Starts the download (hover, focus and idle time call it). A failure is ignored here and shows when the component
   * renders; the promise never rejects and settles once the download has, for callers that must not show anything before.
   */
  preload(): Promise<void>
}

export interface LoadableOptions<P extends object> {
  /** Shown while the code downloads (default: a few skeleton lines); a function gets the props the component was rendered with. */
  fallback?: ReactNode | ((props: P) => ReactNode)
  /** Shown when the download failed; `retry` downloads again. Default: a message with a "Try again" button. */
  failed?: (retry: () => void) => ReactNode
}

interface BoundaryProps {
  onRetry(): void
  failed(retry: () => void): ReactNode
  children: ReactNode
}

/** Catches the rejection of a lazy component's download, so a missing chunk never takes the editor down. */
class LoadBoundary extends Component<BoundaryProps, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  private retry = (): void => {
    this.props.onRetry()
    this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))
  }

  render(): ReactNode {
    // A new key remounts the children, which read the fresh lazy component.
    if (!this.state.failed) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
    return this.props.failed(this.retry)
  }
}

const defaultFailed = (retry: () => void): ReactNode => <LoadFailed onRetry={retry} />

/**
 * Wraps a component that lives in its own chunk, so rarely used parts of the editor (the animation panel, the audio
 * library, comments, uploading fonts …) cost nothing until somebody uses them:
 *
 * ```tsx
 * const AnimatePanel = loadable(() => import('../panels/AnimatePanel').then((m) => m.AnimatePanel))
 * registerPanel({ id: 'animate', component: AnimatePanel, preload: AnimatePanel.preload, … })
 * ```
 *
 * While the chunk is on its way `fallback` is shown (a few skeleton lines by default); when the download fails the
 * person gets a message and a retry button (or whatever `failed` renders) instead of a broken editor.
 */
export function loadable<P extends object>(load: () => Promise<ComponentType<P>>, options: LoadableOptions<P> = {}): Loadable<P> {
  const { fallback = <LoadingLines />, failed = defaultFailed } = options
  const create = () => lazy(async () => ({ default: await load() }))
  let Lazy = create()
  let started: Promise<void> | null = null

  const Body = (props: P): ReactNode => (
    <Suspense fallback={typeof fallback === 'function' ? fallback(props) : fallback}>
      <Lazy {...props} />
    </Suspense>
  )
  const retry = (): void => {
    started = null
    Lazy = create()
  }
  const Wrapper = (props: P): ReactNode => (
    <LoadBoundary onRetry={retry} failed={failed}>
      <Body {...props} />
    </LoadBoundary>
  )
  Wrapper.preload = (): Promise<void> => {
    started ??= load().then(
      () => undefined,
      () => {
        started = null
      },
    )
    return started
  }
  return Wrapper
}
