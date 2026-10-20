import { isApiError } from '@/lib/api'

export interface FormFailure {
  /** A message for the whole form (shown in an alert). */
  message: string
  /** Messages keyed by field name. */
  fields: Record<string, string>
}

/** "Too many attempts. Please try again in 45 seconds." (falls back to a generic wait when unknown). */
export function rateLimitMessage(retryAfter: number | null): string {
  if (!retryAfter) return 'Too many attempts. Please wait a minute and try again.'
  if (retryAfter < 90) return `Too many attempts. Please try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`
  const minutes = Math.ceil(retryAfter / 60)
  return `Too many attempts. Please try again in ${minutes} minutes.`
}

/** Turns any thrown error into something a form can show. `known` lists the field names the form renders. */
export function describeFormError(error: unknown, known: readonly string[]): FormFailure {
  if (!isApiError(error)) return { message: 'Something went wrong. Please try again.', fields: {} }
  if (error.isRateLimited) return { message: rateLimitMessage(error.retryAfter), fields: {} }
  const fields: Record<string, string> = {}
  const leftovers: string[] = []
  for (const [name, messages] of Object.entries(error.fields)) {
    const text = messages.join(' ')
    if (known.includes(name)) fields[name] = text
    else leftovers.push(text)
  }
  if (Object.keys(fields).length > 0 && leftovers.length === 0) return { message: '', fields }
  return { message: leftovers[0] ?? error.message, fields }
}
