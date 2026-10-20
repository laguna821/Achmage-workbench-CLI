import { BadgeCheck, MailWarning } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/features/auth/AuthProvider'
import { rateLimitMessage } from '@/features/auth/errors'
import { authApi, isApiError } from '@/lib/api'
import { Badge, Button, Input, useToast } from '@/ui'
import { SettingsCard } from './SettingsCard'
import styles from './Settings.module.css'

export function EmailSection() {
  const { user, config } = useAuth()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  if (!user) return null

  async function resend() {
    setBusy(true)
    try {
      await authApi.resendVerification()
      toast({ title: 'Verification email sent', description: `Check ${user?.email}.`, variant: 'success' })
    } catch (error) {
      toast({ title: 'Couldn’t send the email', description: isApiError(error) && error.isRateLimited ? rateLimitMessage(error.retryAfter) : 'Please try again shortly.', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard id="email" title="Email" description="Used to sign in and to recover your account.">
      <Input label="Email address" value={user.email} readOnly hint="To use a different address, create a new account." />
      <div className={styles.inline}>
        {user.is_email_verified ? (
          <Badge tone="success">
            <BadgeCheck size={12} aria-hidden="true" /> Verified
          </Badge>
        ) : (
          <>
            <Badge tone="warning">
              <MailWarning size={12} aria-hidden="true" /> Not verified
            </Badge>
            {config.features.email_verification ? (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void resend()}>
                Resend verification email
              </Button>
            ) : null}
          </>
        )}
        {user.google_linked ? <Badge tone="info">Google linked</Badge> : null}
      </div>
    </SettingsCard>
  )
}
