import { Check, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import { useEditor } from '../../context'
import { t } from '../../strings'
import ed from '../../chrome/ed.module.css'
import styles from './sections.module.css'

const ASPECTS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: t.toolbar.cropFree, ratio: null },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
]

/** Replaces the toolbar while an image is being cropped. */
export function CropSection() {
  const editor = useEditor()
  const [aspect, setAspect] = useState('free')
  return (
    <>
      <div className={styles.row} role="group" aria-label={t.tools.aspectRatio}>
        {ASPECTS.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`${ed.toolBtn} ${aspect === a.id ? ed.active : ''}`}
            aria-pressed={aspect === a.id}
            data-testid={`ed-crop-${a.id}`}
            onClick={() => {
              setAspect(a.id)
              editor.crop.setAspect(a.ratio)
            }}
          >
            <span className={ed.textButton}>{a.label}</span>
          </button>
        ))}
      </div>
      <button type="button" className={`${ed.btn} ${ed.ghost}`} data-testid="ed-crop-reset" onClick={() => editor.crop.reset()}>
        <RotateCcw size={16} aria-hidden="true" />
        {t.toolbar.reset}
      </button>
      <span className={ed.divider} aria-hidden="true" />
      <button type="button" className={`${ed.btn} ${ed.ghost}`} data-testid="ed-crop-cancel" onClick={() => editor.crop.cancel()}>
        <X size={16} aria-hidden="true" />
        {t.toolbar.cropCancel}
      </button>
      <button type="button" className={`${ed.btn} ${ed.primary}`} data-testid="ed-crop-apply" onClick={() => editor.crop.apply()}>
        <Check size={16} aria-hidden="true" />
        {t.toolbar.cropApply}
      </button>
    </>
  )
}
