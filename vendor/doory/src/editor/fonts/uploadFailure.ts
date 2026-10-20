import { isApiError } from '@/lib/api'
import type { UserFontErrorCode } from '@/types/api'
import { t } from '../strings'
import type { FontFileProblem } from './fontFile'

/** What went wrong with an upload, in the terms the dialog acts on. */
export type UploadFailureKind =
  | 'variant-exists'
  | 'name-taken'
  | 'limit'
  | 'storage'
  | 'invalid'
  | 'too-large'
  | 'rate-limited'
  | 'signed-out'
  | 'offline'
  | 'unknown'

export interface UploadFailure {
  kind: UploadFailureKind
  message: string
}

/** Failures that will hit every file of the batch: the dialog stops sending instead of repeating them. */
const SYSTEMIC: ReadonlySet<UploadFailureKind> = new Set<UploadFailureKind>(['limit', 'storage', 'rate-limited', 'signed-out', 'offline'])

export function isSystemicFailure(failure: UploadFailure): boolean {
  return SYSTEMIC.has(failure.kind)
}

const CODES: Record<UserFontErrorCode, { kind: UploadFailureKind; message: string }> = {
  variant_exists: { kind: 'variant-exists', message: t.userFonts.errors.variantExists },
  font_name_taken: { kind: 'name-taken', message: t.userFonts.errors.nameTaken },
  font_limit_reached: { kind: 'limit', message: t.userFonts.errors.limit },
  font_storage_limit: { kind: 'storage', message: t.userFonts.errors.storage },
}

function isFontErrorCode(code: string): code is UserFontErrorCode {
  return code in CODES
}

/** The server prefixes file errors with the file name ("brand.ttf: the font has no outlines."); the row already shows it. */
export function withoutFileName(message: string, fileName: string): string {
  const prefix = `${fileName}: `
  if (!message.startsWith(prefix)) return message
  const text = message.slice(prefix.length)
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Maps a failed `POST /fonts/mine/` to a message the user can act on. `fileName` is the file that was sent. */
export function describeUploadFailure(error: unknown, fileName: string): UploadFailure {
  if (!isApiError(error)) return { kind: 'unknown', message: t.userFonts.errors.unknown }
  if (isFontErrorCode(error.code)) return CODES[error.code]
  if (error.isNetwork) return { kind: 'offline', message: t.userFonts.errors.offline }
  if (error.status === 401) return { kind: 'signed-out', message: t.userFonts.errors.signedOut }
  if (error.status === 413) return { kind: 'too-large', message: t.userFonts.errors.tooLarge }
  if (error.isRateLimited) return { kind: 'rate-limited', message: t.userFonts.errors.rateLimited(error.retryAfter) }
  if (error.status === 400) {
    const detail = error.fieldError('files') ?? error.fieldError('family') ?? error.message
    return { kind: 'invalid', message: withoutFileName(detail || t.userFonts.errors.invalid, fileName) }
  }
  return { kind: 'unknown', message: error.status >= 500 ? error.message : t.userFonts.errors.unknown }
}

const PROBLEMS: Record<FontFileProblem, string> = {
  empty: t.userFonts.problems.empty,
  'too-large': t.userFonts.problems.tooLarge,
  unsupported: t.userFonts.problems.unsupported,
  collection: t.userFonts.problems.collection,
  corrupt: t.userFonts.problems.corrupt,
}

/** The message for a file the dialog refused before sending it. */
export function describeFileProblem(problem: FontFileProblem): string {
  return PROBLEMS[problem]
}
