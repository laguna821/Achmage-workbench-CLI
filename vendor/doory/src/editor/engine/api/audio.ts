/**
 * Audio commands: the one writer of `DoryDocument.audioTracks`. Every method is a single undoable step, does nothing
 * in a read-only editor, and goes through `applyDocument`, so autosave, history and real-time editing treat the
 * track list like any other part of the document. The player, the panel and the timeline only read.
 *
 * Files come in through the adapter (`uploadAsset`): a guest's file becomes `idb://…`, an account's `/media/…`. A
 * track is only added once its length is known (the file is decoded), so it can be drawn and trimmed at once.
 */
import { uuid } from '@/lib/uuid'
import type { AssetRef } from '@/types/adapter'
import type { AudioScope, AudioTrack, AudioTrackKind, DoryDocument, TrackCredit } from '@/types/document'
import { type CatalogueEntry, trackInputFor } from '../../audio/library'
import { AudioFileError, nameFromFile, nextVoiceoverName, validateAudioFile } from '../../audio/files'
import { MAX_TRACKS, type NewTrackInput, type TrackPatch, createTrack, orphanedTracks, patchTrack, readTracks, sameTrack, withTracks } from '../../audio/model'
import { type MixOptions, mixAudio } from '../../audio/mixer'
import { SourceStore } from '../../audio/sources'
import { t } from '../../strings'
import type { EditorEngine } from '../editor'

const labels = t.audio.history

export class AudioApi {
  /** Decoded sounds of this editor, shared by the waveforms, the preview, the presenter and the mixdown. */
  readonly sources: SourceStore

  constructor(private readonly engine: EditorEngine) {
    this.sources = new SourceStore({ resolveSrc: (src) => engine.assets.resolve(src) })
  }

  private get doc(): DoryDocument {
    return this.engine.getDocument()
  }

  /** The tracks of the design as the editor reads them. */
  tracks(): readonly AudioTrack[] {
    return readTracks(this.doc)
  }

  get(id: string): AudioTrack | undefined {
    return this.tracks().find((track) => track.id === id)
  }

  private write(tracks: readonly AudioTrack[], label: string, coalesceKey?: string): void {
    const next = withTracks(this.doc, tracks)
    if (next !== this.doc) this.engine.applyDocument(next, { label, coalesceKey })
  }

  /** Adds a track. Returns it, or `null` when the design is read-only or already has 32 tracks (the person is told). */
  add(input: NewTrackInput | AudioTrack): AudioTrack | null {
    if (this.engine.readOnly) return null
    const tracks = this.tracks()
    if (tracks.length >= MAX_TRACKS) {
      this.engine.toast(t.audio.errors.limit, 'error')
      return null
    }
    const track = 'trimStartMs' in input ? input : createTrack(input)
    this.write([...tracks, track], labels.add)
    this.engine.announce(t.audio.announce.added(track.name))
    return track
  }

  /** Adds a library entry: a music loop or a sound effect, to the whole design or to a page. */
  addFromLibrary(entry: CatalogueEntry, scope: AudioScope): AudioTrack | null {
    return this.add(trackInputFor(entry, scope))
  }

  /** Adds an uploaded or recorded file the adapter already stored. */
  addFromAsset(asset: AssetRef, kind: AudioTrackKind, durationMs: number, scope: AudioScope = { type: 'design' }, credit?: TrackCredit): AudioTrack | null {
    return this.add({ kind, name: asset.name, src: asset.url, assetId: asset.id, durationMs, scope, ...(credit ? { credit } : {}) })
  }

  /** Changes settings of a track. `coalesceKey` joins a drag or a slider into one undo step. */
  update(id: string, patch: TrackPatch, label: string = labels.change, coalesceKey?: string): void {
    if (this.engine.readOnly) return
    const tracks = this.tracks()
    const index = tracks.findIndex((track) => track.id === id)
    if (index < 0) return
    const next = patchTrack(tracks[index], patch)
    if (sameTrack(tracks[index], next)) return
    this.write(tracks.map((track, i) => (i === index ? next : track)), label, coalesceKey)
  }

  setVolume(id: string, volume: number): void {
    this.update(id, { volume }, labels.volume, `audio-volume:${id}`)
  }

  setMuted(id: string, muted: boolean): void {
    const track = this.get(id)
    if (!track) return
    this.update(id, { muted }, muted ? labels.mute : labels.unmute)
    this.engine.announce(muted ? t.audio.announce.muted(track.name) : t.audio.announce.unmuted(track.name))
  }

