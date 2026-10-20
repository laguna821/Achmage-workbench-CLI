/**
 * Audio files the person brings: what is accepted, and a friendly reason when it is not. The server checks the bytes
 * again (`apps/assets/audio.py`); this check keeps an obviously wrong file from being sent at all.
 */
import { MAX_AUDIO_BYTES } from './model'

/** Types accepted by the picker and by drag and drop. */
export const AUDIO_ACCEPT = 'audio/mpeg,audio/mp3,audio/ogg,audio/wav,audio/x-wav,audio/wave,audio/mp4,audio/x-m4a,audio/aac,audio/webm,.mp3,.ogg,.oga,.opus,.wav,.m4a,.webm,.weba'

const TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/webm': 'weba',
}
const EXTENSIONS = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'weba', 'webm'])

export class AudioFileError extends Error {
  constructor(
    message: string,
    readonly code: 'type' | 'size' | 'empty',
  ) {
    super(message)
    this.name = 'AudioFileError'
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Whether the file looks like audio from its type or its name (a file without a type is judged by its extension). */
export function looksLikeAudio(file: Pick<File, 'type' | 'name'>): boolean {
  const type = file.type.toLowerCase().split(';')[0].trim()
  if (type in TYPES) return true
  if (type.startsWith('video/webm') || type === '') return EXTENSIONS.has(extensionOf(file.name))
  return false
}

export function audioFilesFrom(list: DataTransfer | FileList | null | undefined): File[] {
  const files = list && 'files' in list ? Array.from(list.files) : list ? Array.from(list) : []
  return files.filter(looksLikeAudio)
}

/** Throws `AudioFileError` unless `file` may be uploaded. */
export function validateAudioFile(file: Pick<File, 'type' | 'name' | 'size'>, maxBytes = MAX_AUDIO_BYTES): void {
  if (file.size === 0) throw new AudioFileError('That file is empty.', 'empty')
  if (!looksLikeAudio(file)) throw new AudioFileError('That file type is not supported. Use MP3, OGG, WAV, M4A or WebM audio.', 'type')
  if (file.size > maxBytes) throw new AudioFileError(`That file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`, 'size')
}

/** A display name for an uploaded file: the file name without its extension. */
export function nameFromFile(file: Pick<File, 'name'>): string {
  const base = file.name.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.trim() || 'Audio'
}

/** A voiceover name that does not repeat one in `taken`: "Voiceover 1", "Voiceover 2" … */
export function nextVoiceoverName(taken: readonly string[]): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) if (!used.has(`Voiceover ${n}`)) return `Voiceover ${n}`
}
