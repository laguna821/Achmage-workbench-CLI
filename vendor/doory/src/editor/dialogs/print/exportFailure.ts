import { isApiError } from '@/lib/api'
import { t } from '../../strings'

/** What went wrong with a download, in the terms the dialog acts on. */
export type ExportFailureKind = 'busy' | 'timeout' | 'unavailable' | 'disabled' | 'failed' | 'font' | 'page' | 'too-large' | 'rate-limited' | 'signed-out' | 'offline' | 'invalid' | 'unknown'

export interface ExportFailure {
  kind: ExportFailureKind
  message: string
  /** What to do about it. */
  hint?: string
  /** Seconds the service asked to wait before the next try (a busy or throttled service). */
  retryAfter: number | null
  /** Trying the same download again can work (the cause may pass); false when it needs a change first. */
  retryable: boolean
}

const DEFAULT_BUSY_SECONDS = 5

const failure = (kind: ExportFailureKind, message: string, hint?: string, retryAfter: number | null = null, retryable = true): ExportFailure => ({ kind, message, hint, retryAfter, retryable })

/** True when the user cancelled: nothing to show. */
export function isCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Maps what a download threw (an API error from the print service, or a message of the browser-side export) to text. */
export function describeExportFailure(error: unknown): ExportFailure {
  if (!isApiError(error)) {
    const message = error instanceof Error && error.message ? error.message : t.dialog.downloadFailed
    return failure('unknown', message)
  }
  const p = t.print.problems
  if (error.isNetwork) return failure('offline', p.offline)
  switch (error.code) {
    case 'export_busy':
      return failure('busy', p.busy, p.busyHint, error.retryAfter ?? DEFAULT_BUSY_SECONDS)
    case 'export_timeout':
      return failure('timeout', p.timeout, p.timeoutHint)
    case 'export_unavailable':
      return failure('unavailable', p.unavailable, p.unavailableHint)
    case 'server_pdf_disabled':
      return failure('disabled', p.disabled, p.disabledHint, null, false)
    case 'export_failed':
      return failure('failed', p.failed, p.failedHint)
    case 'invalid_font':
      return failure('font', p.font(error.message), p.fontHint, null, false)
    case 'invalid_svg':
      return failure('page', error.message, p.pageHint, null, false)
    case 'payload_too_large':
      return failure('too-large', p.tooLarge, p.tooLargeHint, null, false)
  }
  if (error.status === 401) return failure('signed-out', p.signedOut, p.signedOutHint, null, false)
  if (error.status === 413) return failure('too-large', p.tooLarge, p.tooLargeHint, null, false)
  if (error.isRateLimited) return failure('rate-limited', p.rateLimited, undefined, error.retryAfter)
  if (error.status === 400) return failure('invalid', p.invalid(error.fieldError('sizes') ?? error.fieldError('fonts') ?? error.message), undefined, null, false)
  if (error.status >= 500) return failure('failed', p.failed, p.failedHint)
  return failure('unknown', error.message || t.dialog.downloadFailed)
}
