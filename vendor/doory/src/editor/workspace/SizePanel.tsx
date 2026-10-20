import { useId, useState } from 'react'
import { useDocument, useEditor } from '../context'
import type { ResizeMode } from '../engine/magicResize'
import type { ResizeScope } from '../engine/api/pages'
import { getPageSize, sameSize } from '../engine/pageSizes'
import { useSizePresets, type SizePreset } from '@/lib/sizePresets'
import { pxToUnit, unitDecimals, unitToPx } from '../engine/units'
import { type DocUnit } from '@/types/document'
import { t } from '../strings'
import { CANVAS_SIDE_PX, canvasSideRange, clampTo, rangeHint } from '../toolbar/limits'
import ed from '../chrome/ed.module.css'
import styles from './Floating.module.css'

const { min: MIN_PX, max: MAX_DIMENSION_PX } = CANVAS_SIDE_PX
/** Sizes offered right in the popover. */
const QUICK_PRESETS = ['a4', 'a5', 'letter', 'instagram-post', 'presentation', 'youtube-thumbnail']
const MODES: { id: ResizeMode; label: string; hint: string }[] = [
  { id: 'scale', label: t.canvasSize.scale, hint: t.canvasSize.scaleHint },
  { id: 'magic', label: t.canvasSize.magic, hint: t.canvasSize.magicHint },
  { id: 'keep', label: t.canvasSize.keep, hint: t.canvasSize.keepHint },
]

/** Parses a field; null when it is blank or not a number. */
const parse = (s: string): number | null => {
  const n = Number(s.replace(',', '.'))
  return s.trim() !== '' && Number.isFinite(n) ? n : null
}

interface SizePanelProps {
  close: () => void
  /** The page the size belongs to; the panel offers "this page" and "all pages" when the design has several. */
  pageId: string
  /** Which pages start selected: `all` for the design-level button, `page` for the size chip of one page. */
  defaultScope: ResizeScope
  /** Offers flipping the page (the button of the whole canvas does, the chip of a page does not). */
  showFlip?: boolean
}

