/**
 * The Freesound tab: search Freesound through the server (music, effects, ambience; the server allows only CC0, or CC0
 * and CC BY), listen to a short preview and add a sound to the design or the page. Adding copies the sound into the
 * person's uploads; a CC BY sound keeps its credit on the track so the design can list what must be credited.
 */
import { ExternalLink, FilePlus, Loader2, Pause, Play, Plus, Search, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isApiError } from '@/lib/api'
import type { AudioStockInfo, StockSound } from '@/types/api'
import type { TrackCredit } from '@/types/document'
import { useEditor, useEditorState } from '../context'
import { useDebounced } from '../hooks/useDebounced'
import { formatSeconds } from '../animation/timelineMath'
import { audioRuntime, usePreview } from '../audio/runtime'
import { t } from '../strings'
import { Button, IconButton } from '../ui/Button'
import { Select } from '../ui/Select'
import { Segmented } from '../ui/Segmented'
import { Tooltip } from '../ui/Tooltip'
import styles from './Audio.module.css'

type Info = Extract<AudioStockInfo, { configured: true }>
type Kind = 'all' | 'music' | 'effects' | 'ambience'
type Status = 'idle' | 'loading' | 'ready' | 'failed' | 'busy'

const s = t.audio.freesound

function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button type="button" className={styles.chip} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  )
}

