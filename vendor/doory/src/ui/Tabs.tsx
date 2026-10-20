import { createContext, useContext, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from '@/lib/cx'
import { useControllableState } from './hooks'
import styles from './Tabs.module.css'

interface TabsContextValue {
  value: string
  setValue(next: string): void
  baseId: string
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('Tabs components must be rendered inside <Tabs>')
  return ctx
}

export interface TabsProps {
  value?: string
  defaultValue: string
  onValueChange?: (value: string) => void
  children: ReactNode
  className?: string
}

export function Tabs({ value, defaultValue, onValueChange, children, className }: TabsProps) {
  const baseId = useId()
  const [current, setCurrent] = useControllableState<string>(value, defaultValue, onValueChange)
  return (
    <TabsContext.Provider value={{ value: current, setValue: setCurrent, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  )
}

export function TabList({ label, children, className, fill }: { label: string; children: ReactNode; className?: string; fill?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])
    const index = tabs.findIndex((tab) => tab === document.activeElement)
    if (index < 0) return
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    if (next < 0) return
    event.preventDefault()
    tabs[next].focus()
    tabs[next].click()
  }
  return (
    <div ref={ref} role="tablist" aria-label={label} className={cx(styles.list, fill && styles.fill, className)} onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}

export function Tab({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) {
  const { value: current, setValue, baseId } = useTabs()
  const selected = current === value
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      className={styles.tab}
      onClick={() => setValue(value)}
    >
      {children}
    </button>
  )
}

export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const { value: current, baseId } = useTabs()
  if (current !== value) return null
  return (
    <div role="tabpanel" id={`${baseId}-panel-${value}`} aria-labelledby={`${baseId}-tab-${value}`} tabIndex={0} className={cx(styles.panel, className)}>
      {children}
    </div>
  )
}
