import type { DocObject, DoryDocument } from '@/types/document'
import { walkObjects } from '../engine/docOps'
import { primaryFamily } from '../engine/text/fontStack'

function namesFamily(value: unknown, wanted: string): boolean {
  return typeof value === 'string' && primaryFamily(value).toLowerCase() === wanted
}

function usesFamily(o: DocObject, wanted: string): boolean {
  if (typeof o.type !== 'string' || !/text/i.test(o.type)) return false
  if (namesFamily(o.fontFamily, wanted)) return true
  const styles = o.styles
  if (!Array.isArray(styles)) return false
  return (styles as { style?: { fontFamily?: unknown } }[]).some((entry) => namesFamily(entry?.style?.fontFamily, wanted))
}

/** How many text layers of the design draw (some of) their text in `family`, groups included. */
export function countTextLayersUsing(doc: DoryDocument, family: string): number {
  const wanted = primaryFamily(family).toLowerCase()
  let count = 0
  for (const page of doc.pages) {
    walkObjects(page.objects, (o) => {
      if (usesFamily(o, wanted)) count += 1
    })
  }
  return count
}
