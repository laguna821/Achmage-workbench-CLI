import { Link } from 'react-router-dom'
import { Logo } from '@/ui'
import styles from './EditorHomeLink.module.css'

/** Logo mark in the editor top bar: back to the dashboard (signed in) or the landing page. */
export function EditorHomeLink({ to }: { to: '/dashboard' | '/' }) {
  return (
    <Link to={to} className={styles.link} aria-label={to === '/dashboard' ? 'Back to your dashboard' : 'Doory home'}>
      <Logo variant="mark" height={28} />
    </Link>
  )
}
