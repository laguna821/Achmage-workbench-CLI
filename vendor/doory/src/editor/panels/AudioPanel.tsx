/**
 * The Audio tool (a docked sidebar): play the page or the whole design with its sound, add music, effects, uploads or a
 * voiceover from the tabs (Freesound appears when the server has it), and manage the tracks of the design below. A view-only design shows just the transport
 * and the tracks. The tab last used is kept while the editor stays open.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { AudioStockInfo } from '@/types/api'
import { useEditor, useEditorState } from '../context'
import { t } from '../strings'
import { AudioCredits } from './AudioCredits'
import { AudioFreesoundTab } from './AudioFreesoundTab'
import { AudioLibraryTab } from './AudioLibraryTab'
import { AudioRecordTab } from './AudioRecordTab'
import { AudioTracks } from './AudioTracks'
import { AudioTransport } from './AudioTransport'
import { AudioUploadsTab } from './AudioUploadsTab'
import styles from './Audio.module.css'

type TabId = 'library' | 'freesound' | 'uploads' | 'record'
type FreesoundInfo = Extract<AudioStockInfo, { configured: true }>

const ALL_TABS: readonly { id: TabId; label: string }[] = [
  { id: 'library', label: t.audio.tabs.library },
  { id: 'freesound', label: t.audio.tabs.freesound },
  { id: 'uploads', label: t.audio.tabs.uploads },
  { id: 'record', label: t.audio.tabs.record },
]

/** Asked once per service: whether the server offers Freesound. Any failure just hides the tab. */
const infoCache = new WeakMap<object, Promise<FreesoundInfo | null>>()

function useFreesound(): FreesoundInfo | null {
  const service = useEditor().adapter.services.audioStock
  const [info, setInfo] = useState<FreesoundInfo | null>(null)
  useEffect(() => {
    if (!service) return
    let request = infoCache.get(service)
    if (!request) {
      request = service.info().then(
        (found) => (found.configured ? found : null),
        () => null,
      )
      infoCache.set(service, request)
    }
    let live = true
    void request.then((found) => live && setInfo(found))
    return () => {
      live = false
    }
  }, [service])
  return info
}

/** The last tab used, kept for the page's lifetime so reopening the tool lands where the person left off. */
const memory: { tab: TabId } = { tab: 'library' }

function remember(id: TabId): void {
  memory.tab = id
}

export function AudioPanel() {
  const readOnly = useEditorState((s) => s.readOnly)
  const freesound = useFreesound()
  const TABS = ALL_TABS.filter((item) => item.id !== 'freesound' || freesound)
  const [chosen, setTab] = useState<TabId>(memory.tab)
  const tab = TABS.some((item) => item.id === chosen) ? chosen : 'library'
  const base = useId()
  const refs = useRef<Record<TabId, HTMLButtonElement | null>>({ library: null, freesound: null, uploads: null, record: null })

  const select = (id: TabId, focus: boolean): void => {
    remember(id)
    setTab(id)
    if (focus) refs.current[id]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    let next = index
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    else return
    e.preventDefault()
    select(TABS[next].id, true)
  }

  return (
    <div className={styles.panel} data-testid="audio-panel">
      <AudioTransport />
      <AudioCredits />
      {readOnly ? null : (
        <div className={styles.sources}>
          <div role="tablist" aria-label={t.audio.tabs.label} className={styles.tablist}>
            {TABS.map((item, index) => (
              <button
                key={item.id}
                ref={(node) => {
                  refs.current[item.id] = node
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls={`${base}-panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                className={styles.tabButton}
                data-testid={`audio-tab-${item.id}`}
                onClick={() => select(item.id, false)}
                onKeyDown={(e) => onKeyDown(e, index)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${base}-panel-${tab}`} aria-labelledby={`${base}-tab-${tab}`} className={styles.tabPanel}>
            {tab === 'library' ? <AudioLibraryTab /> : tab === 'freesound' && freesound ? <AudioFreesoundTab info={freesound} /> : tab === 'uploads' ? <AudioUploadsTab /> : <AudioRecordTab />}
          </div>
        </div>
      )}
      <AudioTracks readOnly={readOnly} />
    </div>
  )
}
