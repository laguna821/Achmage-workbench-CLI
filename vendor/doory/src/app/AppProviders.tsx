import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { ToastProvider } from '@/ui'
import { createQueryClient } from './queryClient'

/** Provider stack shared by the app and by integration tests. */
export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [fallbackClient] = useState(createQueryClient)
  return (
    <QueryClientProvider client={client ?? fallbackClient}>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}
