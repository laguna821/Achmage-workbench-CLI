import { Navigate, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'
import { LoginForm } from '@/features/auth/LoginForm'
import { safeNextPath } from '@/lib/navigation'
import { usePageMeta } from '@/lib/usePageMeta'
import styles from './AuthPage.module.css'

export default function LoginPage() {
  usePageMeta({ title: 'Log in', noindex: true })
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { status } = useAuth()
  const next = safeNextPath(params.get('next'))
  const nextQuery = params.get('next') ? `?next=${encodeURIComponent(params.get('next') ?? '')}` : ''

  if (status === 'authenticated') return <Navigate to={next} replace />

  return (
    <>
      <div className={styles.header}>
        <h1 className={styles.title}>Welcome back</h1>
        <p className={styles.lead}>Log in to pick up where you left off.</p>
      </div>
      <LoginForm onSuccess={() => navigate(next, { replace: true })} />
      <p className={styles.footer}>
        New to Doory? <Link to={`/signup${nextQuery}`}>Create a free account</Link>
      </p>
    </>
  )
}
