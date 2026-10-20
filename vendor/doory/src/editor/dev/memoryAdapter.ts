/**
 * In-memory `EditorAdapter` for the dev harness and tests: no network, uploads become object URLs, and the
 * catalogs (fonts, elements, templates) are small fakes. It records every call so e2e specs can assert on
 * saves and uploads through `window.__doory`.
 */
import { newId } from '@/lib/document'
import type { AssetRef, EditorAdapter, SaveInput, SaveResult } from '@/types/adapter'
import type { ElementItem, ElementPack, FontFamily, Page } from '@/types/api'
import type { DoryDocument } from '@/types/document'
import { readImageSize } from '../engine/assets'
import { createBlankDemo } from './demoDocument'
import { createAccountFakes, createTemplatesService } from './fakeCatalog'
import { type CommentRole, type MemoryCommentsHandle, createMemoryComments } from './memoryComments'
import { createMemoryUserFonts } from './memoryFonts'

function page<T>(results: T[], q?: { page?: number; page_size?: number }): Page<T> {
  const size = q?.page_size ?? 50
  const start = ((q?.page ?? 1) - 1) * size
  const slice = results.slice(start, start + size)
  return { count: results.length, next: start + size < results.length ? 'next' : null, previous: null, results: slice }
}

const FONT_NAMES: { family: string; category: FontFamily['category'] }[] = [
  { family: 'DejaVu Sans', category: 'sans-serif' },
  { family: 'Liberation Sans', category: 'sans-serif' },
  { family: 'FreeSans', category: 'sans-serif' },
  { family: 'DejaVu Serif', category: 'serif' },
  { family: 'Liberation Serif', category: 'serif' },
  { family: 'FreeSerif', category: 'serif' },
  { family: 'DejaVu Sans Mono', category: 'monospace' },
  { family: 'Liberation Mono', category: 'monospace' },
  { family: 'FreeMono', category: 'monospace' },
]

const FONTS: FontFamily[] = FONT_NAMES.map((f, i) => ({
  id: `font-${i}`,
  family: f.family,
  category: f.category,
  scripts: ['latin'],
  is_variable: false,
  is_user_font: false,
  variants: [],
  popularity: 100 - i,
}))

const svgUrl = (body: string, w = 100, h = 100): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`)}`

interface FakeElement {
  name: string
  kind: ElementItem['kind']
  body: string
  colors: string[]
}

const ELEMENTS: FakeElement[] = [
  { name: 'Sun', kind: 'illustration', colors: ['#f59e0b', '#fbbf24'], body: '<circle cx="50" cy="50" r="22" fill="#f59e0b"/><g stroke="#fbbf24" stroke-width="6" stroke-linecap="round"><path d="M50 8v12M50 80v12M8 50h12M80 50h12M20 20l8 8M72 72l8 8M80 20l-8 8M28 72l-8 8"/></g>' },
  { name: 'Leaf', kind: 'icon', colors: ['#16a34a'], body: '<path d="M20 80C20 40 45 18 82 18c0 38-22 62-58 62z" fill="#16a34a"/><path d="M20 80 56 44" stroke="#ffffff" stroke-width="4" fill="none" stroke-linecap="round"/>' },
  { name: 'Badge', kind: 'sticker', colors: ['#e11d48', '#ffffff'], body: '<circle cx="50" cy="50" r="40" fill="#e11d48"/><circle cx="50" cy="50" r="31" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="4 4"/><path d="M34 52l11 11 21-24" stroke="#ffffff" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' },
  { name: 'Wave', kind: 'graphic', colors: ['#2563eb'], body: '<path d="M0 55Q12 35 25 55T50 55T75 55T100 55V100H0Z" fill="#2563eb"/>' },
  { name: 'Mountain', kind: 'illustration', colors: ['#475569', '#e2e8f0'], body: '<path d="M0 90 38 28l18 26 14-18 30 54z" fill="#475569"/><path d="M38 28l-9 14 9-5 7 8z" fill="#e2e8f0"/>' },
  { name: 'Frame', kind: 'frame', colors: ['#1c1517'], body: '<rect x="8" y="8" width="84" height="84" rx="6" fill="none" stroke="#1c1517" stroke-width="5"/><rect x="18" y="18" width="64" height="64" rx="3" fill="none" stroke="#1c1517" stroke-width="1.5"/>' },
  { name: 'Spark', kind: 'icon', colors: ['#7c3aed'], body: '<path d="M50 6c4 24 14 34 44 44-30 10-40 20-44 44-4-24-14-34-44-44 30-10 40-20 44-44z" fill="#7c3aed"/>' },
  { name: 'Coffee', kind: 'icon', colors: ['#92400e', '#fef3c7'], body: '<path d="M18 36h54v26a22 22 0 0 1-22 22h-10a22 22 0 0 1-22-22z" fill="#92400e"/><path d="M72 42h8a10 10 0 0 1 0 22h-8" fill="none" stroke="#92400e" stroke-width="6"/><path d="M34 12c-6 8 6 10 0 18M50 12c-6 8 6 10 0 18" stroke="#fef3c7" stroke-width="4" fill="none" stroke-linecap="round"/>' },
]

