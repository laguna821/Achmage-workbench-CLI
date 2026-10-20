import { TemplatesBrowser } from '@/features/templates/TemplatesBrowser'
import { usePageTitle } from '@/lib/usePageTitle'
import styles from './pageStyles.module.css'

export default function DashboardTemplatesPage() {
  usePageTitle('Start from a template')
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1 className={styles.title}>Templates</h1>
        <p className={styles.lead}>Open a template to preview it, then add a copy to your designs.</p>
      </header>
      <TemplatesBrowser />
    </div>
  )
}
