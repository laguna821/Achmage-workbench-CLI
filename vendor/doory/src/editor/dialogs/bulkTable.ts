import type { FieldValue, TemplateField } from '@/types/api'

/** A pasted or uploaded table: the first row names the columns. */
export interface Table {
  headers: string[]
  rows: string[][]
}

/** Column index per field key; `-1`: the field is left as it is. */
export type Mapping = Record<string, number>

export interface RowCheck {
  index: number
  values: Record<string, FieldValue>
  /** Problems by field key, shown before anything is created. */
  errors: Record<string, string>
}

export const MAX_ROWS = 100
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** The cell separator: tabs (pasted from a spreadsheet), else whichever of `,` and `;` the header line uses more. */
function separatorOf(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? ''
  if (header.includes('\t')) return '\t'
  return (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0) ? ';' : ','
}

/** Parses CSV (RFC 4180 quotes) or tab-separated text; blank lines are dropped. */
export function parseTable(text: string): Table {
  const sep = separatorOf(text)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  rows.push(row)
  const filled = rows.filter((r) => r.some((c) => c.trim() !== '')).map((r) => r.map((c) => c.trim()))
  const [headers = [], ...body] = filled
  return { headers, rows: body }
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Matches each keyed field to the column named like its key or label (case, spaces and punctuation ignored). */
export function autoMap(headers: string[], fields: TemplateField[]): Mapping {
  const names = headers.map(normalize)
  const mapping: Mapping = {}
  for (const field of fields) {
    if (!field.key) continue
    const wanted = [field.key, field.label ?? ''].map(normalize).filter(Boolean)
    mapping[field.key] = names.findIndex((name) => wanted.includes(name))
  }
  return mapping
}

function imageValue(cell: string): FieldValue {
  return /^https?:\/\//i.test(cell) ? { url: cell } : cell // an upload's name: the server looks it up
}

/** The values of each row by field key, with the problems the browser can see (the server checks again). */
export function checkRows(table: Table, mapping: Mapping, fields: TemplateField[]): RowCheck[] {
  return table.rows.map((row, idx) => {
    const values: Record<string, FieldValue> = {}
    const errors: Record<string, string> = {}
    for (const field of fields) {
      if (!field.key) continue
      const column = mapping[field.key] ?? -1
      if (column < 0) continue
      const cell = row[column]?.trim() ?? ''
      if (!cell) continue
      if (field.type === 'color') {
        if (!HEX.test(cell)) errors[field.key] = 'color'
        else values[field.key] = cell
      } else if (field.type === 'image') {
        if (/^http:\/\//i.test(cell)) errors[field.key] = 'https'
        else values[field.key] = imageValue(cell)
      } else values[field.key] = cell
    }
    return { index: idx + 1, values, errors }
  })
}
