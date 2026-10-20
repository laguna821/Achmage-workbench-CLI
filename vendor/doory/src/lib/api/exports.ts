import type { PdfExportInput } from '@/types/api'
import { http } from './client'

export const exportsApi = {
  /** Server-side vector PDF (account only); one SVG file per page. */
  pdf: (input: PdfExportInput) => {
    const form = new FormData()
    input.pages.forEach((page, index) => form.append('pages', page, `page-${index + 1}.svg`))
    form.append('width', String(Math.round(input.width)))
    form.append('height', String(Math.round(input.height)))
    // One entry per `pages` file, same order: pages of a design may differ in size.
    if (input.sizes?.length) form.append('sizes', JSON.stringify(input.sizes.map((s) => ({ width: Math.round(s.width), height: Math.round(s.height) }))))
    if (input.bleedMm !== undefined) form.append('bleed_mm', String(input.bleedMm))
    if (input.cropMarks !== undefined) form.append('crop_marks', input.cropMarks ? 'true' : 'false')
    if (input.title) form.append('title', input.title)
    if (input.lang) form.append('lang', input.lang)
    if (input.fonts?.length) form.append('fonts', JSON.stringify(input.fonts))
    return http.postForBlob('/exports/pdf/', { form, signal: input.signal, onUploadProgress: input.onUploadProgress })
  },
}
