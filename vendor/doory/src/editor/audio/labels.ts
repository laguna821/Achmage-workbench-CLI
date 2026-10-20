/** Words for where a track plays, shared by the panel and the timeline. */
import type { AudioTrack } from '@/types/document'
import { t } from '../strings'

/** "Whole design", "Page 3", or "Page removed" when the page the track belongs to is gone. */
export function scopeLabel(track: AudioTrack, pageIds: readonly string[]): string {
  if (track.scope.type === 'design') return t.audio.tracks.scopes.design
  const pageId = track.scope.pageId
  const index = pageIds.indexOf(pageId)
  return index < 0 ? t.audio.tracks.scopes.gone : t.audio.tracks.scopes.page(index + 1)
}
