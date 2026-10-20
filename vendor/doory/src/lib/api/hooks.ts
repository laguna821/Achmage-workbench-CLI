import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type {
  Asset,
  AssetQuery,
  BrandKit,
  BrandKitInput,
  BulkAction,
  DesignCreateInput,
  DesignPatchInput,
  DesignQuery,
  DesignSummary,
  FontFamily,
  FontQuery,
  Page,
  TemplateQuery,
} from '@/types/api'
import { assetsApi } from './assets'
import { brandApi } from './brand'
import { designsApi } from './designs'
import { foldersApi } from './folders'
import { fontsApi } from './fonts'
import { qk } from './keys'
import { nextPageNumber } from './pagination'
import { templatesApi } from './templates'

type DesignPages = InfiniteData<Page<DesignSummary>, number>
type Snapshot = Array<[readonly unknown[], DesignPages | undefined]>

const PAGE_SIZE = 24

/** Applies `update` to every cached design list; returning null removes the design. */
function updateDesignLists(client: QueryClient, ids: ReadonlySet<string>, update: (design: DesignSummary) => DesignSummary | null): void {
  client.setQueriesData<DesignPages>({ queryKey: qk.designs.lists }, (data) => {
    if (!data) return data
    return {
      ...data,
      pages: data.pages.map((page) => {
        const results = page.results.flatMap((design) => (ids.has(design.id) ? (update(design) ?? []) : [design]))
        return { ...page, results, count: Math.max(0, page.count - (page.results.length - results.length)) }
      }),
    }
  })
}

async function snapshotDesignLists(client: QueryClient): Promise<Snapshot> {
  await client.cancelQueries({ queryKey: qk.designs.lists })
  return client.getQueriesData<DesignPages>({ queryKey: qk.designs.lists })
}

function restoreSnapshot(client: QueryClient, snapshot: Snapshot | undefined): void {
  snapshot?.forEach(([key, data]) => client.setQueryData(key, data))
}

export function useDesignsList(query: DesignQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.designs.list(query),
    queryFn: ({ pageParam, signal }) => designsApi.list({ ...query, page: pageParam, page_size: query.page_size ?? PAGE_SIZE }, signal),
    initialPageParam: 1,
    getNextPageParam: (last, _all, current) => nextPageNumber(last, current),
    enabled,
  })
}

export function flattenPages<T>(data: InfiniteData<Page<T>, unknown> | undefined): T[] {
  return data?.pages.flatMap((page) => page.results) ?? []
}

export function useCreateDesign() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: DesignCreateInput) => designsApi.create(input),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.designs.lists }),
  })
}

export function useUpdateDesign() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Pick<DesignPatchInput, 'title' | 'starred' | 'folder'> }) => designsApi.patch(id, patch),
    onMutate: async ({ id, patch }) => {
      const snapshot = await snapshotDesignLists(client)
      updateDesignLists(client, new Set([id]), (design) => ({ ...design, ...patch }))
      return { snapshot }
    },
    onError: (_error, _vars, context) => restoreSnapshot(client, context?.snapshot),
    onSettled: () => client.invalidateQueries({ queryKey: qk.designs.lists }),
  })
}

export function useDuplicateDesign() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => designsApi.duplicate(id),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.designs.lists }),
  })
}

export function useTrashDesign() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => designsApi.trash(id),
    onMutate: async (id) => {
      const snapshot = await snapshotDesignLists(client)
      updateDesignLists(client, new Set([id]), () => null)
      return { snapshot }
    },
    onError: (_error, _id, context) => restoreSnapshot(client, context?.snapshot),
    onSettled: () => client.invalidateQueries({ queryKey: qk.designs.lists }),
  })
}

export function useRestoreDesign() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => designsApi.restore(id),
    onMutate: async (id) => {
      const snapshot = await snapshotDesignLists(client)
      updateDesignLists(client, new Set([id]), () => null)
      return { snapshot }
    },
    onError: (_error, _id, context) => restoreSnapshot(client, context?.snapshot),
    onSettled: () => client.invalidateQueries({ queryKey: qk.designs.lists }),
  })
}

export function useDeleteDesignForever() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => designsApi.deleteForever(id),
    onMutate: async (id) => {
      const snapshot = await snapshotDesignLists(client)
      updateDesignLists(client, new Set([id]), () => null)
      return { snapshot }
    },
    onError: (_error, _id, context) => restoreSnapshot(client, context?.snapshot),
    onSettled: () => client.invalidateQueries({ queryKey: qk.designs.lists }),
  })
}

export function useEmptyTrash() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => designsApi.emptyTrash(),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.designs.lists }),
  })
}

export function useBulkDesigns() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { ids: string[]; action: BulkAction; folder?: string | null }) => designsApi.bulk(input),
    onMutate: async ({ ids, action, folder }) => {
      const snapshot = await snapshotDesignLists(client)
      const set = new Set(ids)
      if (action === 'trash' || action === 'delete' || action === 'restore') updateDesignLists(client, set, () => null)
      else if (action === 'star' || action === 'unstar') updateDesignLists(client, set, (design) => ({ ...design, starred: action === 'star' }))
      else if (action === 'move') updateDesignLists(client, set, (design) => ({ ...design, folder: folder ?? null }))
      return { snapshot }
    },
    onError: (_error, _vars, context) => restoreSnapshot(client, context?.snapshot),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.designs.lists })
      void client.invalidateQueries({ queryKey: qk.folders })
    },
  })
}

