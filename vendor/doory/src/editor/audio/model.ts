/**
 * The audio model: what a document may say about sound, how strictly the editor reads it, and the arithmetic of one
 * track. The server checks the same bounds.
 *
 * Reading is forgiving, writing is strict. A document from another tool may hold anything under `audioTracks`:
 * `normalizeTrack` limits every number to its range, swaps a trim that is the wrong way round, drops what is not a
 * track and never throws. Nothing here touches the DOM or Web Audio, so all of it runs in plain unit tests.
 */
import { uuid } from '@/lib/uuid'
import type { AudioScope, AudioTrack, AudioTrackKind, DoryDocument, TrackCredit } from '@/types/document'

export const MAX_TRACKS = 32
export const MAX_NAME_LENGTH = 200
export const MAX_ID_LENGTH = 64
export const MAX_SRC_LENGTH = 2048
/** Longest start, trim and source length the format allows: one day. */
export const MAX_TIME_MS = 86_400_000
export const MAX_FADE_MS = 60_000
/** The smallest sound a trim may leave. */
export const MIN_TRIM_MS = 50
/** A file larger than this is not accepted as an upload (the server's limit, too). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024
/** Decoded audio is held in memory, so a single source longer than this is refused with a clear message. */
export const MAX_SOURCE_MS = 15 * 60 * 1000

/** While a voiceover plays, tracks that duck are lowered to this fraction of their volume. */
export const DUCK_GAIN = 0.3
export const DUCK_ATTACK_MS = 150
export const DUCK_RELEASE_MS = 400

export const KINDS: readonly AudioTrackKind[] = ['music', 'voiceover', 'sfx', 'upload']

/** What a new track of each kind starts with. */
export const KIND_DEFAULTS: Record<AudioTrackKind, { volume: number; loop: boolean; fadeInMs: number; fadeOutMs: number }> = {
  music: { volume: 0.5, loop: true, fadeInMs: 800, fadeOutMs: 1500 },
  voiceover: { volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0 },
  sfx: { volume: 0.9, loop: false, fadeInMs: 0, fadeOutMs: 0 },
  upload: { volume: 0.7, loop: false, fadeInMs: 0, fadeOutMs: 0 },
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function clampNumber(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

const wholeMs = (v: unknown, min: number, max: number, fallback: number): number => (isNumber(v) ? clampNumber(Math.round(v), min, max) : fallback)

export function isKind(value: unknown): value is AudioTrackKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

/** Text without control characters, cut to `limit` UTF-16 units (never in the middle of a surrogate pair). */
export function cleanText(value: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** `https://` addresses, same-site paths (`/media/…`, never `//host`) and a guest's `idb://<uuid>` are playable. */
export function isPlayableSrc(src: unknown): src is string {
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_SRC_LENGTH) return false
  if (src.startsWith('https://')) return src.length > 8
  if (src.startsWith('/')) return !src.startsWith('//')
  return /^idb:\/\/[0-9a-f-]{36}$/i.test(src)
}

export function normalizeScope(raw: unknown): AudioScope {
  if (isRecord(raw) && raw.type === 'page' && typeof raw.pageId === 'string' && raw.pageId.length > 0 && raw.pageId.length <= MAX_ID_LENGTH) return { type: 'page', pageId: raw.pageId }
  return { type: 'design' }
}

/**
 * One track as the editor understands it, or `null` when `raw` is not a track (no usable id or source). Numbers are
 * limited to their ranges; a trim that is the wrong way round is swapped and one that is too short is widened.
 */
export function normalizeTrack(raw: unknown): AudioTrack | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > MAX_ID_LENGTH) return null
  if (!isKind(raw.kind) || !isPlayableSrc(raw.src)) return null
  const kind = raw.kind
  const defaults = KIND_DEFAULTS[kind]
  const durationMs = isNumber(raw.durationMs) && raw.durationMs > 0 ? wholeMs(raw.durationMs, 1, MAX_TIME_MS, 0) : undefined
  let trimStartMs = wholeMs(raw.trimStartMs, 0, MAX_TIME_MS, 0)
  let trimEndMs = wholeMs(raw.trimEndMs, 0, MAX_TIME_MS, durationMs ?? trimStartMs + 1000)
  if (trimEndMs < trimStartMs) [trimStartMs, trimEndMs] = [trimEndMs, trimStartMs]
  if (durationMs !== undefined) {
    trimEndMs = Math.min(trimEndMs, durationMs)
    trimStartMs = Math.min(trimStartMs, Math.max(0, trimEndMs - MIN_TRIM_MS))
  }
  if (trimEndMs - trimStartMs < MIN_TRIM_MS) trimEndMs = trimStartMs + MIN_TRIM_MS
  const track: AudioTrack = {
    id: raw.id,
    kind,
    name: cleanText(typeof raw.name === 'string' ? raw.name : '', MAX_NAME_LENGTH),
    src: raw.src,
    scope: normalizeScope(raw.scope),
    startMs: wholeMs(raw.startMs, 0, MAX_TIME_MS, 0),
    trimStartMs,
    trimEndMs,
    volume: isNumber(raw.volume) ? Math.round(clampNumber(raw.volume, 0, 1) * 1000) / 1000 : defaults.volume,
    fadeInMs: wholeMs(raw.fadeInMs, 0, MAX_FADE_MS, defaults.fadeInMs),
    fadeOutMs: wholeMs(raw.fadeOutMs, 0, MAX_FADE_MS, defaults.fadeOutMs),
    loop: typeof raw.loop === 'boolean' ? raw.loop : defaults.loop,
    muted: raw.muted === true,
  }
  if (durationMs !== undefined) track.durationMs = durationMs
  if (typeof raw.assetId === 'string' && raw.assetId.length > 0 && raw.assetId.length <= MAX_ID_LENGTH) track.assetId = raw.assetId
  if (typeof raw.libraryId === 'string' && raw.libraryId.length > 0 && raw.libraryId.length <= MAX_ID_LENGTH) track.libraryId = raw.libraryId
  if (typeof raw.duckUnderVoiceover === 'boolean') track.duckUnderVoiceover = raw.duckUnderVoiceover
  const credit = normalizeCredit(raw.credit)
  if (credit) track.credit = credit
  return track
}

