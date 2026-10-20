/**
 * Waveform peaks: the loudest sample in each slice of a sound, cached so a waveform is drawn at once the second time.
 *
 * Decoding already runs off the main thread; reducing the decoded samples to peaks is a single pass of absolute
 * values (about 10 ms per minute of stereo audio), done in slices that give the page a turn between them, so no worker
 * is needed. Peaks are kept in memory and, for files the person uploaded or recorded, in IndexedDB (keyed by the file's
 * address), so reopening a design does not decode every track just to draw it.
 */
import type { PcmLike } from './wav'

/** Peaks per second of sound at the finest level; enough for a trim handle to land on a tenth of a second. */
export const PEAKS_PER_SECOND = 20
export const MIN_PEAKS = 64
export const MAX_PEAKS = 6000

export interface Peaks {
  /** Loudest absolute sample of each slice, 0..1. */
  values: Float32Array
  /** Length of the sound the peaks describe, ms. */
  durationMs: number
}

export function peakCount(durationMs: number): number {
  return Math.min(MAX_PEAKS, Math.max(MIN_PEAKS, Math.ceil((durationMs / 1000) * PEAKS_PER_SECOND)))
}

const SLICE_SAMPLES = 1 << 20

/** Reduces `buffer` to `count` peaks. Yields to the page between slices of about a million samples. */
export async function computePeaks(buffer: PcmLike, count = peakCount((buffer.length / buffer.sampleRate) * 1000), signal?: AbortSignal): Promise<Peaks> {
  const values = new Float32Array(count)
  const perPeak = Math.max(1, buffer.length / count)
  let sinceYield = 0
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let p = 0; p < count; p++) {
      const from = Math.floor(p * perPeak)
      const to = Math.min(buffer.length, Math.max(from + 1, Math.floor((p + 1) * perPeak)))
      let max = values[p]
      for (let i = from; i < to; i++) {
        const v = data[i] < 0 ? -data[i] : data[i]
        if (v > max) max = v
      }
      values[p] = max
      sinceYield += to - from
      if (sinceYield >= SLICE_SAMPLES) {
        sinceYield = 0
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }
  }
  return { values, durationMs: (buffer.length / buffer.sampleRate) * 1000 }
}

/** `count` bars for drawing `[fromMs, toMs]` of a sound: each the loudest peak under it. */
export function barsFor(peaks: Peaks, fromMs: number, toMs: number, count: number): Float32Array {
  const bars = new Float32Array(count)
  const n = peaks.values.length
  if (n === 0 || count <= 0 || peaks.durationMs <= 0) return bars
  const perMs = n / peaks.durationMs
  const span = Math.max(1e-6, toMs - fromMs)
  for (let b = 0; b < count; b++) {
    const a = Math.max(0, Math.floor((fromMs + (span * b) / count) * perMs))
    const z = Math.min(n, Math.max(a + 1, Math.ceil((fromMs + (span * (b + 1)) / count) * perMs)))
    let max = 0
    for (let i = a; i < z && i < n; i++) if (peaks.values[i] > max) max = peaks.values[i]
    bars[b] = max
  }
  return bars
}

const levels = new WeakMap<Peaks, number>()

/** The loudest peak of the whole sound, 0..1. */
export function peakLevel(peaks: Peaks): number {
  let level = levels.get(peaks)
  if (level === undefined) {
    level = 0
    for (const v of peaks.values) if (v > level) level = v
    levels.set(peaks, level)
  }
  return level
}

/** Quietest sound the display makes louder, and the most it does (a recording at -20 dBFS fills the box; silence stays flat). */
const DISPLAY_FLOOR = 0.2

/** The factor to draw `peaks` at so that a quiet recording is still readable: 1 for a loud sound, at most 5. */
export function displayGain(peaks: Peaks): number {
  return 1 / Math.max(DISPLAY_FLOOR, peakLevel(peaks))
}

/** Peaks of the catalogue (0..100 integers, 72 or fewer) as `Peaks`, to draw a library track before it is decoded. */
export function peaksFromCatalogue(values: readonly number[], durationMs: number): Peaks {
  return { values: Float32Array.from(values, (v) => Math.max(0, Math.min(100, v)) / 100), durationMs }
}

/* ------------------------------------------------------------------------------------------ the cache */

const DB_NAME = 'doory-audio'
const STORE = 'peaks'
const MEMORY_LIMIT = 64

const memory = new Map<string, Peaks>()
const inflight = new Map<string, Promise<Peaks>>()

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function readStored(key: string): Promise<Peaks | undefined> {
  const db = await openDb()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      request.onsuccess = () => {
        const v = request.result as { values?: Float32Array; durationMs?: number } | undefined
        resolve(v?.values instanceof Float32Array && typeof v.durationMs === 'number' ? { values: v.values, durationMs: v.durationMs } : undefined)
        db.close()
      }
      request.onerror = () => {
        resolve(undefined)
        db.close()
      }
    } catch {
      resolve(undefined)
    }
  })
}

async function writeStored(key: string, peaks: Peaks): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(peaks, key)
  } catch {
    // Storage is a convenience.
  } finally {
    setTimeout(() => db.close(), 200)
  }
}

function remember(key: string, peaks: Peaks): void {
  memory.set(key, peaks)
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as string)
}

/** The cached peaks for `key` (a file's address), if any: from memory, else from IndexedDB. */
export async function cachedPeaks(key: string): Promise<Peaks | undefined> {
  const hit = memory.get(key)
  if (hit) return hit
  const stored = await readStored(key)
  if (stored) remember(key, stored)
  return stored
}

/** Peaks for `key`, computed from `decode()`'s buffer once and then cached (memory, and IndexedDB when `persist`). */
export function peaksFor(key: string, decode: () => Promise<PcmLike>, options: { persist?: boolean; signal?: AbortSignal } = {}): Promise<Peaks> {
  const hit = memory.get(key)
  if (hit) return Promise.resolve(hit)
  let pending = inflight.get(key)
  if (!pending) {
    pending = (async () => {
      const stored = await readStored(key)
      if (stored) {
        remember(key, stored)
        return stored
      }
      const peaks = await computePeaks(await decode())
      remember(key, peaks)
      if (options.persist) void writeStored(key, peaks)
      return peaks
    })()
    inflight.set(key, pending)
    const done = (): void => void inflight.delete(key)
    pending.then(done, done)
  }
  return pending
}

export function clearPeakCache(): void {
  memory.clear()
}
