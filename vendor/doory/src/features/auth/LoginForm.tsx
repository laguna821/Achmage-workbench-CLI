import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Input } from '@/ui'
import type { ApiUser } from '@/types/api'
import { useAuth } from './AuthProvider'
import { describeFormError } from './errors'
import { GoogleButton } from './GoogleButton'
import { PasswordInput } from './PasswordInput'
import styles from './AuthForms.module.css'

export interface LoginFormProps {
  onSuccess(user: ApiUser): void
  /** In the modal the "forgot password" link must close the dialog first. */
  onNavigate?: () => void
  autoFocus?: boolean
  /** Signing in again after the session ended: the address is fixed and only that account is accepted. */
  lockedEmail?: string
  expectUserId?: string
}

const FIELDS = ['email', 'password'] as const

export function LoginForm({ onSuccess, onNavigate, autoFocus = true, lockedEmail, expectUserId }: LoginFormProps) {
  const { login, google } = useAuth()
  const [email, setEmail] = useState(lockedEmail ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  async function submit(event: FormEvent) {
    event.preventDefault()
    const errors: Record<string, string> = {}
    if (!email.trim()) errors.email = 'Enter your email address.'
    else if (!/^\S+@\S+\.\S+$/.test(email.trim())) errors.email = 'That doesn’t look like an email address.'
    if (!password) errors.password = 'Enter your password.'
    setFieldErrors(errors)
    setFormError('')
    if (Object.keys(errors).length > 0) return
    setBusy(true)
    try {
      onSuccess(await login({ email: email.trim(), password }, { expectUserId }))
    } catch (error) {
      const failure = describeFormError(error, FIELDS)
      setFormError(failure.message)
      setFieldErrors(failure.fields)
      setBusy(false)
    }
  }

  async function handleGoogle(credential: string) {
    setFormError('')
    try {
      onSuccess(await google(credential, { expectUserId }))
    } catch (error) {
      setFormError(describeFormError(error, FIELDS).message)
    }
  }

  return (
    <div className={styles.stack}>
      <form className={styles.form} onSubmit={submit} noValidate aria-label="Log in">
        {formError ? (
          <div className={styles.alert} role="alert">
            {formError}
          </div>
        ) : null}
        <Input label="Email" type="email" name="email" autoComplete="email" inputMode="email" autoFocus={autoFocus && !lockedEmail} readOnly={Boolean(lockedEmail)} value={email} onChange={(event) => setEmail(event.target.value)} error={fieldErrors.email} required />
        <PasswordInput
          label="Password"
          name="password"
          autoComplete="current-password"
          autoFocus={autoFocus && Boolean(lockedEmail)}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
          required
          labelAside={
            <Link to="/forgot-password" className={styles.inlineLink} onClick={onNavigate} {...(lockedEmail ? { target: '_blank', rel: 'noopener' } : {})}>
              Forgot password?
            </Link>
          }
        />
        <Button type="submit" fullWidth loading={busy}>
          Log in
        </Button>
      </form>
      <GoogleDivider />
      <GoogleButton onCredential={handleGoogle} text="signin_with" />
    </div>
  )
}

/** "or" divider shown only when the Google button will render. */
export function GoogleDivider() {
  const { config } = useAuth()
  if (!config.google_client_id) return null
  return (
    <div className={styles.divider} role="separator">
      <span>or</span>
    </div>
  )
}
