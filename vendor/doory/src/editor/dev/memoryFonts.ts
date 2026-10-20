/**
 * An in-memory stand-in for `/fonts/mine/` for the dev harness: uploads are read in the browser (the same reader
 * the upload dialog uses), kept as object URLs and answered with the server's error codes, so the whole font
 * flow can be tried and screenshotted without Django.
 */
import { newId } from '@/lib/document'
import { ApiError } from '@/lib/api/client'
import type { UserFontsService } from '@/types/adapter'
import type { FontFamily, FontVariant } from '@/types/api'
import { cleanFamilyName, readFileBytes, readFontInfo } from '../fonts/fontFile'

const MAX_FAMILIES = 50

export interface MemoryFontsOptions {
  /** Family names a user font may not take (the built-in catalog). */
  reserved?: readonly string[]
  /** Fonts the user already has. */
  initial?: readonly FontFamily[]
}

export function createMemoryUserFonts(options: MemoryFontsOptions = {}): UserFontsService {
  const families = new Map<string, FontFamily>((options.initial ?? []).map((f) => [f.id, f]))
  const reserved = new Set((options.reserved ?? []).map((n) => n.toLowerCase()))

  return {
    async list() {
      return [...families.values()].sort((a, b) => a.family.localeCompare(b.family))
    },
    async upload(input) {
      const added: { variant: FontVariant; family: string }[] = []
      for (const file of input.files) {
        let info
        try {
          info = await readFontInfo(await readFileBytes(file))
        } catch {
          throw new ApiError({ status: 400, code: 'validation_error', message: 'Invalid input.', fields: { files: [`${file.name}: the file could not be parsed as a font.`] } })
        }
        const name = cleanFamilyName(input.family ?? '') || info.family || cleanFamilyName(file.name.replace(/\.[^.]+$/, ''))
        added.push({ family: name, variant: { weight: info.weight ?? 400, style: info.style ?? 'normal', url: URL.createObjectURL(file), subsets: [] } })
      }
      const name = added[0].family
      if (reserved.has(name.toLowerCase())) throw new ApiError({ status: 409, code: 'font_name_taken', message: `A built-in font named "${name}" already exists. Choose a different family name.` })
      const existing = [...families.values()].find((f) => f.family.toLowerCase() === name.toLowerCase())
      if (!existing && families.size >= MAX_FAMILIES) throw new ApiError({ status: 403, code: 'font_limit_reached', message: `You can keep at most ${MAX_FAMILIES} uploaded font families.` })
      const taken = new Set((existing?.variants ?? []).map((v) => `${v.weight}|${v.style}`))
      if (added.some((a) => taken.has(`${a.variant.weight}|${a.variant.style}`))) throw new ApiError({ status: 409, code: 'variant_exists', message: `"${name}" already has that weight and style. Delete it first to replace.` })
      const family: FontFamily = {
        id: existing?.id ?? newId(),
        family: existing?.family ?? name,
        category: existing?.category ?? 'sans-serif',
        scripts: ['latin'],
        is_variable: false,
        is_user_font: true,
        variants: [...(existing?.variants ?? []), ...added.map((a) => a.variant)].sort((a, b) => a.weight - b.weight || (a.style === 'normal' ? -1 : 1)),
        popularity: 9999,
      }
      families.set(family.id, family)
      return family
    },
    async remove(id) {
      families.delete(id)
    },
  }
}
