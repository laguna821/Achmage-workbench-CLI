import { Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FontFamily } from '@/types/api'
import { useDocument, useEditor } from '../context'
import { fontStack } from '../engine/text/fontStack'
import { t } from '../strings'
import { Button, IconButton } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import { variantLabel } from './fontFile'
import { countTextLayersUsing } from './fontUsage'
import { useUserFonts, useUserFontsStore } from './userFonts'
import { useFontUploadEntry } from './useFontUploadEntry'
import styles from './YourFonts.module.css'

/** The families' own faces are loaded so each name is shown in the font it names. */
function useShowInOwnFace(families: readonly FontFamily[]): void {
  const editor = useEditor()
  useEffect(() => {
    for (const f of families) void editor.fonts.load(f.family, 400, 'normal', f.family)
  }, [editor, families])
}

function Confirm({ family, onCancel, onDone }: { family: FontFamily; onCancel: () => void; onDone: () => void }) {
  const editor = useEditor()
  const store = useUserFontsStore()
  const doc = useDocument()
  const used = countTextLayersUsing(doc, family.family)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      await store.remove(family)
      editor.toast(t.userFonts.deleted(family.family), 'info')
      onDone()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }
  return (
    <div className={styles.confirm} role="group" aria-label={t.userFonts.deleteTitle(family.family)} data-testid="font-delete-confirm">
      <strong>{t.userFonts.deleteTitle(family.family)}</strong>
      {used > 0 ? <span className={styles.used}>{t.userFonts.deleteUsed(used)}</span> : null}
      <span>{t.userFonts.deleteBody}</span>
      {failed ? (
        <span className={styles.error} role="alert">
          {t.userFonts.deleteFailed(family.family)}
        </span>
      ) : null}
      <div className={styles.confirmActions}>
        <Button size="sm" onClick={onCancel} disabled={busy} data-autofocus>
          {t.userFonts.deleteCancel}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void remove()} disabled={busy} data-testid="font-delete-confirm-button">
          {t.userFonts.deleteConfirm}
        </Button>
      </div>
    </div>
  )
}

function FamilyCard({ family, canDelete }: { family: FontFamily; canDelete: boolean }) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) return <Confirm family={family} onCancel={() => setConfirming(false)} onDone={() => setConfirming(false)} />
  return (
    <li className={styles.card} data-testid="your-font" data-family={family.family}>
      <div className={styles.cardBody}>
        <div className={styles.name} style={{ fontFamily: fontStack(family.family, family.category) }}>
          {family.family}
        </div>
        <div className={styles.styles}>{family.variants.map((v) => variantLabel(v.weight, v.style)).join(' · ')}</div>
      </div>
      {canDelete ? (
        <IconButton label={t.userFonts.deleteFont(family.family)} size="sm" tooltip={false} onClick={() => setConfirming(true)} data-testid="font-delete">
          <Trash2 size={15} aria-hidden="true" />
        </IconButton>
      ) : null}
    </li>
  )
}

/** The user's uploaded families: what each one contains, delete (with a warning when the design uses it) and upload. */
export function YourFonts() {
  const store = useUserFontsStore()
  const state = useUserFonts()
  const entry = useFontUploadEntry()
  useShowInOwnFace(state.families)
  if (state.source === 'none') return null
  const shared = state.source === 'shared'
  return (
    <section className={styles.section} aria-label={shared ? t.userFonts.groupShared : t.userFonts.manage} data-testid="your-fonts">
      <div className={styles.head}>
        <h3 className={styles.heading}>{shared ? t.userFonts.groupShared : t.userFonts.manage}</h3>
        {entry.available ? (
          <Button size="sm" variant="soft" icon={<Upload size={14} aria-hidden="true" />} onClick={entry.start} data-testid="your-fonts-upload">
            {t.userFonts.upload}
          </Button>
        ) : null}
      </div>
      {state.status === 'loading' || state.status === 'idle' ? (
        <div className={styles.loading} aria-busy="true" aria-label={t.userFonts.loading}>
          <Skeleton height={44} radius={10} />
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className={styles.errorBox} role="alert">
          <span>{state.error ?? t.userFonts.manageLoadFailed}</span>
          <Button size="sm" variant="ghost" onClick={() => void store.reload()}>
            {t.userFonts.retry}
          </Button>
        </div>
      ) : null}
      {state.status === 'ready' && state.families.length === 0 ? <p className={styles.note}>{t.userFonts.manageEmpty}</p> : null}
      {state.families.length > 0 ? (
        <ul className={styles.list}>
          {state.families.map((family) => (
            <FamilyCard key={family.id} family={family} canDelete={state.canManage} />
          ))}
        </ul>
      ) : null}
      {shared ? <p className={styles.note}>{t.userFonts.sharedNote}</p> : null}
    </section>
  )
}
