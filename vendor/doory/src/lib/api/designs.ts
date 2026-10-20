import type { BulkAction, BulkFillInput, BulkFillResult, Design, DesignCreateInput, DesignPatchInput, DesignQuery, DesignSummary, Page, TemplateField, VersionDetail, VersionSummary } from '@/types/api'
import { http } from './client'

export const designsApi = {
  list: (query: DesignQuery = {}, signal?: AbortSignal) => http.get<Page<DesignSummary>>('/designs/', { query, signal }),
  get: (id: string, signal?: AbortSignal) => http.get<Design>(`/designs/${id}/`, { signal }),
  create: (input: DesignCreateInput) => http.post<Design>('/designs/', { json: input }),
  patch: (id: string, input: DesignPatchInput) => http.patch<Design>(`/designs/${id}/`, { json: input }),
  /** Soft delete (moves to trash). */
  trash: (id: string) => http.delete<void>(`/designs/${id}/`),
  /** Hard delete; only valid for designs already in the trash. */
  deleteForever: (id: string) => http.delete<void>(`/designs/${id}/`, { query: { permanent: true } }),
  restore: (id: string) => http.post<Design>(`/designs/${id}/restore/`),
  duplicate: (id: string) => http.post<Design>(`/designs/${id}/duplicate/`),
  uploadThumbnail: (id: string, image: Blob) => {
    const form = new FormData()
    form.append('image', image, image.type === 'image/png' ? 'thumbnail.png' : 'thumbnail.webp')
    return http.put<{ thumbnail_url: string }>(`/designs/${id}/thumbnail/`, { form })
  },
  bulk: (input: { ids: string[]; action: BulkAction; folder?: string | null }) => http.post<{ affected: number }>('/designs/bulk/', { json: input }),
  fields: (id: string) => http.get<TemplateField[]>(`/designs/${id}/fields/`),
  /** One new design per row, filled by field key; each row reports its design or its error. */
  bulkFill: (id: string, input: BulkFillInput) => http.post<BulkFillResult>(`/designs/${id}/bulk-fill/`, { json: input }),
  emptyTrash: () => http.delete<void>('/designs/trash/'),
  versions: {
    list: (designId: string) => http.get<Page<VersionSummary>>(`/designs/${designId}/versions/`),
    create: (designId: string, label: string) => http.post<VersionSummary>(`/designs/${designId}/versions/`, { json: { label } }),
    get: (designId: string, versionId: string) => http.get<VersionDetail>(`/designs/${designId}/versions/${versionId}/`),
    restore: (designId: string, versionId: string) => http.post<Design>(`/designs/${designId}/versions/${versionId}/restore/`),
  },
}
