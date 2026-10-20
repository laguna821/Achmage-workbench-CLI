/**
 * The note shown while the design uses sounds that must be credited (CC BY): the lines to publish and a button that
 * copies them. Nothing is shown for CC0 sounds.
 */
import { Copy, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { useEditor, useEditorState } from '../context'
import { requiredCredits } from '../audio/credits'
import { readTracks } from '../audio/model'
import { copyText } from '../dialogs/copyText'
import { t } from '../strings'
import { Button } from '../ui/Button'
import styles from './Audio.module.css'

export function AudioCredits() {
  const editor = useEditor()
  const doc = useEditorState((s) => s.doc)
  const credits = useMemo(() => requiredCredits(readTracks(doc)), [doc])
  if (credits.length === 0) return null
  const text = credits.map((c) => c.line).join('\n')
  return (
    <div className={styles.creditNote} role="note" data-testid="audio-credits">
      <div className={styles.creditHead}>
        <TriangleAlert size={16} aria-hidden="true" className={styles.creditIcon} />
        <p>{t.audio.credits.summary(credits.length)}</p>
        <Button
          size="sm"
          variant="soft"
          icon={<Copy size={13} aria-hidden="true" />}
          data-testid="audio-credits-copy"
          onClick={() => void copyText(text).then((ok) => editor.toast(ok ? t.audio.credits.copied : t.audio.credits.copyFailed, ok ? 'info' : 'error'))}
        >
          {t.audio.credits.copy}
        </Button>
      </div>
      <details>
        <summary>{t.audio.credits.show}</summary>
        <p className={styles.creditHint}>{t.audio.credits.note}</p>
        <pre data-testid="audio-credits-text">{text}</pre>
      </details>
    </div>
  )
}