const CREDIT_TEXT = 200

/** A track's credit, or null when it is not one: every field is text (limited), `required` a boolean. */
export function normalizeCredit(raw: unknown): TrackCredit | null {
  if (!isRecord(raw)) return null
  const text = (value: unknown): string => (typeof value === 'string' ? cleanText(value, CREDIT_TEXT) : '')
  const credit: TrackCredit = {
    source: text(raw.source),
    id: text(raw.id),
    title: text(raw.title),
    author: text(raw.author),
    url: /^https:\/\//.test(text(raw.url)) ? text(raw.url) : '',
    license: text(raw.license),
    required: raw.required === true,
  }
  return credit.title && credit.license ? credit : null
}

const listCache = new WeakMap<object, readonly AudioTrack[]>()
const NONE: readonly AudioTrack[] = []

/**
 * The usable tracks of a document: unreadable entries dropped, duplicate ids dropped, at most `MAX_TRACKS`. Cached per
 * `audioTracks` array (documents are immutable), and an already-normal track keeps its reference so React skips it.
 */
export function readTracks(doc: Pick<DoryDocument, 'audioTracks'>): readonly AudioTrack[] {
  const raw = doc.audioTracks
  if (!Array.isArray(raw) || raw.length === 0) return NONE
  const cached = listCache.get(raw)
  if (cached) return cached
  const seen = new Set<string>()
  const out: AudioTrack[] = []
  for (const item of raw) {
    if (out.length >= MAX_TRACKS) break
    const track = normalizeTrack(item)
    if (!track || seen.has(track.id)) continue
    seen.add(track.id)
    out.push(sameTrack(item, track) ? (item as AudioTrack) : track)
  }
  listCache.set(raw, out)
  return out
}