/** "Whoosh_22.wav" -> "Whoosh 22": no file extension, underscores as spaces. The credit keeps the real title. */
function displayTitle(title: string): string {
  const clean = title
    .replace(/\.(wav|mp3|aiff?|flac|ogg|m4a|opus|wma)$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean || title
}

/** 12.6 s under a minute, else 3:05. */
function duration(ms: number): string {
  if (ms < 60_000) return formatSeconds(ms)
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function SoundRow({ sound, canWrite, busy, onAdd }: { sound: StockSound; canWrite: boolean; busy: boolean; onAdd(scope: 'design' | 'page'): void }) {
  const editor = useEditor()
  const { previewer } = audioRuntime(editor)
  const preview = usePreview()
  const key = `fs:${sound.id}`
  const mine = preview.key === key
  const playing = mine && preview.status === 'playing'
  const url = editor.adapter.services.audioStock?.previewUrl(sound.id) ?? ''
  const title = displayTitle(sound.title)
  const progress = mine && preview.status !== 'idle' ? Math.min(1, preview.positionMs / Math.max(1, preview.durationMs || sound.duration_ms)) : 0
  return (
    <li className={styles.fsRow} data-kind={sound.type} data-playing={playing || undefined} data-testid={`audio-fs-${sound.id}`}>
      <div className={styles.fsTop}>
        <IconButton
          label={playing ? t.audio.library.pause(title) : t.audio.library.preview(title)}
          variant="soft"
          size="sm"
          className={styles.fsPlay}
          pressed={playing}
          tooltip={false}
          data-testid="audio-fs-play"
          onClick={() => void previewer.toggle(key, async () => url, { durationMs: sound.duration_ms })}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </IconButton>
        <span className={styles.fsDuration}>{duration(sound.duration_ms)}</span>
        <div className={styles.fsActions}>
          {sound.credit_required ? (
            <Tooltip label={s.creditHint(sound.license)} side="bottom">
              <span className={styles.fsCredit} tabIndex={0} role="img" aria-label={s.creditHint(sound.license)} data-testid="audio-fs-by">
                <TriangleAlert size={14} aria-hidden="true" />
              </span>
            </Tooltip>
          ) : null}
          <span className={styles.fsMore}>
            {sound.source_url ? (
              <Tooltip label={s.open(title)} side="bottom">
                <a className={styles.rowLink} href={sound.source_url} target="_blank" rel="noopener noreferrer" aria-label={s.open(title)}>
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </Tooltip>
            ) : null}
            {canWrite ? (
              <IconButton label={t.audio.library.addLabelPage(title)} size="sm" disabled={busy} data-testid="audio-fs-add-page" onClick={() => onAdd('page')}>
                <FilePlus size={14} />
              </IconButton>
            ) : null}
          </span>
          {canWrite ? (
            <IconButton label={t.audio.library.addLabelDesign(title)} size="sm" variant="soft" disabled={busy} data-testid="audio-fs-add-design" onClick={() => onAdd('design')}>
              {busy ? <Loader2 size={14} className={styles.spin} /> : <Plus size={14} />}
            </IconButton>
          ) : null}
        </div>
      </div>
      <div className={styles.fsBody}>
        <span className={styles.fsTitle} title={sound.title}>
          {title}
        </span>
        <span className={styles.fsMeta}>{s.by(sound.author)}</span>
        {mine && preview.status !== 'idle' ? (
          <div className={styles.progress} aria-hidden="true">
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        ) : null}
        {mine && preview.error ? (
          <p className={styles.warn} role="alert">
            {t.audio.library.previewFailed}
          </p>
        ) : null}
      </div>
    </li>
  )
}

export function AudioFreesoundTab({ info }: { info: Info }) {
  const editor = useEditor()
  const readOnly = useEditorState((st) => st.readOnly)
  const service = editor.adapter.services.audioStock
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [sub, setSub] = useState('')
  const [length, setLength] = useState('any')
  const [sort, setSort] = useState('relevance')
  const [results, setResults] = useState<StockSound[]>([])
  const [total, setTotal] = useState(0)
  const [next, setNext] = useState<number | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [stale, setStale] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const q = useDebounced(query.trim(), 350)
  const abort = useRef<AbortController | null>(null)

  const load = async (page: number): Promise<void> => {
    if (!service) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setStatus('loading')
    try {
      const found = await service.search(q, { type: kind, subcategory: sub, length, sort, page })
      if (controller.signal.aborted) return
      setResults((cur) => (page === 1 ? found.results : [...cur, ...found.results.filter((r) => !cur.some((c) => c.id === r.id))]))
      setTotal(found.total)
      setNext(found.next_page)
      setStale(found.stale === true)
      setStatus('ready')
    } catch (error) {
      if (controller.signal.aborted) return
      setStatus(isApiError(error) && error.status === 429 ? 'busy' : 'failed')
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(1), 0)
    return () => {
      window.clearTimeout(timer)
      abort.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new search whenever one of its inputs changes
  }, [q, kind, sub, length, sort, attempt])

  const add = async (sound: StockSound, scope: 'design' | 'page'): Promise<void> => {
    if (!service) return
    setAdding(sound.id)
    try {
      const { ref, credit, durationMs } = await service.importSound(sound.id)
      const target = scope === 'design' ? ({ type: 'design' } as const) : ({ type: 'page', pageId: editor.state.activePageId } as const)
      const trackCredit: TrackCredit | undefined = credit
        ? { source: credit.source, id: credit.id, title: credit.title, author: credit.author, url: credit.url, license: credit.license, required: credit.required }
        : undefined
      const ms = durationMs ?? (await editor.audio.measure(ref))
      editor.audio.addFromAsset(ref, sound.type === 'music' ? 'music' : 'sfx', ms, target, trackCredit)
    } catch (error) {
      editor.toast(isApiError(error) && error.message ? error.message : s.addFailed, 'error')
    } finally {
      setAdding(null)
    }
  }

  const subs = kind === 'all' ? [] : (info.types[kind] ?? [])
  const mixed = info.licenses.includes('by')

  return (
    <div className={styles.tab} data-testid="audio-freesound">
      <Segmented
        label={s.typeLabel}
        value={kind}
        options={(['all', 'music', 'effects', 'ambience'] as const).map((value) => ({ value, label: s.types[value] }))}
        onChange={(value) => {
          setKind(value)
          setSub('')
          audioRuntime(editor).previewer.stop()
        }}
      />
      <div className={styles.search}>
        <Search size={15} aria-hidden="true" />
        <input type="search" value={query} placeholder={s.placeholder} aria-label={s.search} onChange={(e) => setQuery(e.target.value)} data-testid="audio-fs-search" />
      </div>
      {subs.length > 0 ? (
        <div className={styles.chips} role="group" aria-label={s.subLabel}>
          <Chip active={sub === ''} onClick={() => setSub('')}>
            {s.allSubs}
          </Chip>
          {subs.map((name) => (
            <Chip key={name} active={sub === name} onClick={() => setSub(sub === name ? '' : name)}>
              {name}
            </Chip>
          ))}
        </div>
      ) : null}
      <div className={styles.filters}>
        <Select aria-label={s.lengthLabel} value={length} onChange={(e) => setLength(e.target.value)} data-testid="audio-fs-length">
          {info.lengths.map((value) => (
            <option key={value} value={value}>
              {s.lengths[value] ?? value}
            </option>
          ))}
        </Select>
        <Select aria-label={s.sortLabel} value={sort} onChange={(e) => setSort(e.target.value)} data-testid="audio-fs-sort">
          {info.sorts.map((value) => (
            <option key={value} value={value}>
              {s.sorts[value] ?? value}
            </option>
          ))}
        </Select>
      </div>
      <div className={styles.listHead}>
        <span aria-live="polite" data-testid="audio-fs-count">
          {status === 'loading' && results.length === 0 ? s.loading : status === 'ready' || results.length > 0 ? s.count(total) : ''}
        </span>
      </div>
      {stale ? (
        <p className={styles.note} role="status">
          {s.stale}
        </p>
      ) : null}
      {status === 'failed' || status === 'busy' ? (
        <div className={styles.problem} role="alert" data-testid="audio-fs-error">
          <p>{status === 'busy' ? s.busy : s.failed}</p>
          <Button size="sm" variant="soft" onClick={() => setAttempt((n) => n + 1)}>
            {s.retry}
          </Button>
        </div>
      ) : null}
      {status === 'ready' && results.length === 0 ? (
        <p className={styles.empty} data-testid="audio-fs-none">
          {s.none}
        </p>
      ) : null}
      {results.length > 0 ? (
        <ul className={styles.fsRows} data-testid="audio-fs-results">
          {results.map((sound) => (
            <SoundRow key={sound.id} sound={sound} canWrite={!readOnly} busy={adding === sound.id} onAdd={(scope) => void add(sound, scope)} />
          ))}
        </ul>
      ) : null}
      {next && results.length > 0 ? (
        <Button size="sm" variant="ghost" disabled={status === 'loading'} onClick={() => void load(next)} data-testid="audio-fs-more">
          {s.loadMore}
        </Button>
      ) : null}
      <p className={styles.fine}>
        {mixed ? s.licenseMixed : s.licenseCc0}{' '}
        <a href={info.url} target="_blank" rel="noopener noreferrer">
          {s.source}
        </a>
      </p>
    </div>
  )
}
