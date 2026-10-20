/**
 * Credits for the sounds of a design: CC BY sounds from Freesound must be credited where the design is published.
 * The text is one line per sound, ready for a caption or a video description; the server builds the same lines for
 * MCP (`backend/apps/assets/credits.py`, keep `credit_line` in step).
 */
import type { AudioTrack, TrackCredit } from '@/types/document'

const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')

/** `Music: "Rainy Lo-fi" by jdoe (freesound.org/people/jdoe/sounds/5), CC BY 4.0` */
export function creditLine(credit: TrackCredit, kind: AudioTrack['kind']): string {
  const label = kind === 'music' ? 'Music' : 'Sound'
  const author = credit.author ? ` by ${credit.author}` : ''
  const link = credit.url ? ` (${shortUrl(credit.url)})` : ''
  return `${label}: "${credit.title}"${author}${link}, ${credit.license}`
}

export interface DesignCredit {
  credit: TrackCredit
  kind: AudioTrack['kind']
  line: string
}

/** The credits that must be published with the design: CC BY sounds, each once, in track order. */
export function requiredCredits(tracks: readonly AudioTrack[]): DesignCredit[] {
  const seen = new Set<string>()
  const out: DesignCredit[] = []
  for (const track of tracks) {
    const credit = track.credit
    if (!credit?.required) continue
    const key = `${credit.source}/${credit.id || credit.title}`
    if (seen.has(key)) continue
    seen.add(key)
    const kind = track.kind === 'music' ? 'music' : 'sfx'
    out.push({ credit, kind, line: creditLine(credit, kind) })
  }
  return out
}

export function creditsText(tracks: readonly AudioTrack[]): string {
  return requiredCredits(tracks)
    .map((c) => c.line)
    .join('\n')
}
