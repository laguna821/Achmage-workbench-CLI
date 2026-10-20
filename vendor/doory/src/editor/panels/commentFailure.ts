import { isApiError } from '@/lib/api'
import { t } from '../strings'

/** What to tell the person when a comment could not be saved, from what the server (or the network) said. */
export function describeCommentFailure(error: unknown): string {
  if (!isApiError(error)) return t.comments.failed.unknown
  if (error.isNetwork) return t.comments.failed.offline
  if (error.status === 401) return t.comments.failed.signedOut
  if (error.isRateLimited) return t.comments.failed.rateLimited(error.retryAfter)
  if (error.code === 'comment_limit_reached') return t.comments.failed.limit
  if (error.status === 404) return t.comments.failed.gone
  if (error.status === 400 && error.fieldError('body')) return error.fieldError('body') ?? t.comments.failed.unknown
  return t.comments.failed.unknown
}
