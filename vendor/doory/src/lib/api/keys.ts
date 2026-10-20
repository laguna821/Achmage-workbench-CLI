import type { AssetQuery, DesignQuery, FontQuery, TemplateQuery } from '@/types/api'

/** TanStack Query keys, grouped so invalidation can target a whole family. */
export const qk = {
  designs: {
    all: ['designs'] as const,
    lists: ['designs', 'list'] as const,
    list: (query: DesignQuery) => ['designs', 'list', query] as const,
    detail: (id: string) => ['designs', 'detail', id] as const,
  },
  folders: ['folders'] as const,
  assets: {
    all: ['assets'] as const,
    list: (query: AssetQuery) => ['assets', 'list', query] as const,
    usage: ['assets', 'usage'] as const,
  },
  brandKits: ['brand-kits'] as const,
  templates: {
    categories: ['templates', 'categories'] as const,
    lists: ['templates', 'list'] as const,
    list: (query: TemplateQuery) => ['templates', 'list', query] as const,
    detail: (slug: string) => ['templates', 'detail', slug] as const,
  },
  fonts: (query: FontQuery) => ['fonts', query] as const,
  myFonts: ['fonts', 'mine'] as const,
  allFonts: ['fonts', 'all'] as const,
}
