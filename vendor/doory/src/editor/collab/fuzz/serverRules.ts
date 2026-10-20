/**
 * The rules the server applies before it saves a design (`apps.designs.validators.validate_document`), restated
 * for the fuzz harness so it can check a shared state at every step. The backend replays the same runs through
 * the real validator (`backend/apps/collab/tests/test_fuzz_replay.py`), so a drift between the two shows up there.
 */
const MAX_PAGES = 100
const MAX_DIMENSION = 20_000
const MAX_OBJECTS_PER_PAGE = 5_000
const MAX_DEPTH = 64
const MAX_DATA_URL_CHARS = 64 * 1024
const MAX_NOTES_LENGTH = 5_000
const SLUG = /^[a-z0-9-]{1,40}$/
const LOCAL_REFERENCE = /^\s*(?:blob:|idb:\/\/)\S*\s*$/i
const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'spring', 'bounce']
const DIRECTIONS = ['left', 'right', 'up', 'down', 'in', 'out']
const TEXT_UNITS = ['object', 'line', 'word', 'letter']

type Record_ = Record<string, unknown>
const isRecord = (v: unknown): v is Record_ => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const inRange = (v: unknown, low: number, high: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high

function motion(value: unknown, where: string, durations: readonly [number, number], transition: boolean, out: string[]): void {
  if (!isRecord(value)) {
    out.push(`${where} must be an object`)
    return
  }
  if (typeof value.preset !== 'string' || !SLUG.test(value.preset)) out.push(`${where} preset`)
  if (value.easing != null && !EASINGS.includes(value.easing as string)) out.push(`${where} easing`)
  if (value.direction != null && !DIRECTIONS.includes(value.direction as string)) out.push(`${where} direction`)
  if (value.durationMs != null && !inRange(value.durationMs, durations[0], durations[1])) out.push(`${where} durationMs`)
  if (transition) return
  if (value.delayMs != null && !inRange(value.delayMs, 0, 60_000)) out.push(`${where} delayMs`)
  if (value.intensity != null && !inRange(value.intensity, 0, 1)) out.push(`${where} intensity`)
  if (value.by != null && !TEXT_UNITS.includes(value.by as string)) out.push(`${where} by`)
  if (value.loop != null && typeof value.loop !== 'boolean') out.push(`${where} loop`)
}

function checkText(text: string, out: string[]): void {
  if (text.includes('\u0000')) out.push('NUL character')
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
      else out.push('lone surrogate')
    } else if (code >= 0xdc00 && code <= 0xdfff) out.push('lone surrogate')
  }
  const head = text.slice(0, 32).trimStart().toLowerCase()
  if ((head.startsWith('blob:') || head.startsWith('idb://')) && LOCAL_REFERENCE.test(text)) out.push('local image reference')
  if (text.length > MAX_DATA_URL_CHARS && (head.startsWith('data:') || text.includes(';base64,'))) out.push('inline image')
}

function walk(root: unknown, out: string[]): void {
  const stack: [unknown, number][] = [[root, 0]]
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number]
    if (typeof value === 'string') checkText(value, out)
    else if (typeof value === 'number' && !Number.isFinite(value)) out.push('non-finite number')
    else if (Array.isArray(value) || isRecord(value)) {
      if (depth >= MAX_DEPTH) {
        out.push('nested too deeply')
        continue
      }
      if (Array.isArray(value)) for (const child of value) stack.push([child, depth + 1])
      else
        for (const [key, child] of Object.entries(value)) {
          checkText(key, out)
          stack.push([child, depth + 1])
        }
    }
    if (out.length > 20) return
  }
}

const AUDIO_KINDS = ['music', 'voiceover', 'sfx', 'upload']
const AUDIO_RANGES: Record<string, [number, number]> = { startMs: [0, 86_400_000], trimStartMs: [0, 86_400_000], trimEndMs: [0, 86_400_000], durationMs: [0, 86_400_000], fadeInMs: [0, 60_000], fadeOutMs: [0, 60_000] }

