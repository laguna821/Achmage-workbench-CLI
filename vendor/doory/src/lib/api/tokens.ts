import type { ApiToken, ApiTokenScope, IssuedApiToken } from '@/types/api'
import { http } from './client'

/** Personal access tokens for AI assistants (the MCP server at /mcp). Managed with the session only. */
export const tokensApi = {
  list: (signal?: AbortSignal) => http.get<ApiToken[]>('/auth/tokens/', { signal }),
  scopes: (signal?: AbortSignal) => http.get<ApiTokenScope[]>('/auth/tokens/scopes/', { signal }),
  /** Creating a token asks for the password (or, for accounts without one, the email address typed out). */
  create: (input: { name: string; scopes: string[]; expires_in_days: number; password?: string; confirm_email?: string }) =>
    http.post<IssuedApiToken>('/auth/tokens/', { json: input }),
  revoke: (id: string) => http.delete<void>(`/auth/tokens/${id}/`),
}
