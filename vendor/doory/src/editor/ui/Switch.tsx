import styles from './Switch.module.css'

interface SwitchProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
}

export function Switch({ label, checked, onChange, hint }: SwitchProps) {
  return (
    <label className={styles.row}>
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </span>
      <input type="checkbox" role="switch" className={styles.input} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </label>
  )
}