export interface MemoryAdapterOptions {
  /** Delay applied to `save` (ms) to make in-flight saves observable. */
  saveDelayMs?: number
  /** Provide the account-only services (brand kits, sharing, comments, versions) like a signed-in adapter. */
  account?: boolean
  /** Who looks at the comments: the owner (can resolve and delete any), a commenter (own comments only), or a visitor who is not signed in. */
  commentRole?: CommentRole
  /** Threads to start with: `demo`, or a number of pins spread over the pages. */
  commentSeed?: string | null
}

export interface MemoryAdapterHandle {
  adapter: EditorAdapter
  /** Tells the fake version service where to read the current document from (the mounted editor). */
  bindDocument(getter: () => DoryDocument): void
  saves: SaveInput[]
  uploads: { name: string; size: number }[]
  /** Reasons the editor asked the shell for an account with (`requireAccount`). */
  accountRequests: string[]
  /** Next `save` call rejects with a `RevisionConflictError`. */
  failNextSave(kind: 'conflict' | 'error'): void
  /** The in-memory comments (see `memoryComments.ts`). */
  comments: MemoryCommentsHandle
}

export function createMemoryAdapter(options: MemoryAdapterOptions = {}): MemoryAdapterHandle {
  let currentDocument: (() => DoryDocument) | null = null
  const saves: SaveInput[] = []
  const uploads: { name: string; size: number }[] = []
  const accountRequests: string[] = []
  let failure: 'conflict' | 'error' | null = null
  let revision = 1
  const comments = createMemoryComments({ role: options.commentRole ?? 'owner', getDocument: () => (currentDocument ? currentDocument() : createBlankDemo()), seed: options.commentSeed })
  /** Uploads are addressed as `idb://<id>` the way a guest-mode adapter stores them; this maps ids to object URLs. */
  const objectUrls = new Map<string, string>()
  /** Audio files uploaded in this session, for the Uploads tab of the Audio tool. */
  const audioUploads: { ref: AssetRef; size: number; type: string }[] = []

  const packs: ElementPack[] = [
    { id: 'pack-1', slug: 'starter', name: 'Starter pack', kind: 'illustration', thumbnail_url: null, element_count: ELEMENTS.length, license: 'CC0-1.0', license_url: '', attribution: '', source_url: '' },
  ]
  const elements: ElementItem[] = ELEMENTS.map((e, i) => ({
    id: `el-${i}`,
    name: e.name,
    kind: e.kind,
    style: '',
    pack: { id: 'pack-1', slug: 'starter', name: 'Starter pack' },
    tags: [e.name.toLowerCase()],
    svg_url: svgUrl(e.body),
    width: 100,
    height: 100,
    colors: e.colors,
    is_recolorable: true,
  }))

  const adapter: EditorAdapter = {
    async save(input: SaveInput): Promise<SaveResult> {
      if (options.saveDelayMs) await new Promise((r) => setTimeout(r, options.saveDelayMs))
      if (failure) {
        const kind = failure
        failure = null
        const err = new Error(kind === 'conflict' ? 'Revision conflict' : 'Network down')
        if (kind === 'conflict') err.name = 'RevisionConflictError'
        throw err
      }
      saves.push(input)
      revision += 1
      return { savedAt: Date.now(), revision }
    },
    async requireAccount(reason) {
      accountRequests.push(reason)
      if (reason === 'comment') comments.signIn()
      return true
    },
    async uploadAsset(file: File | Blob, opts?: { name?: string }): Promise<AssetRef> {
      const id = newId()
      const probe = URL.createObjectURL(file)
      if (file.type.startsWith('audio/') || (file instanceof File && /\.(mp3|ogg|wav|m4a|weba|webm)$/i.test(file.name))) {
        objectUrls.set(id, probe)
        const name = opts?.name ?? (file instanceof File ? file.name : 'Audio')
        uploads.push({ name, size: file.size })
        const ref: AssetRef = { id, url: `idb://${id}`, thumbUrl: '', width: 0, height: 0, name, kind: 'audio' }
        audioUploads.push({ ref, size: file.size, type: file.type })
        return ref
      }
      const size = await readImageSize(probe)
      objectUrls.set(id, probe)
      const url = `idb://${id}`
      const name = opts?.name ?? (file instanceof File ? file.name : 'image')
      uploads.push({ name, size: file.size })
      return { id, url, thumbUrl: url, width: size.width, height: size.height, name, kind: file.type === 'image/svg+xml' ? 'svg' : 'image' }
    },
    async resolveSrc(src: string): Promise<string> {
      const match = /^idb:\/\/([0-9a-f-]{36})$/i.exec(src)
      if (!match) return src
      const url = objectUrls.get(match[1].toLowerCase())
      if (!url) throw new Error('Unknown local asset')
      return url
    },
    services: {
      fonts: {
        async list(q) {
          const needle = q.q?.toLowerCase().trim()
          const filtered = FONTS.filter((f) => (!needle || f.family.toLowerCase().includes(needle)) && (!q.category || f.category === q.category))
          return page(filtered, q)
        },
        ...(options.account ? { mine: createMemoryUserFonts({ reserved: FONT_NAMES.map((f) => f.family) }) } : {}),
      },
      elements: {
        async packs() {
          return packs
        },
        async list(q) {
          const needle = q.q?.toLowerCase().trim()
          const filtered = elements.filter((e) => (!needle || e.name.toLowerCase().includes(needle) || e.tags.some((tg) => tg.includes(needle))) && (!q.kind || e.kind === q.kind) && (!q.pack || e.pack.slug === q.pack))
          return page(filtered, q)
        },
      },
      templates: createTemplatesService(),
      assets: {
        async list(q) {
          if (q?.kind !== 'audio') return page([])
          return page(
            audioUploads.map(({ ref, size, type }) => ({ id: ref.id, kind: 'audio' as const, name: ref.name, url: ref.url, thumb_url: '', width: 0, height: 0, size, mime: type, tags: [], attribution: null, duration_ms: null, created_at: new Date(0).toISOString() })),
            q,
          )
        },
        async remove(id) {
          const at = audioUploads.findIndex((u) => u.ref.id === id)
          if (at >= 0) audioUploads.splice(at, 1)
        },
      },
      brand: null,
      stock: null,
      versions: null,
      ...(options.account ? createAccountFakes(() => (currentDocument ? currentDocument() : createBlankDemo()), comments.service) : {}),
    },
  }

  return {
    adapter,
    bindDocument(getter) {
      currentDocument = getter
    },
    saves,
    uploads,
    accountRequests,
    failNextSave(kind) {
      failure = kind
    },
    comments,
  }
}
