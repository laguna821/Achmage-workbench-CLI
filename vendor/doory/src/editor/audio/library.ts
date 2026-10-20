/**
 * The audio library as the editor sees it: a static catalogue (`/media/audio/index.json`, written by
 * `manage.py sync_audio`) that is fetched once, kept for offline use, and searched, filtered and previewed entirely in
 * the browser. Nothing here calls the API while the person types.
 *
 * The catalogue is data from the server, so it is read defensively: a row that is not what it should be is left out
 * (never the whole list), text is limited in length, and a file path is only accepted when it stays inside the folder
 * of the catalogue. Everything is rendered as text.
 */
import { fetchCatalogueText, FetchError } from './cache'
import { type NewTrackInput, cleanText } from './model'

export const CATALOGUE_URL = '/media/audio/index.json'

export const MOODS = ['upbeat', 'calm', 'cinematic', 'lofi', 'corporate', 'playful', 'romantic', 'dramatic'] as const
export type Mood = (typeof MOODS)[number]
export const CATEGORIES = ['ui', 'whoosh', 'riser', 'impact', 'magic', 'fun', 'tech', 'nature', 'music', 'voice'] as const
export type Category = (typeof CATEGORIES)[number]
export type LibraryKind = 'music' | 'sfx'

export interface CatalogueEntry {
  id: string
  kind: LibraryKind
  title: string
  mood?: Mood
  category?: Category
  genre: string
  tags: readonly string[]
  bpm?: number
  key?: string
  loop: boolean
  channels: 1 | 2
  durationMs: number
  lufs?: number
  bytes: number
  /** 0..100 values for a waveform before anything is decoded. */
  peaks: readonly number[]
  /** Address of the file (a path on this site). */
  url: string
  /** `doory` for the bundled library, else the id of the pack it came from. */
  source: string
  license: string
}

export interface PackCredit {
  id: string
  name: string
  homepage: string
  license: string
  attribution: string
}

export interface Catalogue {
  release: string
  license: string
  entries: readonly CatalogueEntry[]
  packs: readonly PackCredit[]
  /** True when the network could not be reached and the offline copy is shown. */
  fromCache: boolean
}

export type CatalogueFailure = 'not-installed' | 'unreachable' | 'invalid'

export class CatalogueError extends Error {
  constructor(
    readonly code: CatalogueFailure,
    message: string,
  ) {
    super(message)
    this.name = 'CatalogueError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, limit: number): string => (typeof v === 'string' ? cleanText(v, limit) : '')
const number = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined)
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const FILE = /^[a-z0-9][a-z0-9._/-]{0,200}$/

/** The row as an entry, or null when it is not usable. `base` is the folder of the catalogue (ends with `/`). */
export function readEntry(raw: unknown, base: string): CatalogueEntry | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : null
  const kind = raw.kind === 'music' || raw.kind === 'sfx' ? raw.kind : null
  const file = typeof raw.file === 'string' && FILE.test(raw.file) && !raw.file.split('/').includes('..') && !raw.file.includes('//') ? raw.file : null
  const durationMs = number(raw.durationMs, 20, 3_600_000)
  const title = text(raw.title, 80)
  if (!id || !kind || !file || durationMs === undefined || !title) return null
  const mood = (MOODS as readonly unknown[]).includes(raw.mood) ? (raw.mood as Mood) : undefined
  const category = (CATEGORIES as readonly unknown[]).includes(raw.category) ? (raw.category as Category) : undefined
  if (kind === 'music' ? !mood : !category) return null
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => text(t, 30)).filter(Boolean).slice(0, 8) : []
  const peaks = Array.isArray(raw.peaks) ? raw.peaks.filter((p): p is number => typeof p === 'number' && Number.isFinite(p)).slice(0, 256) : []
  const entry: CatalogueEntry = {
    id,
    kind,
    title,
    genre: text(raw.genre, 40),
    tags,
    loop: raw.loop === true,
    channels: raw.channels === 1 ? 1 : 2,
    durationMs: Math.round(durationMs),
    bytes: Math.round(number(raw.bytes, 0, 100 * 1024 * 1024) ?? 0),
    peaks,
    url: `${base}${file}`,
    source: typeof raw.source === 'string' && ID.test(raw.source) ? raw.source : 'doory',
    license: text(raw.license, 40) || 'CC0-1.0',
  }
  if (mood) entry.mood = mood
  if (category) entry.category = category
  const bpm = number(raw.bpm, 30, 300)
  if (bpm !== undefined) entry.bpm = Math.round(bpm)
  const key = text(raw.key, 30)
  if (key) entry.key = key
  const lufs = number(raw.lufs, -70, 0)
  if (lufs !== undefined) entry.lufs = lufs
  return entry
}