/** Size presets, custom size, the pages it reaches and how the content follows. */
export function SizePanel({ close, pageId, defaultScope, showFlip = false }: SizePanelProps) {
  const editor = useEditor()
  const doc = useDocument()
  const current = getPageSize(doc, pageId)
  const multiple = doc.pages.length > 1
  const [scope, setScope] = useState<ResizeScope>(multiple ? defaultScope : 'all')
  const [unit, setUnit] = useState<DocUnit>(doc.unit)
  const dec = unitDecimals(unit)
  const show = (px: number): string => String(Number(pxToUnit(px, unit).toFixed(dec)))
  // Held as text so the fields can be typed in freely; they are validated on Apply.
  const [w, setW] = useState(() => show(current.width))
  const [h, setH] = useState(() => show(current.height))
  const [mode, setMode] = useState<ResizeMode>('scale')
  const catalogue = useSizePresets()

  const rangeId = useId()
  // The limit as it reads in the chosen unit; a value typed outside it is pulled back in when the field is left.
  const range = canvasSideRange(unit)
  const hint = rangeHint(range, unit)
  const clampText = (text: string): string => {
    const n = parse(text)
    return n === null ? text : String(clampTo(range, n))
  }

  const wPx = parse(w) === null ? null : Math.round(unitToPx(parse(w) as number, unit))
  const hPx = parse(h) === null ? null : Math.round(unitToPx(parse(h) as number, unit))
  const valid = wPx !== null && hPx !== null && wPx >= MIN_PX && wPx <= MAX_DIMENSION_PX && hPx >= MIN_PX && hPx <= MAX_DIMENSION_PX
  const touched = w.trim() !== '' || h.trim() !== ''
  /** Enter applies a valid size; for one outside the range it shows what the limit makes of it. */
  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter') return
    if (valid) apply(wPx, hPx)
    else {
      setW(clampText(w))
      setH(clampText(h))
    }
  }

  const changeUnit = (next: DocUnit): void => {
    // Keep the pixel size while switching the unit the fields are shown in.
    const toPx = (s: string): number | null => (parse(s) === null ? null : unitToPx(parse(s) as number, unit))
    const wp = toPx(w)
    const hp = toPx(h)
    setUnit(next)
    const fmt = (px: number): string => String(Number(pxToUnit(px, next).toFixed(unitDecimals(next))))
    if (wp !== null) setW(fmt(wp))
    if (hp !== null) setH(fmt(hp))
  }
  const apply = (width: number, height: number): void => {
    editor.pages.resize(width, height, mode, { scope, pageId })
    editor.announce(t.canvasSize.resized(width, height))
    close()
  }
  // A short list of paper sizes; the Resize dialog has the full catalogue.
  const presets = QUICK_PRESETS.map((id) => catalogue.byId.get(id)).filter((p): p is SizePreset => p !== undefined)

  return (
    <div className={styles.sizePop} role="group" aria-label={t.canvasSize.title} data-testid="ed-canvas-size-pop" data-page-id={pageId}>
      <p className={ed.sectionTitle}>{t.canvasSize.paperSize}</p>
      <div className={styles.presets}>
        {presets.map((p) => (
          <button key={p.id} type="button" className={styles.preset} aria-pressed={sameSize(current, p)} data-testid={`ed-preset-${p.id}`} onClick={() => apply(p.width, p.height)}>
            <strong>{p.label}</strong>
            <small>
              {p.width} × {p.height}
            </small>
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`${ed.btn} ${ed.ghost} ${styles.fullWidth}`}
        data-testid="ed-all-sizes"
        onClick={() => {
          close()
          editor.openDialog('resize', { pageId, scope })
        }}
      >
        {t.canvasSize.allSizes}
      </button>

      <div className={`${ed.sectionTitle} ${styles.titleRow}`} style={{ marginTop: 14 }}>
        <span>{t.canvasSize.customSize}</span>
        <small id={rangeId}>{t.canvasSize.range(MIN_PX, MAX_DIMENSION_PX)}</small>
      </div>
      <div className={styles.unitRow} role="group" aria-label={t.canvasSize.unit}>
        {(['px', 'mm', 'in'] as const).map((u) => (
          <button key={u} type="button" className={styles.modeBtn} aria-pressed={unit === u} onClick={() => changeUnit(u)}>
            {u}
          </button>
        ))}
      </div>
      <div className={styles.dims}>
        <div>
          <div className={styles.dimLabel}>
            {t.canvasSize.width} ({unit})
          </div>
          <input type="number" className={ed.propInput} inputMode="decimal" value={w} aria-label={`${t.canvasSize.width} (${unit})`} aria-describedby={rangeId} title={hint} min={range.min} max={range.max} step={range.step} aria-invalid={touched && (wPx === null || wPx < MIN_PX || wPx > MAX_DIMENSION_PX)} data-testid="ed-canvas-width" onChange={(e) => setW(e.target.value)} onBlur={() => setW(clampText(w))} onKeyDown={onEnter} />
        </div>
        <div>
          <div className={styles.dimLabel}>
            {t.canvasSize.height} ({unit})
          </div>
          <input type="number" className={ed.propInput} inputMode="decimal" value={h} aria-label={`${t.canvasSize.height} (${unit})`} aria-describedby={rangeId} title={hint} min={range.min} max={range.max} step={range.step} aria-invalid={touched && (hPx === null || hPx < MIN_PX || hPx > MAX_DIMENSION_PX)} data-testid="ed-canvas-height" onChange={(e) => setH(e.target.value)} onBlur={() => setH(clampText(h))} onKeyDown={onEnter} />
        </div>
      </div>
      {touched && !valid ? (
        <p className={styles.error} role="alert">
          {t.canvasSize.invalid(MIN_PX, MAX_DIMENSION_PX)}
        </p>
      ) : null}
      {multiple ? (
        <>
          <div className={styles.dimLabel} style={{ marginTop: 10 }}>
            {t.canvasSize.scope}
          </div>
          <div className={styles.modes} role="group" aria-label={t.canvasSize.scope} data-testid="ed-canvas-scope">
            {(['page', 'all'] as const).map((id) => (
              <button key={id} type="button" className={styles.modeBtn} aria-pressed={scope === id} data-testid={`ed-scope-${id}`} onClick={() => setScope(id)}>
                {id === 'page' ? t.canvasSize.thisPage : t.canvasSize.allPages}
              </button>
            ))}
          </div>
          <p className={styles.hint}>{scope === 'page' ? t.canvasSize.scopePageHint : t.canvasSize.scopeAllHint}</p>
        </>
      ) : null}
      <button type="button" className={`${ed.btn} ${ed.primary} ${styles.fullWidth}`} disabled={!valid} data-testid="ed-canvas-apply" onClick={() => valid && apply(wPx, hPx)}>
        {t.canvasSize.apply}
      </button>
      <div className={styles.modes} role="group" aria-label={t.canvasSize.resizeContent} style={{ marginTop: 10 }}>
        {MODES.map((m) => (
          <button key={m.id} type="button" className={styles.modeBtn} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <p className={styles.hint}>{MODES.find((m) => m.id === mode)?.hint}</p>

      {showFlip ? (
        <>
          <p className={ed.sectionTitle} style={{ marginTop: 14 }}>
            {t.canvasSize.flipCanvas}
          </p>
          <div className={styles.flipRow}>
            <button
              type="button"
              className={`${ed.btn} ${ed.ghost}`}
              data-testid="ed-flip-canvas-h"
              onClick={() => {
                editor.pages.flipCanvas('horizontal')
                close()
              }}
            >
              {t.canvasSize.flipH}
            </button>
            <button
              type="button"
              className={`${ed.btn} ${ed.ghost}`}
              data-testid="ed-flip-canvas-v"
              onClick={() => {
                editor.pages.flipCanvas('vertical')
                close()
              }}
            >
              {t.canvasSize.flipV}
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

