import { QueryClient } from '@tanstack/react-query'
import { isApiError } from '@/lib/api'

/** Retry only transient failures; 4xx answers are final. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  if (isApiError(error)) return error.isNetwork || error.status >= 500
  return false
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetry },
      mutations: { retry: false },
    },
  })
}