/** Reads the catalogue text. `url` is where it came from (its folder is the base of every file). */
export function parseCatalogue(body: string, url: string = CATALOGUE_URL): Omit<Catalogue, 'fromCache'> {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new CatalogueError('invalid', 'The audio library could not be read.')
  }
  if (!isRecord(raw) || raw.schema !== 1 || !Array.isArray(raw.tracks)) throw new CatalogueError('invalid', 'The audio library has a format this version does not know.')
  const base = url.slice(0, url.lastIndexOf('/') + 1)
  const seen = new Set<string>()
  const entries: CatalogueEntry[] = []
  for (const row of raw.tracks) {
    const entry = readEntry(row, base)
    if (!entry || seen.has(`${entry.source}/${entry.id}`)) continue
    seen.add(`${entry.source}/${entry.id}`)
    entries.push(entry)
  }
  const packs: PackCredit[] = []
  if (Array.isArray(raw.packs)) {
    for (const p of raw.packs) {
      if (!isRecord(p) || typeof p.id !== 'string') continue
      const homepage = typeof p.homepage === 'string' && p.homepage.startsWith('https://') ? p.homepage : ''
      packs.push({ id: p.id, name: text(p.name, 80), homepage, license: isRecord(p.license) ? text(p.license.spdx, 40) : '', attribution: text(p.attribution, 400) })
    }
  }
  const license = isRecord(raw.license) ? text(raw.license.spdx, 40) : ''
  return { release: text(raw.release, 20), license: license || 'CC0-1.0', entries, packs }
}

/** Fetches the catalogue (freshest copy first, the offline copy when the network fails). */
export async function loadCatalogue(options: { url?: string; signal?: AbortSignal } = {}): Promise<Catalogue> {
  const url = options.url ?? CATALOGUE_URL
  let fetched: { text: string; fromCache: boolean }
  try {
    fetched = await fetchCatalogueText(url, options.signal)
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof FetchError && error.status === 404) throw new CatalogueError('not-installed', 'The audio library is not installed on this server.')
    throw new CatalogueError('unreachable', 'The audio library could not be loaded. Check your connection.')
  }
  return { ...parseCatalogue(fetched.text, url), fromCache: fetched.fromCache }
}

/* ------------------------------------------------------------------------------------------ searching */

export type DurationBand = 'any' | 'short' | 'medium' | 'long'

/** Music: under 35 s, 35-45 s, over 45 s. Effects: under 1 s, 1-3 s, over 3 s. */
export function durationBand(kind: LibraryKind, durationMs: number): Exclude<DurationBand, 'any'> {
  const [a, b] = kind === 'music' ? [35_000, 45_000] : [1000, 3000]
  return durationMs < a ? 'short' : durationMs <= b ? 'medium' : 'long'
}

export interface LibraryFilter {
  kind: LibraryKind
  query: string
  /** Music: only this mood. */
  mood?: Mood | null
  /** Effects: only this category. */
  category?: Category | null
  genre?: string | null
  duration?: DurationBand
  sort?: 'featured' | 'title' | 'shortest' | 'longest'
}

