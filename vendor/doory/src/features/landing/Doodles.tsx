import styles from './Doodles.module.css'

/** Hand-drawn sparkles, hearts and squiggles floating behind the landing hero. Decorative only. */
export function Doodles() {
  return (
    <div className={styles.doodles} aria-hidden="true">
      <svg className={styles.d1} width="44" height="44" viewBox="0 0 44 44" stroke="var(--accent-lilac)">
        <path d="M22 4 C 23 16, 28 21, 40 22 C 28 23, 23 28, 22 40 C 21 28, 16 23, 4 22 C 16 21, 21 16, 22 4 Z" />
      </svg>
      <svg className={styles.d2} width="46" height="40" viewBox="0 0 46 40" stroke="#ff8fa6">
        <path d="M23 36 C 8 26, 3 18, 6 11 C 9 4, 19 4, 23 12 C 27 4, 37 4, 40 11 C 43 18, 38 26, 23 36 Z" />
      </svg>
      <svg className={styles.d3} width="70" height="24" viewBox="0 0 70 24" stroke="#6fbf98">
        <path d="M3 12 C 10 2, 17 2, 24 12 S 38 22, 45 12 S 59 2, 67 12" />
      </svg>
      <svg className={styles.d4} width="40" height="40" viewBox="0 0 40 40" stroke="#e8b84a">
        <circle cx="20" cy="20" r="7" />
        <path d="M20 3v6M20 31v6M3 20h6M31 20h6M8 8l4 4M28 28l4 4M8 32l4-4M28 12l4-4" />
      </svg>
      <svg className={styles.d5} width="36" height="36" viewBox="0 0 36 36" stroke="#ff8fa6">
        <path d="M18 3 C 19 13, 23 17, 33 18 C 23 19, 19 23, 18 33 C 17 23, 13 19, 3 18 C 13 17, 17 13, 18 3 Z" />
      </svg>
      <svg className={styles.d6} width="54" height="54" viewBox="0 0 54 54" stroke="var(--accent-lilac)">
        <path d="M27 27 m-3 0 a3 3 0 1 1 6 0 a7 7 0 1 1 -14 0 a11 11 0 1 1 22 0 a15 15 0 1 1 -30 0" />
      </svg>
    </div>
  )
}
