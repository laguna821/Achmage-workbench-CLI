import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Accent } from '@/features/marketing/PageIntro'
import { deleteLocalDesign, listLocalDesigns, type LocalDesignSummary } from '@/lib/local'
import { formatRelative } from '@/lib/time'
import { useBlobUrl } from '@/lib/useBlobUrl'
import { ConfirmDialog, Thumbnail, useToast } from '@/ui'
import styles from './LocalDesignsStrip.module.css'

function LocalCard({ design, onDelete }: { design: LocalDesignSummary; onDelete(design: LocalDesignSummary): void }) {
  const url = useBlobUrl(design.thumbnail)
  const title = design.title || 'Untitled design'
  return (
    <li className={styles.card}>
      <Link to={`/local/${design.id}`} className={styles.link}>
        <Thumbnail src={url} alt={`${title} preview`} aspect={4 / 3} fit="contain" className={styles.thumb} />
        <span className={styles.title}>{title}</span>
        <span className={styles.meta}>edited {formatRelative(design.updatedAt)}</span>
      </Link>
      <button type="button" className={styles.delete} aria-label={`Delete ${title}`} title="Delete" onClick={() => onDelete(design)}>
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </li>
  )
}

/** Guests can’t reach a dashboard, so designs saved in this browser are listed on the landing page. */
export function LocalDesignsStrip() {
  const { toast } = useToast()
  const [designs, setDesigns] = useState<LocalDesignSummary[]>([])
  const [pending, setPending] = useState<LocalDesignSummary | null>(null)

  const refresh = useCallback(async () => {
    try {
      setDesigns(await listLocalDesigns())
    } catch {
      setDesigns([])
    }
  }, [])

  useEffect(() => {
    let active = true
    listLocalDesigns()
      .then((list) => active && setDesigns(list))
      .catch(() => active && setDesigns([]))
    return () => {
      active = false
    }
  }, [])

  if (designs.length === 0) return null

  return (
    <section id="local-designs" className={styles.section} aria-labelledby="local-designs-title">
      <div className={styles.panel}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>on this device</p>
          <h2 id="local-designs-title" className={styles.heading}>
            Pick up where you <Accent>left off</Accent>
          </h2>
          <p className={styles.lead}>
            These designs are saved in this browser.{' '}
            <Link to="/signup" className={styles.signup}>
              Sign up
            </Link>{' '}
            to keep them in your account and open them anywhere.
          </p>
        </header>
        <ul className={styles.grid}>
          {designs.map((design) => (
            <LocalCard key={design.id} design={design} onDelete={setPending} />
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={pending !== null}
        title={`Delete “${pending?.title || 'Untitled design'}”?`}
        description="It’s stored only in this browser, so it can’t be recovered once deleted."
        confirmLabel="Delete design"
        tone="danger"
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          if (!pending) return
          try {
            await deleteLocalDesign(pending.id)
            toast({ title: 'Design deleted', variant: 'success' })
          } catch {
            toast({ title: 'Couldn’t delete the design', description: 'Please try again.', variant: 'error' })
          }
          setPending(null)
          await refresh()
        }}
      />
    </section>
  )
}
