import { lazy, Suspense } from 'react'

/** The slideshow is only needed when somebody presents: it loads on first use, not with the editor. */
const Presenter = lazy(() => import('./Presenter').then((m) => ({ default: m.Presenter })))

/** The `presenter` dialog (see `Presenter.tsx`), loaded on demand. */
export function PresenterDialog({ props }: { props?: Record<string, unknown> }) {
  return (
    <Suspense fallback={null}>
      <Presenter props={props} />
    </Suspense>
  )
}
