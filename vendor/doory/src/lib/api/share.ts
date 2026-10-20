import type { DoryDocument } from '@/types/document'
import type { Page, ShareLink, ShareLinkInput, ShareRole, SharedDesign } from '@/types/api'
import { http } from './client'
import { toList } from './pagination'

const SHARE_PASSWORD_HEADER = 'X-Share-Password'

function passwordHeaders(password?: string): Record<string, string> | undefined {
  return password ? { [SHARE_PASSWORD_HEADER]: password } : undefined
}

export const shareApi = {
  listLinks: async (designId: string): Promise<ShareLink[]> => toList(await http.get<ShareLink[] | Page<ShareLink>>(`/designs/${designId}/share-links/`)),
  createLink: (designId: string, input: ShareLinkInput) => http.post<ShareLink>(`/designs/${designId}/share-links/`, { json: input }),
  /** `password: null` removes the password, `expires_at: null` makes the link permanent. */
  updateLink: (designId: string, linkId: string, input: { role?: ShareRole; is_active?: boolean; expires_at?: string | null; password?: string | null }) =>
    http.patch<ShareLink>(`/designs/${designId}/share-links/${linkId}/`, { json: input }),
  revokeLink: (designId: string, linkId: string) => http.delete<void>(`/designs/${designId}/share-links/${linkId}/`),
  /** Public. Password-protected links answer 403 `password_required`/`invalid_password` until a password is sent. */
  getShared: (token: string, password?: string, signal?: AbortSignal) =>
    http.get<SharedDesign>(`/shared/${encodeURIComponent(token)}/`, { headers: passwordHeaders(password), signal, silentUnauthorized: true }),
  saveShared: (token: string, input: { document: DoryDocument; base_revision: number }, password?: string) =>
    http.patch<{ revision: number; updated_at: string }>(`/shared/${encodeURIComponent(token)}/`, { json: input, headers: passwordHeaders(password) }),
}
