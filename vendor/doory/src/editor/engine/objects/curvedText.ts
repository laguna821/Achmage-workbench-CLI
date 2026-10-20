/**
 * Curved text: an `IText` riding an arc path. Fabric's caret maths assumes a straight baseline, so
 * while the user edits the characters the path is detached (text renders flat) and re-fitted on exit.
 */
import { FabricText, IText, Path, type FabricObject } from 'fabric'
import { clampCurve, curveGeometry } from '../text/curve'
import { customizeControls } from './controls'
import { asDory } from './dory'

type TextLike = IText

export function isTextObject(o: FabricObject | null | undefined): o is TextLike {
  return !!o && o instanceof IText
}

/** Width of the text laid out flat, ignoring any path currently attached. */
export function measureFlatWidth(t: TextLike): number {
  const probe = new FabricText(t.text || ' ', {
    fontSize: t.fontSize,
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    fontStyle: t.fontStyle,
    charSpacing: t.charSpacing,
    styles: t.styles,
  })
  return probe.width
}

/** Attaches (amount ≠ 0) or removes (amount = 0) the arc and records `curveAmount`. */
export function applyCurve(t: TextLike, amount: number): void {
  const a = clampCurve(amount)
  const d = asDory(t)
  if (a === 0) {
    t.set({ path: undefined })
    d.curveAmount = undefined
    t.initDimensions()
    t.setCoords()
    t.set('dirty', true)
    customizeControls(t)
    return
  }
  const geometry = curveGeometry(measureFlatWidth(t), a)
  t.set({ path: new Path(geometry.path, { visible: false, objectCaching: false }), textAlign: 'center' })
  d.curveAmount = a
  t.initDimensions()
  t.setCoords()
  t.set('dirty', true)
  customizeControls(t)
}

/** Re-fits the arc after the characters changed. */
export function refitCurve(t: TextLike): void {
  const amount = asDory(t).curveAmount
  if (typeof amount === 'number' && amount !== 0) applyCurve(t, amount)
}
