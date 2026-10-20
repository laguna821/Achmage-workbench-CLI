import type { CommentInput, CommentMove, CommentT, Page } from '@/types/api'
import { http } from './client'
import { toList } from './pagination'

/** The server's largest page; a design holds at most 2000 comments, so at most 20 pages. */
const PAGE_SIZE = 100
const MAX_PAGES = 20

const passwordHeaders = (password?: string): Record<string, string> | undefined => (password ? { 'X-Share-Password': password } : undefined)
const sharedPath = (token: string): string => `/shared/${encodeURIComponent(token)}/comments/`

/** Follows `next` until every comment is in: a design with more than 100 comments must not lose the rest. */
async function listAll(path: string, headers?: Record<string, string>): Promise<CommentT[]> {
  const all: CommentT[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await http.get<Page<CommentT> | CommentT[]>(path, { query: { page, page_size: PAGE_SIZE }, headers })
    all.push(...toList(data))
    if (Array.isArray(data) || !data.next) break
  }
  return all
}

export const commentsApi = {
  listShared: (token: string, password?: string): Promise<CommentT[]> => listAll(sharedPath(token), passwordHeaders(password)),
  createShared: (token: string, input: CommentInput, password?: string) => http.post<CommentT>(sharedPath(token), { json: input, headers: passwordHeaders(password) }),
  /** The author moves their own pin through a comment or edit link. */
  moveShared: (token: string, commentId: string, to: CommentMove, password?: string) => http.patch<CommentT>(`${sharedPath(token)}${commentId}/`, { json: to, headers: passwordHeaders(password) }),
  /** The author deletes their own comment through any valid link of the design. */
  removeShared: (token: string, commentId: string, password?: string) => http.delete<void>(`${sharedPath(token)}${commentId}/`, { headers: passwordHeaders(password) }),
  list: (designId: string): Promise<CommentT[]> => listAll(`/designs/${designId}/comments/`),
  create: (designId: string, input: CommentInput) => http.post<CommentT>(`/designs/${designId}/comments/`, { json: input }),
  resolve: (designId: string, commentId: string, resolved: boolean) => http.patch<CommentT>(`/designs/${designId}/comments/${commentId}/`, { json: { resolved } }),
  /** Owner: moves a thread (its replies follow). */
  move: (designId: string, commentId: string, to: CommentMove) => http.patch<CommentT>(`/designs/${designId}/comments/${commentId}/`, { json: to }),
  remove: (designId: string, commentId: string) => http.delete<void>(`/designs/${designId}/comments/${commentId}/`),
}
