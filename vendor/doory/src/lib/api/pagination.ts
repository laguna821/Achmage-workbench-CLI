import type { Page } from '@/types/api'

/** Some list endpoints (e.g. folders) may answer a bare array or a paginated envelope. */
export function toList<T>(data: Page<T> | T[]): T[] {
  return Array.isArray(data) ? data : data.results
}

/** Next page number from a DRF `next` URL, or null. */
export function nextPageNumber(page: Pick<Page<unknown>, 'next'>, current: number): number | null {
  return page.next ? current + 1 : null
}
