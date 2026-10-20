import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef } from 'react'
import { useEditor, useEditorState } from '../context'

interface ChromeValue {
  /** Remembers the rail entry (or top-bar button) of each tool, so closing its panel can give focus back to it. */
  setAnchor(id: string, el: HTMLElement | null): void
  getAnchor(id: string): HTMLElement | null
  /** Remembers whether the open tool was opened from the keyboard, so its panel takes focus (a pointer click leaves focus alone). */
  setKeyboardOpen(value: boolean): void
  isKeyboardOpen(): boolean
}

const ChromeContext = createContext<ChromeValue | null>(null)

export function ChromeProvider({ children }: { children: ReactNode }) {
  const anchors = useRef(new Map<string, HTMLElement>())
  const keyboard = useRef(false)
  const value = useMemo<ChromeValue>(
    () => ({
      setAnchor(id, el) {
        if (el) anchors.current.set(id, el)
        else anchors.current.delete(id)
      },
      getAnchor: (id) => anchors.current.get(id) ?? null,
      setKeyboardOpen(next) {
        keyboard.current = next
      },
      isKeyboardOpen: () => keyboard.current,
    }),
    [],
  )
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>
}

export function useChrome(): ChromeValue {
  const value = useContext(ChromeContext)
  if (!value) throw new Error('useChrome must be used inside <ChromeProvider>')
  return value
}

/** The tool (drawer or sidebar) that is open, plus ways to toggle it. Backed by `ui.panelId` in the store. */
export function useOpenTool(): { openId: string | null; toggle(id: string): void; close(): void } {
  const editor = useEditor()
  const openId = useEditorState((s) => s.ui.panelId)
  const toggle = useCallback(
    (id: string) => {
      editor.patchUi({ panelId: editor.state.ui.panelId === id ? null : id })
    },
    [editor],
  )
  const close = useCallback(() => editor.patchUi({ panelId: null }), [editor])
  return { openId, toggle, close }
}
