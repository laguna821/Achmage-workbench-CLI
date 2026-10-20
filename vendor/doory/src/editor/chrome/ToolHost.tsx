import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useEditorState, usePortalRoot } from '../context'
import { type PanelDefinition } from '../panels/registry'
import { useVisiblePanels } from '../panels/useVisiblePanels'
import { t } from '../strings'
import { I } from './icons'
import { useChrome, useOpenTool } from './ChromeContext'
import ed from './ed.module.css'
import styles from './ToolHost.module.css'

function useOpenPanel(): PanelDefinition | undefined {
  const { openId } = useOpenTool()
  const visible = useVisiblePanels()
  return useMemo(() => visible.find((p) => p.id === openId), [visible, openId])
}

/** Below the desktop breakpoint the open tool is a bottom sheet over the workspace. */
export function DrawerHost() {
  const panel = useOpenPanel()
  const compact = useEditorState((s) => s.ui.compact)
  const { close } = useOpenTool()
  if (!panel || !compact) return null
  return <Sheet panel={panel} onClose={close} />
}

/** Panels stay open while things are added from them, so their "close after adding" is a no-op beside the rail. */
const keepOpen = (): void => undefined

/**
 * The open tool, docked between the rail and the workspace (desktop). It stays until its rail entry is pressed
 * again, its close button is used, or Escape is pressed inside it: clicking the design does not close it.
 */
export function SidebarHost() {
  const panel = useOpenPanel()
  const compact = useEditorState((s) => s.ui.compact)
  const { close } = useOpenTool()
  const chrome = useChrome()
  const ref = useRef<HTMLElement>(null)
  const id = panel?.id
  useEffect(() => {
    if (!id || !chrome.isKeyboardOpen()) return
    ref.current?.querySelector<HTMLElement>('input, button:not([data-close]), [tabindex="0"]')?.focus({ preventScroll: true })
  }, [id, chrome])
  if (!panel || compact) return null
  const Body = panel.component
  const title = panel.title ?? panel.label
  const closeAndReturn = (): void => {
    close()
    chrome.getAnchor(panel.id)?.focus({ preventScroll: true })
  }
  return (
    <aside
      ref={ref}
      className={styles.sidebar}
      style={{ width: Math.max(320, panel.width ?? 0) }}
      aria-label={title}
      data-testid={`sidebar-${panel.id}`}
      data-panel={panel.id}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        e.stopPropagation()
        closeAndReturn()
      }}
    >
      <header className={styles.sidebarHead}>
        <h2 className={styles.sidebarTitle}>{title}</h2>
        <button type="button" className={styles.close} onClick={closeAndReturn} aria-label={t.chrome.closeTool(title)} data-testid="sidebar-close" data-close>
          {I.xClear}
        </button>
      </header>
      {panel.placement === 'drawer' ? (
        <div className={styles.sidebarScroll} data-testid={`drawer-${panel.id}`}>
          <Body close={keepOpen} />
        </div>
      ) : (
        <div className={styles.sidebarBody}>
          <Body close={close} />
        </div>
      )}
    </aside>
  )
}

function Sheet({ panel, onClose }: { panel: PanelDefinition; onClose: () => void }) {
  const root = usePortalRoot()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  if (!root) return null
  const Body = panel.component
  const drawer = panel.placement === 'drawer'
  return createPortal(
    <>
      <div className={styles.backdrop} onPointerDown={onClose} aria-hidden="true" />
      <div ref={ref} className={styles.sheet} role="dialog" aria-label={panel.title ?? panel.label} tabIndex={-1} data-testid={`sheet-${panel.id}`}>
        <span className={styles.grab} aria-hidden="true" />
        <header className={styles.sheetHead}>
          <h2 className={styles.sidebarTitle}>{panel.title ?? panel.label}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t.chrome.closeTool(panel.title ?? panel.label)} data-testid="sheet-close">
            <X size={16} />
          </button>
        </header>
        <div className={styles.sheetBody}>
          {drawer ? (
            <div className={ed.drawerBody}>
              <Body close={onClose} />
            </div>
          ) : (
            <div className={styles.sidebarBody}>
              <Body close={onClose} />
            </div>
          )}
        </div>
      </div>
    </>,
    root,
  )
}