function audioTracks(tracks: unknown, out: string[]): void {
  if (tracks == null) return
  if (!Array.isArray(tracks) || tracks.length > 32) {
    out.push('audioTracks')
    return
  }
  const seen = new Set<string>()
  tracks.forEach((track: unknown, index) => {
    const where = `audio track ${index + 1}`
    if (!isRecord(track)) {
      out.push(`${where} must be an object`)
      return
    }
    if (typeof track.id !== 'string' || track.id.length < 1 || track.id.length > 64 || seen.has(track.id)) out.push(`${where} id`)
    else seen.add(track.id)
    if (!AUDIO_KINDS.includes(track.kind as string)) out.push(`${where} kind`)
    if (track.name != null && (typeof track.name !== 'string' || track.name.length > 200)) out.push(`${where} name`)
    const src = track.src
    if (typeof src !== 'string' || src === '' || src.length > 2048) out.push(`${where} src`)
    else if (!LOCAL_REFERENCE.test(src) && !(src.startsWith('https://') || (src.startsWith('/') && !src.startsWith('//')))) out.push(`${where} src address`)
    if (track.assetId != null && (typeof track.assetId !== 'string' || track.assetId.length > 64)) out.push(`${where} assetId`)
    const scope = track.scope
    if (!isRecord(scope) || (scope.type !== 'design' && scope.type !== 'page')) out.push(`${where} scope`)
    else if (scope.type === 'page' && (typeof scope.pageId !== 'string' || scope.pageId.length < 1 || scope.pageId.length > 64)) out.push(`${where} scope.pageId`)
    for (const [key, [low, high]] of Object.entries(AUDIO_RANGES)) if (track[key] != null && !inRange(track[key], low, high)) out.push(`${where} ${key}`)
    if (track.volume != null && !inRange(track.volume, 0, 1)) out.push(`${where} volume`)
    for (const key of ['loop', 'muted', 'duckUnderVoiceover']) if (track[key] != null && typeof track[key] !== 'boolean') out.push(`${where} ${key}`)
    if (typeof track.trimStartMs === 'number' && typeof track.trimEndMs === 'number' && track.trimEndMs < track.trimStartMs) out.push(`${where} trim order`)
  })
}

/** What the server would refuse about this document; an empty list means it can be saved. */
export function serverProblems(doc: unknown): string[] {
  const out: string[] = []
  if (!isRecord(doc)) return ['not an object']
  if (!isInt(doc.schemaVersion) || doc.schemaVersion < 1 || doc.schemaVersion > 1) out.push('schemaVersion')
  for (const key of ['width', 'height']) if (!isInt(doc[key]) || (doc[key] as number) < 1 || (doc[key] as number) > MAX_DIMENSION) out.push(`document ${key}`)
  const pages = doc.pages
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_PAGES) {
    out.push('pages')
    return out
  }
  pages.forEach((page: unknown, index) => {
    if (!isRecord(page)) {
      out.push(`page ${index + 1} must be an object`)
      return
    }
    if (typeof page.id !== 'string' || page.id === '') out.push(`page ${index + 1} id`)
    for (const key of ['width', 'height']) if (key in page && (!isInt(page[key]) || (page[key] as number) < 1 || (page[key] as number) > MAX_DIMENSION)) out.push(`page ${index + 1} ${key}`)
    const objects = page.objects
    if (!Array.isArray(objects) || objects.length > MAX_OBJECTS_PER_PAGE) {
      out.push(`page ${index + 1} objects`)
      return
    }
    if (!objects.every(isRecord)) out.push(`page ${index + 1} object must be an object`)
    if (page.notes != null && (typeof page.notes !== 'string' || page.notes.length > MAX_NOTES_LENGTH)) out.push(`page ${index + 1} notes`)
    if (page.durationSec != null && !inRange(page.durationSec, 1, 600)) out.push(`page ${index + 1} durationSec`)
    if (page.transition != null) motion(page.transition, `page ${index + 1} transition`, [200, 3000], true, out)
    for (const object of objects) {
      if (!isRecord(object) || object.animation == null) continue
      if (!isRecord(object.animation)) {
        out.push(`page ${index + 1} animation`)
        continue
      }
      for (const slot of ['enter', 'exit', 'emphasis']) if (object.animation[slot] != null) motion(object.animation[slot], `page ${index + 1} animation ${slot}`, [100, 10_000], false, out)
    }
  })
  audioTracks(doc.audioTracks, out)
  if (doc.meta != null && !isRecord(doc.meta)) out.push('meta')
  walk(doc, out)
  return out
}
