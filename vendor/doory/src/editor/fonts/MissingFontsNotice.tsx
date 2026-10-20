import { AlertTriangle, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useEditor, useEditorState } from '../context'
import { usedFonts } from '../engine/docOps'
import { BODY_FONT, HEADING_FONT } from '../engine/objects/factories'
import { primaryFamily } from '../engine/text/fontStack'
import { t } from '../strings'
import { Button, IconButton } from '../ui/Button'
import { useUserFonts } from './userFonts'
import { useFontUploadEntry } from './useFontUploadEntry'
import styles from '../ConflictBanner.module.css'

const SETTLE_MS = 400

/** The app's own fonts (loaded by the shell's stylesheet, not by the catalog): always available. */
const BUNDLED = new Set([primaryFamily(HEADING_FONT), primaryFamily(BODY_FONT)].map((f) => f.toLowerCase()))

/** The fonts of the design that cannot be drawn on this device or account (so a fallback font is shown instead). */
function useUnavailableFonts(): string[] {
  const editor = useEditor()
  const doc = useEditorState((s) => s.doc)
  const library = useUserFonts()
  const [missing, setMissing] = useState<string[]>([])
  const families = useMemo(() => [...new Set(usedFonts(doc).map((f) => f.family))].filter((f) => !BUNDLED.has(f.toLowerCase())).sort(), [doc])
  const signature = families.join('\n')
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      const uses = signature ? signature.split('\n').map((family) => ({ family, weight: '400', style: 'normal' })) : []
      void editor.fonts.unavailable(uses).then((names) => {
        if (!cancelled) setMissing((prev) => (prev.join('\n') === names.join('\n') ? prev : names))
      })
    }, SETTLE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [editor, signature, library.families, library.status])
  return missing
}

/** A dismissible warning while text of the design is shown in a fallback font because its (uploaded) font is not available. */
export function MissingFontsNotice() {
  const missing = useUnavailableFonts()
  const entry = useFontUploadEntry()
  const readOnly = useEditorState((s) => s.readOnly)
  const [dismissed, setDismissed] = useState('')
  const signature = missing.join('\n')
  if (missing.length === 0 || dismissed === signature) return null
  const canFix = entry.available && !readOnly
  return (
    <div role="status" className={styles.banner} data-testid="missing-fonts">
      <AlertTriangle size={18} className={styles.icon} aria-hidden="true" />
      <div className={styles.text}>
        <strong>{t.userFonts.missing.title(missing.length)}</strong>
        <span>{t.userFonts.missing.body(missing.join(', '), missing.length > 1, canFix)}</span>
      </div>
      {canFix ? (
        <div className={styles.actions}>
          <Button size="sm" variant="primary" onClick={entry.start} data-testid="missing-fonts-upload">
            {t.userFonts.missing.upload}
          </Button>
        </div>
      ) : null}
      <IconButton label={t.userFonts.missing.dismiss} size="sm" onClick={() => setDismissed(signature)} data-testid="missing-fonts-dismiss">
        <X size={16} aria-hidden="true" />
      </IconButton>
    </div>
  )
}