export function useFolders(enabled = true) {
  return useQuery({ queryKey: qk.folders, queryFn: ({ signal }) => foldersApi.list(signal), enabled })
}

export function useCreateFolder() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; parent?: string | null }) => foldersApi.create(input),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.folders }),
  })
}

export function useRenameFolder() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => foldersApi.rename(id, name),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.folders }),
  })
}

export function useDeleteFolder() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => foldersApi.remove(id),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: qk.folders }), client.invalidateQueries({ queryKey: qk.designs.lists })]),
  })
}

export function useAssetsList(query: AssetQuery & { ordering?: string }) {
  return useInfiniteQuery({
    queryKey: qk.assets.list(query),
    queryFn: ({ pageParam, signal }) => assetsApi.list({ ...query, page: pageParam, page_size: query.page_size ?? 40 }, signal),
    initialPageParam: 1,
    getNextPageParam: (last, _all, current) => nextPageNumber(last, current),
  })
}

export function useAssetUsage() {
  return useQuery({ queryKey: qk.assets.usage, queryFn: ({ signal }) => assetsApi.usage(signal), retry: false })
}

export function useUpdateAsset() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; tags?: string[] }) => assetsApi.update(id, input),
    onSuccess: (asset: Asset) => {
      client.setQueriesData<InfiniteData<Page<Asset>, number>>({ queryKey: ['assets', 'list'] }, (data) =>
        data ? { ...data, pages: data.pages.map((page) => ({ ...page, results: page.results.map((item) => (item.id === asset.id ? asset : item)) })) } : data,
      )
    },
  })
}

export function useDeleteAsset() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => assetsApi.remove(id),
    onSuccess: (_void, id) => {
      client.setQueriesData<InfiniteData<Page<Asset>, number>>({ queryKey: ['assets', 'list'] }, (data) =>
        data ? { ...data, pages: data.pages.map((page) => ({ ...page, results: page.results.filter((item) => item.id !== id) })) } : data,
      )
      void client.invalidateQueries({ queryKey: qk.assets.usage })
    },
  })
}

export function useBrandKits() {
  return useQuery({ queryKey: qk.brandKits, queryFn: ({ signal }) => brandApi.list(signal) })
}

export function useSaveBrandKit() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: BrandKitInput }): Promise<BrandKit> => (id ? brandApi.update(id, input) : brandApi.create(input)),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.brandKits }),
  })
}

export function useDeleteBrandKit() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => brandApi.remove(id),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.brandKits }),
  })
}

export function useTemplateCategories() {
  return useQuery({ queryKey: qk.templates.categories, queryFn: ({ signal }) => templatesApi.categories(signal), staleTime: 5 * 60_000 })
}

export function useTemplatesList(query: TemplateQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.templates.list(query),
    queryFn: ({ pageParam, signal }) => templatesApi.list({ ...query, page: pageParam, page_size: query.page_size ?? 24 }, signal),
    initialPageParam: 1,
    getNextPageParam: (last, _all, current) => nextPageNumber(last, current),
    enabled,
  })
}

export function useTemplate(slug: string | undefined) {
  return useQuery({
    queryKey: qk.templates.detail(slug ?? ''),
    queryFn: ({ signal }) => templatesApi.get(slug ?? '', signal),
    enabled: Boolean(slug),
    retry: false,
  })
}

export function useFonts(query: FontQuery) {
  return useQuery({ queryKey: qk.fonts(query), queryFn: ({ signal }) => fontsApi.list(query, signal), staleTime: 10 * 60_000 })
}

/** Every family of the catalogue (all pages), for pickers that list them all. */
export function useAllFonts() {
  return useQuery({ queryKey: qk.allFonts, queryFn: ({ signal }) => fontsApi.all(signal), staleTime: 10 * 60_000 })
}

/** The signed-in user's uploaded font families. */
export function useMyFonts(enabled = true) {
  return useQuery({ queryKey: qk.myFonts, queryFn: ({ signal }) => fontsApi.mine(signal), staleTime: 60_000, enabled })
}

/** Puts a family the server just stored (or extended) into the cached list, keeping it sorted by name. */
export function useRememberFont() {
  const client = useQueryClient()
  return (family: FontFamily): void => {
    client.setQueryData<FontFamily[]>(qk.myFonts, (current) =>
      [...(current ?? []).filter((f) => f.id !== family.id), family].sort((a, b) => a.family.localeCompare(b.family)),
    )
  }
}

export function useDeleteFont() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => fontsApi.removeMine(id),
    onSuccess: (_result, id) => client.setQueryData<FontFamily[]>(qk.myFonts, (current) => current?.filter((f) => f.id !== id)),
  })
}