const normalise = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
const words = (s: string): string[] => normalise(s).split(/[^a-z0-9#]+/).filter(Boolean)

function score(entry: CatalogueEntry, tokens: readonly string[]): number {
  let total = 0
  const title = words(entry.title)
  const labels = [entry.mood ?? '', entry.category ?? '', entry.genre, entry.key ?? '', ...entry.tags].flatMap(words)
  for (const token of tokens) {
    if (title.some((w) => w.startsWith(token))) total += 4
    else if (title.some((w) => w.includes(token))) total += 2
    else if (labels.some((w) => w.startsWith(token))) total += 3
    else if (labels.some((w) => w.includes(token))) total += 1
    else return 0
  }
  return total
}

/** The entries that match, best first (every word of the query must match something). */
export function filterEntries(entries: readonly CatalogueEntry[], filter: LibraryFilter): CatalogueEntry[] {
  const tokens = words(filter.query)
  const scored: { entry: CatalogueEntry; score: number; index: number }[] = []
  entries.forEach((entry, index) => {
    if (entry.kind !== filter.kind) return
    if (filter.mood && entry.mood !== filter.mood) return
    if (filter.category && entry.category !== filter.category) return
    if (filter.genre && entry.genre !== filter.genre) return
    if (filter.duration && filter.duration !== 'any' && durationBand(entry.kind, entry.durationMs) !== filter.duration) return
    const s = tokens.length ? score(entry, tokens) : 1
    if (s > 0) scored.push({ entry, score: s, index })
  })
  const sort = filter.sort ?? 'featured'
  scored.sort((a, b) => {
    if (sort === 'title') return a.entry.title.localeCompare(b.entry.title)
    if (sort === 'shortest') return a.entry.durationMs - b.entry.durationMs || a.index - b.index
    if (sort === 'longest') return b.entry.durationMs - a.entry.durationMs || a.index - b.index
    return b.score - a.score || a.index - b.index
  })
  return scored.map((s) => s.entry)
}

export interface Facets {
  moods: { value: Mood; count: number }[]
  categories: { value: Category; count: number }[]
  genres: { value: string; count: number }[]
  bands: Record<Exclude<DurationBand, 'any'>, number>
}

/** What the filters can offer for `kind`, with how many entries each would show (in catalogue order). */
export function facetsOf(entries: readonly CatalogueEntry[], kind: LibraryKind): Facets {
  const of = entries.filter((e) => e.kind === kind)
  const count = <T extends string>(values: readonly (T | undefined)[]): { value: T; count: number }[] => {
    const map = new Map<T, number>()
    for (const v of values) if (v) map.set(v, (map.get(v) ?? 0) + 1)
    return [...map].map(([value, n]) => ({ value, count: n }))
  }
  const bands = { short: 0, medium: 0, long: 0 }
  for (const e of of) bands[durationBand(kind, e.durationMs)]++
  return {
    moods: count(of.map((e) => e.mood)).sort((a, b) => MOODS.indexOf(a.value) - MOODS.indexOf(b.value)),
    categories: count(of.map((e) => e.category)).sort((a, b) => CATEGORIES.indexOf(a.value) - CATEGORIES.indexOf(b.value)),
    genres: count(of.map((e) => e.genre || undefined)).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    bands,
  }
}

/** The input for a new track from a catalogue entry (music loops loop; effects play once). */
export function trackInputFor(entry: CatalogueEntry, scope: NewTrackInput['scope']): NewTrackInput {
  return { kind: entry.kind === 'music' ? 'music' : 'sfx', name: entry.title, src: entry.url, durationMs: entry.durationMs, scope, libraryId: entry.id }
}

/* ------------------------------------------------------------------------------------ the shared store */

export type CatalogueState = { status: 'loading' } | { status: 'ready'; catalogue: Catalogue } | { status: 'error'; code: CatalogueFailure; message: string }

/** One catalogue per page load, shared by every panel; `reload()` after a failure. */
export class CatalogueStore {
  private state: CatalogueState = { status: 'loading' }
  private started = false
  /** Counts the loads that were started, so that the answer of an older one never overwrites a newer one. */
  private generation = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly load: () => Promise<Catalogue> = () => loadCatalogue()) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): CatalogueState => this.state

  /** Starts loading on first use; after a failure only `reload()` tries again (a render must never start a request). */
  ensure(): void {
    if (this.started) return
    this.started = true
    this.fetch()
  }

  reload(): void {
    this.started = true
    this.set({ status: 'loading' })
    this.fetch()
  }

  private fetch(): void {
    const generation = ++this.generation
    this.load().then(
      (catalogue) => {
        if (generation === this.generation) this.set({ status: 'ready', catalogue })
      },
      (error: unknown) => {
        if (generation !== this.generation) return
        const e = error instanceof CatalogueError ? error : new CatalogueError('unreachable', 'The audio library could not be loaded.')
        this.set({ status: 'error', code: e.code, message: e.message })
      },
    )
  }

  private set(state: CatalogueState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
}

export const catalogueStore = new CatalogueStore()
