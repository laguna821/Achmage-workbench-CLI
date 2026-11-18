// Adapted from IeumOffice apps/html/src/main/asset-lifecycle.ts @ 8602a39410adb86037f3008588b64efc75b08c60.
// Apache-2.0; see ../LICENSE and ../NOTICE. Changes recorded in text-assets.manifest.json.
export interface CssUrlMatch {
  start: number
  end: number
  source: string
  /** the delimiter as written, so a rewrite reproduces it (`&quot;` inside a style attribute) */
  quote: string
}

/**
 * Every CSS url(...) reference: <style> rules and inline style attributes
 * alike. A DOM serializer escapes the quotes inside a style attribute, so
 * `url(&quot;…&quot;)` / `url(&#39;…&#39;)` count as quoted too.
 */
export function scanCssUrls(text: string): CssUrlMatch[] {
  const out: CssUrlMatch[] = []
  const re =
    /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|(&quot;|&#34;|&#39;|&apos;)([^\n]*?)\3|([^)"'\s]+))\s*\)/gi
  for (const match of text.matchAll(re)) {
    const source = match[1] ?? match[2] ?? match[4] ?? match[5] ?? ''
    if (!source) continue
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      source,
      quote: match[1] !== undefined ? '"' : match[2] !== undefined ? "'" : (match[3] ?? ''),
    })
  }
  return out
}

