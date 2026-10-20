import type { AppConfig } from '@/types/api'
import { http } from './client'

/** Conservative defaults used until (or if) `/config/` cannot be loaded: no optional features. */
export const DEFAULT_CONFIG: AppConfig = {
  google_client_id: '',
  features: { stock_photos: false, server_pdf: false, google_login: false, email_verification: false, background_removal: false },
  limits: { max_upload_bytes: 10 * 1024 * 1024, max_pages: 100, max_document_bytes: 12 * 1024 * 1024 },
  assets: { background_removal_model: null },
}

export const configApi = {
  get: (signal?: AbortSignal) => http.get<AppConfig>('/config/', { signal }),
}
