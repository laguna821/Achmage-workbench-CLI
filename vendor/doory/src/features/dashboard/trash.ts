export const TRASH_RETENTION_DAYS = 30

/** Whole days left before a trashed design is purged (never negative). */
export function daysUntilPurge(trashedAt: string, now: number = Date.now()): number {
  const trashed = Date.parse(trashedAt)
  if (!Number.isFinite(trashed)) return TRASH_RETENTION_DAYS
  const remaining = TRASH_RETENTION_DAYS - Math.floor((now - trashed) / 86_400_000)
  return Math.max(0, Math.min(TRASH_RETENTION_DAYS, remaining))
}