/** Whether `raw` already is exactly `track` (same fields and values, in any order). */
export function sameTrack(raw: unknown, track: AudioTrack): boolean {
  if (!isRecord(raw)) return false
  const keys = Object.keys(track) as (keyof AudioTrack)[]
  if (Object.keys(raw).length !== keys.length) return false
  return keys.every((key) => (key === 'scope' || key === 'credit' ? JSON.stringify(raw[key]) === JSON.stringify(track[key]) : raw[key] === track[key]))
}

/** The tracks to write back: nothing is written for an empty list (the property is removed instead). */
export function withTracks(doc: DoryDocument, tracks: readonly AudioTrack[]): DoryDocument {
  if (tracks.length === 0) {
    if (doc.audioTracks === undefined) return doc
    const { audioTracks: _removed, ...rest } = doc
    return rest
  }
  return { ...doc, audioTracks: [...tracks] }
}

export interface NewTrackInput {
  kind: AudioTrackKind
  name: string
  src: string
  /** Length of the whole source, ms. */
  durationMs: number
  scope?: AudioScope
  startMs?: number
  assetId?: string
  libraryId?: string
  credit?: TrackCredit
  id?: string
}

/** A new track with the defaults of its kind, trimmed to the whole source. */
export function createTrack(input: NewTrackInput): AudioTrack {
  const defaults = KIND_DEFAULTS[input.kind]
  const durationMs = Math.max(MIN_TRIM_MS, Math.min(MAX_TIME_MS, Math.round(input.durationMs)))
  const track: AudioTrack = {
    id: input.id ?? uuid(),
    kind: input.kind,
    name: cleanText(input.name, MAX_NAME_LENGTH) || defaultName(input.kind),
    src: input.src,
    scope: input.scope ?? { type: 'design' },
    startMs: wholeMs(input.startMs, 0, MAX_TIME_MS, 0),
    durationMs,
    trimStartMs: 0,
    trimEndMs: durationMs,
    volume: defaults.volume,
    fadeInMs: Math.min(defaults.fadeInMs, Math.floor(durationMs / 2)),
    fadeOutMs: Math.min(defaults.fadeOutMs, Math.floor(durationMs / 2)),
    loop: defaults.loop,
    muted: false,
  }
  if (input.assetId) track.assetId = input.assetId
  if (input.libraryId) track.libraryId = input.libraryId
  if (input.credit) track.credit = input.credit
  return track
}

export function defaultName(kind: AudioTrackKind): string {
  return kind === 'music' ? 'Music' : kind === 'voiceover' ? 'Voiceover' : kind === 'sfx' ? 'Sound effect' : 'Audio'
}

export type TrackPatch = Partial<Omit<AudioTrack, 'id' | 'kind' | 'src'>>

/** `track` with `patch` applied and every field limited again (so a drag past a limit stops at it). */
export function patchTrack(track: AudioTrack, patch: TrackPatch): AudioTrack {
  const merged: Record<string, unknown> = { ...track, ...patch, id: track.id, kind: track.kind, src: track.src }
  for (const key of Object.keys(patch) as (keyof TrackPatch)[]) if (patch[key] === undefined) delete merged[key]
  return normalizeTrack(merged) ?? track
}

/** The part of the source that plays, ms. */
export function trimmedLengthMs(track: Pick<AudioTrack, 'trimStartMs' | 'trimEndMs'>): number {
  return Math.max(MIN_TRIM_MS, track.trimEndMs - track.trimStartMs)
}

/** Whether the track is lowered under a voiceover: its own setting, else yes for music. */
export function ducks(track: Pick<AudioTrack, 'kind' | 'duckUnderVoiceover'>): boolean {
  return track.duckUnderVoiceover ?? track.kind === 'music'
}

/** Whether the track makes a sound at all. */
export function isAudible(track: Pick<AudioTrack, 'muted' | 'volume'>): boolean {
  return !track.muted && track.volume > 0
}

/** The page ids that tracks of `tracks` refer to but `pageIds` lacks (their page was deleted). */
export function orphanedTracks(tracks: readonly AudioTrack[], pageIds: ReadonlySet<string>): AudioTrack[] {
  return tracks.filter((t) => t.scope.type === 'page' && !pageIds.has(t.scope.pageId))
}
