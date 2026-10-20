export interface PasswordCheck {
  id: 'length' | 'letters' | 'variety'
  label: string
  passed: boolean
}

export interface PasswordStrength {
  /** 0 (empty/very weak) … 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4
  label: 'Too weak' | 'Weak' | 'Okay' | 'Good' | 'Strong'
  checks: PasswordCheck[]
  /** True when the rules the server enforces by default are met. */
  acceptable: boolean
}

export const MIN_PASSWORD_LENGTH = 8

const COMMON = new Set(['password', 'password1', '12345678', '123456789', 'qwertyui', 'qwerty123', 'iloveyou', 'letmein1', '11111111', 'abc12345'])

const LABELS: PasswordStrength['label'][] = ['Too weak', 'Weak', 'Okay', 'Good', 'Strong']

/** Client-side guidance only; the server remains the source of truth for what it accepts. */
export function evaluatePassword(password: string): PasswordStrength {
  const hasLetter = /\p{L}/u.test(password)
  const onlyDigits = password.length > 0 && /^\d+$/.test(password)
  const classes = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length
  const checks: PasswordCheck[] = [
    { id: 'length', label: `At least ${MIN_PASSWORD_LENGTH} characters`, passed: password.length >= MIN_PASSWORD_LENGTH },
    { id: 'letters', label: 'Not only numbers', passed: password.length > 0 && !onlyDigits && hasLetter },
    { id: 'variety', label: 'A mix of letters, numbers or symbols', passed: classes >= 2 },
  ]
  const acceptable = checks[0].passed && checks[1].passed && !COMMON.has(password.toLowerCase())
  let score = 0
  if (password.length > 0) score = 1
  if (acceptable) score = 2
  if (acceptable && classes >= 2 && password.length >= 10) score = 3
  if (acceptable && classes >= 3 && password.length >= 12) score = 4
  const bounded = Math.min(score, 4) as PasswordStrength['score']
  return { score: bounded, label: LABELS[bounded], checks, acceptable }
}
