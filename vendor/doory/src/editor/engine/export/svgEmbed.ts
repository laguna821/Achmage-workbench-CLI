/**
 * Makes an SVG self-contained: every `<image>` href that is not already a `data:` URI is fetched and
 * inlined. The server-side PDF renderer strips every non-data `href`, so this is mandatory for that path,
 * and it also makes downloaded SVGs portable.
 */
export class SvgEmbedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SvgEmbedError'
  }
}

const HREF_RE = /(xlink:href|href)="([^"]+)"/g

export type BlobFetcher = (url: string) => Promise<Blob>

const defaultFetch: BlobFetcher = async (url) => {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.blob()
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'))
    reader.readAsDataURL(blob)
  })
}

/** External (non data:) URLs referenced by the SVG, in document order, de-duplicated. */
export function externalHrefs(svg: string): string[] {
  const seen = new Set<string>()
  for (const m of svg.matchAll(HREF_RE)) {
    const url = decodeXml(m[2])
    if (!url.startsWith('data:') && !url.startsWith('#')) seen.add(url)
  }
  return [...seen]
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

export async function embedImages(svg: string, fetchBlob: BlobFetcher = defaultFetch): Promise<string> {
  const urls = externalHrefs(svg)
  if (urls.length === 0) return svg
  const map = new Map<string, string>()
  await Promise.all(
    urls.map(async (url) => {
      try {
        map.set(url, await blobToDataUrl(await fetchBlob(url)))
      } catch {
        throw new SvgEmbedError('An image in this design could not be embedded.')
      }
    }),
  )
  return svg.replace(HREF_RE, (whole, attr: string, url: string) => {
    const data = map.get(decodeXml(url))
    return data ? `${attr}="${data}"` : whole
  })
}
