import type { PageSize } from '../../engine/docOps'
import { cropMarkSegments, type PrintGeometry } from '../../engine/export/printGeometry'
import { t } from '../../strings'
import styles from './print.module.css'

interface PrintPreviewProps {
  /** The page to draw (its proportions only; the drawing is a schematic). */
  size: PageSize
  /** Draw the bleed around the page. */
  bleed: boolean
  /** Draw the crop marks and the margin that carries them. */
  marks: boolean
  /** The bleed in the unit the user reads, for the description ("3 mm"). */
  bleedLabel: string
}

const TRIM_BOX = { width: 132, height: 88 }
const BLEED = 7
const SLUG = 15
const MARK_GAP = 3
const MARK_LENGTH = 9

/**
 * Not-to-scale drawing of the sheet that will be printed: the trim line, the bleed around it and the crop marks in the
 * margin. A real 3 mm bleed on a 1080 px page would be a hairline, so the drawing keeps fixed proportions and says so.
 */
export function PrintPreview({ size, bleed, marks, bleedLabel }: PrintPreviewProps) {
  const fit = Math.min(TRIM_BOX.width / size.width, TRIM_BOX.height / size.height)
  const width = Math.max(18, size.width * fit)
  const height = Math.max(18, size.height * fit)
  const b = bleed ? BLEED : 0
  const s = marks ? SLUG : 0
  const sheetWidth = width + 2 * (b + s)
  const sheetHeight = height + 2 * (b + s)
  const geometry: PrintGeometry = { width, height, bleed: b, slug: s, sheetWidth, sheetHeight, artWidth: width + 2 * b, artHeight: height + 2 * b }
  const trimX = s + b
  const trimY = s + b

  return (
    <figure className={styles.preview}>
      <svg
        className={styles.previewSvg}
        viewBox={`0 0 ${sheetWidth} ${sheetHeight}`}
        role="img"
        aria-label={t.print.previewAlt(bleed ? bleedLabel : '', marks)}
        data-testid="print-preview"
        data-bleed={bleed}
        data-marks={marks}
      >
        <rect className={styles.sheet} x={0.5} y={0.5} width={sheetWidth - 1} height={sheetHeight - 1} rx={2} />
        {bleed ? <rect className={styles.bleedArea} x={s} y={s} width={geometry.artWidth} height={geometry.artHeight} data-part="bleed" /> : null}
        <rect className={styles.trimArea} x={trimX} y={trimY} width={width} height={height} data-part="trim" />
        <g className={styles.content} aria-hidden="true">
          <rect x={trimX + width * 0.12} y={trimY + height * 0.18} width={width * 0.46} height={Math.max(3, height * 0.1)} rx={1.5} />
          <rect x={trimX + width * 0.12} y={trimY + height * 0.38} width={width * 0.34} height={Math.max(2, height * 0.06)} rx={1} />
          <circle cx={trimX + width * 0.78} cy={trimY + height * 0.66} r={Math.min(width, height) * 0.16} />
        </g>
        {marks ? (
          <g className={styles.marks} data-part="marks">
            {cropMarkSegments(geometry, MARK_GAP, MARK_LENGTH).map(([x1, y1, x2, y2]) => (
              <line key={`${x1}-${y1}-${x2}-${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
            ))}
          </g>
        ) : null}
      </svg>
      <figcaption className={styles.previewCaption}>
        <ul className={styles.legend}>
          <li>
            <i className={styles.swatchTrim} aria-hidden="true" />
            {t.print.legendTrim}
          </li>
          {bleed ? (
            <li>
              <i className={styles.swatchBleed} aria-hidden="true" />
              {t.print.legendBleed}
            </li>
          ) : null}
          {marks ? (
            <li>
              <i className={styles.swatchMarks} aria-hidden="true" />
              {t.print.legendMarks}
            </li>
          ) : null}
        </ul>
        <span>{t.print.preview}</span>
      </figcaption>
    </figure>
  )
}
