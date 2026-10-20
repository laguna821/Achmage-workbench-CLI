import type { FolderT, Page } from '@/types/api'
import { http } from './client'
import { toList } from './pagination'

export const foldersApi = {
  list: async (signal?: AbortSignal): Promise<FolderT[]> => toList(await http.get<Page<FolderT> | FolderT[]>('/folders/', { query: { page_size: 100 }, signal })),
  create: (input: { name: string; parent?: string | null }) => http.post<FolderT>('/folders/', { json: input }),
  rename: (id: string, name: string) => http.patch<FolderT>(`/folders/${id}/`, { json: { name } }),
  move: (id: string, parent: string | null) => http.patch<FolderT>(`/folders/${id}/`, { json: { parent } }),
  remove: (id: string) => http.delete<void>(`/folders/${id}/`),
}
