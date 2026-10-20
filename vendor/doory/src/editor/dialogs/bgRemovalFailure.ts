import { isApiError } from '@/lib/api'
import type { AiOption } from '@/types/api'
import { BackgroundRemovalError, type BgRemovalFailure } from '../engine/bgRemoval'
import { t } from '../strings'

const FAILURE_MESSAGE: Record<BgRemovalFailure, string> = {
  unavailable: t.errors.bgRemoval,
  blocked: t.errors.bgRemovalBlocked,
  'no-subject': t.errors.bgRemovalNoSubject,
}

/** What went wrong, in words, and whether trying the same option again could help. */
export function describeFailure(error: unknown, option: AiOption): { message: string; retry: boolean } {
  if (option.kind === 'device' || !isApiError(error)) {
    const reason = error instanceof BackgroundRemovalError ? error.reason : 'unavailable'
    return { message: FAILURE_MESSAGE[reason], retry: reason !== 'no-subject' }
  }
  const e = t.bgRemoval.errors
  const wait = error.retryAfter ? t.bgRemoval.wait(error.retryAfter) : null
  const own = option.owner === 'user'
  switch (error.code.replace(/^ai_/, '')) {
    case 'timeout':
      return { message: e.timeout, retry: true }
    case 'unreachable':
      return { message: e.unreachable, retry: true }
    case 'busy':
      return { message: e.busy, retry: true }
    case 'quota':
      return { message: e.quota(wait), retry: false }
    case 'throttled':
      return { message: e.throttled(wait), retry: true }
    case 'auth_failed':
      return { message: own ? e.ownAuthFailed : e.authFailed, retry: false }
    case 'bad_response':
    case 'not_image':
      return { message: e.badResponse, retry: true }
    case 'too_large':
      return { message: e.tooLarge, retry: false }
    case 'refused_address':
      return { message: e.refusedAddress, retry: false }
    case 'secret_unreadable':
      return { message: e.secretUnreadable, retry: false }
    case 'model_not_found':
    case 'runs_on_device':
      return { message: e.modelGone, retry: false }
    case 'unsupported_asset':
      return { message: e.unsupported, retry: false }
    case 'network_error':
      return { message: e.network, retry: true }
    default:
      return { message: error.isRateLimited ? e.throttled(wait) : e.generic, retry: true }
  }
}