  /** Moves the track to another scope; its start offset is kept. */
  setScope(id: string, scope: AudioScope): void {
    this.update(id, { scope }, labels.scope)
  }

  remove(id: string): void {
    if (this.engine.readOnly) return
    const tracks = this.tracks()
    const track = tracks.find((item) => item.id === id)
    if (!track) return
    this.write(tracks.filter((item) => item.id !== id), labels.remove)
    this.engine.announce(t.audio.announce.removed(track.name))
  }

  duplicate(id: string): AudioTrack | null {
    const track = this.get(id)
    if (!track || this.engine.readOnly) return null
    if (this.tracks().length >= MAX_TRACKS) {
      this.engine.toast(t.audio.errors.limit, 'error')
      return null
    }
    const copy: AudioTrack = { ...track, id: uuid(), name: `${track.name} copy`.slice(0, 200), muted: false }
    const tracks = this.tracks()
    const index = tracks.findIndex((item) => item.id === id)
    this.write([...tracks.slice(0, index + 1), copy, ...tracks.slice(index + 1)], labels.duplicate)
    return copy
  }

  /** Removes the tracks of pages that no longer exist (they are ignored on playback in the meantime, so undoing a page deletion brings them back). */
  removeOrphans(): number {
    if (this.engine.readOnly) return 0
    const gone = orphanedTracks(this.tracks(), new Set(this.doc.pages.map((p) => p.id)))
    if (gone.length === 0) return 0
    const ids = new Set(gone.map((track) => track.id))
    this.write(this.tracks().filter((track) => !ids.has(track.id)), labels.clean)
    return gone.length
  }

  /** Stores a file with the adapter and reads its length, without adding a track (the Uploads tab lists it first). */
  async upload(file: File | Blob, name?: string): Promise<{ ref: AssetRef; durationMs: number }> {
    if (this.engine.readOnly) throw new AudioFileError(t.audio.errors.readOnly, 'type')
    const label = name ?? nameFromFile(file instanceof File ? file : { name: 'Audio' })
    if (file instanceof File) validateAudioFile(file)
    const ref = await this.engine.adapter.uploadAsset(file, { name: label })
    return { ref, durationMs: await this.measure(ref) }
  }

  /**
   * Stores a file with the adapter, reads its length and adds it as a track. Rejects with a message fit for the person
   * (`AudioFileError`, `AudioLoadError`) and leaves the design alone when anything fails.
   */
  async addFile(file: File | Blob, options: { kind?: AudioTrackKind; name?: string; scope?: AudioScope } = {}): Promise<AudioTrack> {
    if (this.engine.readOnly) throw new AudioFileError(t.audio.errors.readOnly, 'type')
    const { ref, durationMs } = await this.upload(file, options.name)
    const track = this.addFromAsset(ref, options.kind ?? 'upload', durationMs, options.scope)
    if (!track) throw new AudioFileError(t.audio.errors.limit, 'size')
    return track
  }

  /** A recording as a voiceover track. The name is "Voiceover n". */
  async addRecording(blob: Blob, scope: AudioScope = { type: 'design' }): Promise<AudioTrack> {
    const name = nextVoiceoverName(this.tracks().map((track) => track.name))
    const named = new File([blob], `${name}.${extensionOf(blob.type)}`, { type: blob.type })
    return this.addFile(named, { kind: 'voiceover', name, scope })
  }

  /** The length of a stored file, ms: from the server when it says, else by decoding the file. */
  async measure(ref: AssetRef, hint?: number): Promise<number> {
    if (hint && hint > 0) return hint
    const buffer = await this.sources.loadSrc(ref.url, ref.name)
    return Math.max(1, Math.round(buffer.duration * 1000))
  }

  /**
   * The design's sound as one stereo `AudioBuffer`, for the video exporter: see `mixAudio`. Files stored in this browser
   * (a guest's `idb://`) are read through the editor's own loader.
   */
  mixdown(pageDurationsMs: readonly number[], sampleRate: number, options: Omit<MixOptions, 'load'> = {}): Promise<AudioBuffer> {
    return mixAudio(this.doc, pageDurationsMs, sampleRate, { ...options, load: this.sources.load })
  }
}

function extensionOf(type: string): string {
  const main = type.toLowerCase().split(';')[0]
  return main.includes('ogg') ? 'ogg' : main.includes('mp4') ? 'm4a' : main.includes('mpeg') ? 'mp3' : main.includes('wav') ? 'wav' : 'webm'
}
