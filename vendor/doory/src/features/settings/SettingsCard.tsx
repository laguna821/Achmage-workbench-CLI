import type { ReactNode } from 'react'
import styles from './Settings.module.css'

export function SettingsCard({ id, title, description, children, tone }: { id: string; title: string; description?: string; children: ReactNode; tone?: 'danger' }) {
  return (
    <section id={id} className={styles.card} data-tone={tone} aria-labelledby={`${id}-title`}>
      <header className={styles.cardHeader}>
        <h2 id={`${id}-title`} className={styles.cardTitle}>
          {title}
        </h2>
        {description ? <p className={styles.cardLead}>{description}</p> : null}
      </header>
      <div className={styles.cardBody}>{children}</div>
    </section>
  )
}
