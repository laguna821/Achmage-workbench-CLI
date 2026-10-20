import type { Design, Page, TemplateCategory, TemplateDetail, TemplateQuery, TemplateSummary } from '@/types/api'
import { http } from './client'
import { toList } from './pagination'

export const templatesApi = {
  categories: async (signal?: AbortSignal): Promise<TemplateCategory[]> => toList(await http.get<TemplateCategory[] | Page<TemplateCategory>>('/template-categories/', { signal })),
  list: (query: TemplateQuery = {}, signal?: AbortSignal) => http.get<Page<TemplateSummary>>('/templates/', { query, signal }),
  get: (slug: string, signal?: AbortSignal) => http.get<TemplateDetail>(`/templates/${encodeURIComponent(slug)}/`, { signal }),
  /** Creates an account design from the template (login required). */
  use: (slug: string) => http.post<Design>(`/templates/${encodeURIComponent(slug)}/use/`),
}
