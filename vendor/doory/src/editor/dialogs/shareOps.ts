import type { ShareLink, ShareRole } from '@/types/api'

export const SHARE_ROLES: readonly ShareRole[] = ['view', 'comment', 'edit']

export type Expiry = 'never' | '1d' | '7d' | '30d'
export const EXPIRIES: readonly Expiry[] = ['never', '1d', '7d', '30d']

const DAY = 86_400_000
const DAYS: Record<Exclude<Expiry, 'never'>, number> = { '1d': 1, '7d': 7, '30d': 30 }

/** ISO timestamp for a link that should stop working after `expiry`, or null for a link that never expires. */
export function expiryDate(expiry: Expiry, now: number): string | null {
  return expiry === 'never' ? null : new Date(now + DAYS[expiry] * DAY).toISOString()
}

/** The address of a share link as a full URL (the server may answer with a path). */
export function absoluteUrl(url: string, origin: string): string {
  try {
    return new URL(url, origin).toString()
  } catch {
    return url
  }
}

export type LinkStatus = 'active' | 'off' | 'expired'

export function linkStatus(link: Pick<ShareLink, 'is_active' | 'expires_at'>, now: number): LinkStatus {
  if (link.expires_at && Date.parse(link.expires_at) <= now) return 'expired'
  return link.is_active ? 'active' : 'off'
}

/** A password worth setting (6 to 128 characters). It travels in an HTTP header, so only printable ASCII is allowed, like the server's rule. */
export function validPassword(password: string): boolean {
  return password.length >= 6 && password.length <= 128 && /^[\x20-\x7e]+$/.test(password)
}
