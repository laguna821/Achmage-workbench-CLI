import { TemplatesBrowser } from '@/features/templates/TemplatesBrowser'
import { usePageMeta } from '@/lib/usePageMeta'
import styles from './TemplatesPage.module.css'

export default function TemplatesPage() {
  usePageMeta({ title: 'Free design templates', description: 'Browse free, fully editable templates for social posts, presentations, posters, cards and more. Open one in your browser, no account required.', canonical: '/templates', image: '/og-image.png' })
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Templates</p>
        <h1 className={styles.title}>Start with something beautiful</h1>
        <p className={styles.lead}>Every template is free and fully editable. Open one and change anything. No account required.</p>
      </header>
      <TemplatesBrowser />
    </div>
  )
}
