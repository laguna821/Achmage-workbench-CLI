import { GitBranch, Menu as MenuIcon, X } from 'lucide-react'
import { Suspense, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { PageLoader } from '@/app/PageLoader'
import { AccountMenu } from '@/features/auth/AccountMenu'
import { useAuth } from '@/features/auth/AuthProvider'
import bunny from '@/assets/bunny-sticker.webp'
import { REPO_URL } from '@/lib/links'
import { IconButton, LinkButton, Logo } from '@/ui'
import { cx } from '@/lib/cx'
import styles from './MarketingLayout.module.css'

const NAV = [
  { to: '/templates', label: 'Templates' },
  { to: '/features', label: 'Features' },
  { to: '/faq', label: 'FAQ' },
  { to: '/contact', label: 'Contact' },
] as const

function HeaderNav({ onNavigate, orientation }: { onNavigate?: () => void; orientation: 'row' | 'column' }) {
  return (
    <nav aria-label="Main" className={cx(styles.nav, orientation === 'column' && styles.navColumn)}>
      {NAV.map((item) => (
        <NavLink key={item.to} to={item.to} className={styles.navLink} onClick={onNavigate}>
          {item.label}
        </NavLink>
      ))}
      <a href={REPO_URL} className={styles.navLink} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
        <GitBranch size={16} aria-hidden="true" /> GitHub
      </a>
    </nav>
  )
}

export function MarketingHeader() {
  const { status } = useAuth()
  const location = useLocation()
  const place = `${location.pathname}${location.hash}`
  // The menu is "open for" the place it was opened on, so navigating anywhere closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null)
  const open = openAt === place
  const setOpen = (next: boolean) => setOpenAt(next ? place : null)

  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <Link to="/" className={styles.logo} aria-label="Doory home">
          <Logo height={30} />
        </Link>
        <div className={styles.desktopNav}>
          <HeaderNav orientation="row" />
        </div>
        <div className={styles.actions}>
          {status === 'authenticated' ? (
            <>
              <LinkButton to="/dashboard" variant="secondary" size="sm" className={styles.hideSmall}>
                Dashboard
              </LinkButton>
              <AccountMenu />
            </>
          ) : (
            <>
              <Link to="/login" className={cx(styles.hideSmall, styles.signIn)}>
                Sign in
              </Link>
              <LinkButton to="/create" size="sm">
                Start designing
              </LinkButton>
            </>
          )}
          <IconButton
            className={styles.menuButton}
            label={open ? 'Close menu' : 'Open menu'}
            icon={open ? <X size={20} /> : <MenuIcon size={20} />}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen(!open)}
          />
        </div>
      </div>
      {open ? (
        <div id="mobile-nav" className={styles.mobilePanel}>
          <HeaderNav orientation="column" onNavigate={() => setOpen(false)} />
          {status !== 'authenticated' ? (
            <LinkButton to="/login" variant="secondary" fullWidth>
              Sign in
            </LinkButton>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}

export function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <svg className={styles.wave} viewBox="0 0 1440 40" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 28 C 160 6, 320 6, 480 22 S 800 40, 960 20 S 1280 2, 1440 22 L 1440 40 L 0 40 Z" />
      </svg>
      <img className={styles.peek} src={bunny} alt="" width={110} height={150} draggable={false} />
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <Logo height={28} />
          <p>Free, open-source design for everyone. Make it, share it, keep it.</p>
        </div>
        <nav aria-label="Footer" className={styles.footerNav}>
          <div>
            <h2 className={styles.footerHeading}>Make things</h2>
            <ul>
              <li>
                <Link to="/create">Start designing</Link>
              </li>
              <li>
                <Link to="/templates">Templates</Link>
              </li>
              <li>
                <Link to="/signup">Create an account</Link>
              </li>
            </ul>
          </div>
          <div>
            <h2 className={styles.footerHeading}>Get to know us</h2>
            <ul>
              <li>
                <Link to="/features">Features</Link>
              </li>
              <li>
                <Link to="/faq">FAQ</Link>
              </li>
              <li>
                <Link to="/contact">Contact</Link>
              </li>
            </ul>
          </div>
          <div>
            <h2 className={styles.footerHeading}>Open source</h2>
            <ul>
              <li>
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  Source on GitHub
                </a>
              </li>
              <li>
                <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">
                  Report an issue
                </a>
              </li>
              <li>
                <a href={`${REPO_URL}#quick-start`} target="_blank" rel="noopener noreferrer">
                  Self-host Doory
                </a>
              </li>
            </ul>
          </div>
        </nav>
      </div>
      {/* The attribution the Attribution Assurance License (LICENSE) asks every copy of Doory to display. */}
      <p className={styles.legal}>
        Doory by Siam, creator and maintainer of Doory ·{' '}
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          github.com/shaongitbd/doory
        </a>{' '}
        · Released under the Attribution Assurance License. No ads. No watermarks.
      </p>
    </footer>
  )
}

export function MarketingLayout() {
  return (
    <div className={styles.page}>
      <MarketingHeader />
      <main id="main" tabIndex={-1} className={styles.main}>
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
      <MarketingFooter />
    </div>
  )
}
