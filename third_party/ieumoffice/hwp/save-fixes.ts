// Adapted from IeumOffice apps/hwp/src/main/save-fixes.ts @ 8602a39410adb86037f3008588b64efc75b08c60.
// Apache-2.0; see ../LICENSE and ../NOTICE. Changes recorded in hwp.manifest.json.
import { restoreFieldKinds } from './field-kinds.ts'
import type { FieldKinds } from './field-kinds.ts'
import { restoreSectionTails } from './section-tails.ts'
import type { RestoreSkip, SectionTails } from './section-tails.ts'
import { writePreview } from './preview-parts.ts'
import { writeTabWidths } from './tab-widths.ts'
import type { HwpFormat, MeasuredTab, SavePreview } from '../../../packages/contracts/src/hwp.ts'

/**
 * What a save corrects against the file the view opened: kept when the file is
 * read (section tails and field kinds of an `.hwp`), applied to what the engine
 * exports.
 */
export interface SaveBase {
  tails?: SectionTails | undefined
  kinds?: FieldKinds | undefined
}

export interface SaveFixResult {
  bytes: Uint8Array
  /** why master pages or memos of the opened file could not be carried over */
  tailsSkipped?: RestoreSkip
}

/**
 * The corrections a save makes to the engine's bytes before they are written, in
 * their order: tabs, field kinds, section tails, preview (see AGENTS.md). Both the save
 * and the recovery copy go through here, so a copy holds the bytes a save at that
 * moment would have written. A recovery copy brings no preview: it stays in the app's
 * data folder, and the save after restoring it writes a fresh one.
 */
export function applySaveFixes(
  data: Uint8Array,
  format: HwpFormat,
  tabs: readonly MeasuredTab[] | undefined,
  base: SaveBase,
  preview?: SavePreview,
): SaveFixResult {
  let bytes = data
  // the tabs first: their places were found in the engine's bytes, and putting the
  // tails back leaves the body of each section as it is
  if (tabs && tabs.length > 0) {
    bytes = writeTabWidths(bytes, format, tabs as MeasuredTab[]).bytes
  }
  const kinds = format === 'hwp' ? base.kinds : undefined
  if (kinds) bytes = restoreFieldKinds(bytes, kinds).bytes
  const tails = format === 'hwp' ? base.tails : undefined
  let tailsSkipped: RestoreSkip | undefined
  if (tails) {
    const result = restoreSectionTails(bytes, tails)
    tailsSkipped = result.skipped
    bytes = result.bytes
  }
  // last: the preview parts are whole streams and zip entries no fix above reads
  if (preview) bytes = writePreview(bytes, format, preview) ?? bytes
  return tailsSkipped ? { bytes, tailsSkipped } : { bytes }
}
