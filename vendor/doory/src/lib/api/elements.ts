import type { ElementItem, ElementPack, ElementQuery, Page } from '@/types/api'
import { http } from './client'
import { toList } from './pagination'

export const elementsApi = {
  packs: async (signal?: AbortSignal): Promise<ElementPack[]> => toList(await http.get<ElementPack[] | Page<ElementPack>>('/elements/packs/', { signal })),
  list: (query: ElementQuery = {}, signal?: AbortSignal) => http.get<Page<ElementItem>>('/elements/', { query, signal }),
}
