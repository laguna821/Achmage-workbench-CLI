import { RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { daysUntilPurge, TRASH_RETENTION_DAYS } from '@/features/dashboard/trash'
import { useDesignActions } from '@/features/dashboard/useDesignActions'
import { errorMessage } from '@/features/dashboard/errorMessage'
import { flattenPages, useDesignsList, useEmptyTrash } from '@/lib/api/hooks'
import { formatRelative } from '@/lib/time'
import { usePageTitle } from '@/lib/usePageTitle'
import type { DesignSummary } from '@/types/api'
import { Button, ConfirmDialog, EmptyState, IconButton, Skeleton, Thumbnail, Tooltip, useToast } from '@/ui'
import styles from './pageStyles.module.css'
import trashStyles from './TrashPage.module.css'

export default function TrashPage() {
  usePageTitle('Trash')
  const { toast } = useToast()
  const list = useDesignsList({ trashed: true, ordering: '-updated_at' })
  const designs = flattenPages(list.data)
  const actions = useDesignActions()
  const emptyTrash = useEmptyTrash()
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [toDelete, setToDelete] = useState<DesignSummary | null>(null)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>Trash</h1>
          <p className={styles.lead}>Designs in the trash are deleted automatically after {TRASH_RETENTION_DAYS} days.</p>
        </div>
        <Button variant="secondary" leftIcon={<Trash2 size={16} />} disabled={designs.length === 0} onClick={() => setConfirmEmpty(true)}>
          Empty trash
        </Button>
      </header>

      <div aria-live="polite" aria-busy={list.isPending}>
        {list.isPending ? (
          <ul className={styles.list} aria-label="Loading trash">
            {Array.from({ length: 4 }, (_, index) => (
              <li key={index}>
                <Skeleton height="4.5rem" radius="var(--radius-lg)" />
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <EmptyState title="The trash didn’t load" description={errorMessage(list.error, 'Check your connection and try again.')} role="alert" action={<Button onClick={() => void list.refetch()}>Try again</Button>} />
        ) : designs.length === 0 ? (
          <EmptyState icon={<Trash2 size={28} />} title="The trash is empty" description="Designs you delete show up here for 30 days, so nothing is lost by accident." />
        ) : (
          <ul className={styles.list}>
            {designs.map((design) => {
              const days = design.trashed_at ? daysUntilPurge(design.trashed_at) : TRASH_RETENTION_DAYS
              const title = design.title || 'Untitled design'
              return (
                <li key={design.id} className={trashStyles.row}>
                  <Thumbnail src={design.thumbnail_url} alt="" aspect={1.4} className={trashStyles.thumb} />
                  <div className={trashStyles.info}>
                    <p className={trashStyles.title}>{title}</p>
                    <p className={trashStyles.meta}>
                      Deleted {design.trashed_at ? formatRelative(design.trashed_at) : 'recently'} · {days === 0 ? 'removed today' : `${days} ${days === 1 ? 'day' : 'days'} left`}
                    </p>
                  </div>
                  <div className={trashStyles.actions}>
                    <Button size="sm" variant="secondary" leftIcon={<RotateCcw size={14} />} onClick={() => actions.restore(design)}>
                      Restore
                    </Button>
                    <Tooltip content="Delete forever">
                      <IconButton size="sm" variant="danger" label={`Delete ${title} forever`} icon={<Trash2 size={16} />} onClick={() => setToDelete(design)} />
                    </Tooltip>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {list.hasNextPage ? (
          <div className={styles.more}>
            <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Load more
            </Button>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmEmpty}
        title="Empty the trash?"
        description="Every design in the trash will be deleted permanently. This can’t be undone."
        confirmLabel="Empty trash"
        tone="danger"
        loading={emptyTrash.isPending}
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={() =>
          emptyTrash.mutate(undefined, {
            onSuccess: () => {
              setConfirmEmpty(false)
              toast({ title: 'Trash emptied', variant: 'success' })
            },
            onError: (error) => toast({ title: 'Couldn’t empty the trash', description: errorMessage(error), variant: 'error' }),
          })
        }
      />
      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete “${toDelete?.title || 'Untitled design'}” forever?`}
        description="This permanently deletes the design and can’t be undone."
        confirmLabel="Delete forever"
        tone="danger"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) actions.deleteForever(toDelete, () => setToDelete(null))
        }}
      />
    </div>
  )
}
