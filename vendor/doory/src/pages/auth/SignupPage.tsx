import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'
import { SignupForm } from '@/features/auth/SignupForm'
import { safeNextPath } from '@/lib/navigation'
import { usePageMeta } from '@/lib/usePageMeta'
import styles from './AuthPage.module.css'

export default function SignupPage() {
  usePageMeta({ title: 'Sign up', noindex: true })
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { status } = useAuth()
  const next = safeNextPath(params.get('next'))
  const nextQuery = params.get('next') ? `?next=${encodeURIComponent(params.get('next') ?? '')}` : ''

  if (status === 'authenticated') return <Navigate to={next} replace />

  return (
    <>
      <div className={styles.header}>
        <h1 className={styles.title}>Create your free account</h1>
        <p className={styles.lead}>Save designs to the cloud, build brand kits and share with anyone.</p>
      </div>
      <SignupForm onSuccess={() => navigate(next, { replace: true })} />
      <p className={styles.footer}>
        Already have an account? <Link to={`/login${nextQuery}`}>Log in</Link>
      </p>
    </>
  )
}
