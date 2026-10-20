import { isApiError } from '@/lib/api'

/** A short, user-presentable description of any thrown error. */
export function errorMessage(error: unknown, fallback = 'Please try again.'): string {
  if (isApiError(error)) return error.isNetwork ? 'You seem to be offline.' : error.message
  return fallback
}
