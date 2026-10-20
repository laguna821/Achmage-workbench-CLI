/**
 * The Library tab: search, filters and a list of the catalogue's music and sound effects with an inline preview
 * (waveform, play / pause) and "Add to design" / "Add to this page". Everything is filtered in the browser from the
 * catalogue that was loaded once; typing never calls the server.
 */
import { Pause, Play, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useEditor, useEditorState } from '../context'
import { useDebounced } from '../hooks/useDebounced'
import { formatSeconds } from '../animation/timelineMath'
import { type CatalogueEntry, type Category, type DurationBand, type LibraryKind, type Mood, catalogueStore, facetsOf, filterEntries } from '../audio/library'
import { peaksFromCatalogue } from '../audio/peaks'
import { audioRuntime, useCatalogue, usePreview } from '../audio/runtime'
import { t } from '../strings'
import { Button, IconButton } from '../ui/Button'
import { Select } from '../ui/Select'
import { Segmented } from '../ui/Segmented'
import { AudioWaveform } from './AudioWaveform'
import styles from './Audio.module.css'

type Sort = 'featured' | 'title' | 'shortest' | 'longest'

function Chip({ active, onClick, children, testId }: { active: boolean; onClick(): void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" className={styles.chip} aria-pressed={active} onClick={onClick} data-testid={testId}>
      {children}
    </button>
  )
}

function Row({ entry, canWrite, onAdd }: { entry: CatalogueEntry; canWrite: boolean; onAdd(scope: 'design' | 'page'): void }) {
  const editor = useEditor()
  const { previewer } = audioRuntime(editor)
  const preview = usePreview()
  const key = `lib:${entry.source}/${entry.id}`
  const mine = preview.key === key
  const playing = mine && preview.status === 'playing'
  const peaks = useMemo(() => peaksFromCatalogue(entry.peaks, entry.durationMs), [entry])
  const progress = mine && preview.status !== 'idle' ? Math.min(1, preview.positionMs / Math.max(1, preview.durationMs || entry.durationMs)) : 0
  const failed = mine && preview.error !== null

  return (
    <li className={styles.row} data-kind={entry.kind} data-playing={playing || undefined} data-testid={`audio-lib-${entry.id}`}>
      <IconButton
        label={playing ? t.audio.library.pause(entry.title) : t.audio.library.preview(entry.title)}
        variant="soft"
        size="md"
        className={styles.rowPlay}
        pressed={playing}
        tooltip={false}
        data-testid="audio-lib-play"
        onClick={() => void previewer.toggle(key, async () => entry.url, { loop: false, durationMs: entry.durationMs })}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </IconButton>
      <div className={styles.rowBody}>
        <div className={styles.rowTitle}>
          <span className={styles.rowName}>{entry.title}</span>
          <span className={styles.rowMeta}>{t.audio.library.details(entry.bpm, formatSeconds(entry.durationMs), entry.loop)}</span>
        </div>
        {entry.kind === 'music' ? (
          <AudioWaveform
            peaks={peaks}
            name={entry.title}
            height={28}
            progress={mine ? progress : undefined}
            onSeek={mine && preview.status !== 'idle' ? (fraction) => previewer.seek(fraction * (preview.durationMs || entry.durationMs)) : undefined}
          />
        ) : null}
        {failed ? (
          <p className={styles.warn} role="alert">
            {preview.error === 'unsupported' ? t.audio.library.oggUnsupported : t.audio.library.previewFailed}
          </p>
        ) : null}
      </div>
      {canWrite ? (
        <div className={styles.rowActions}>
          <Button size="sm" variant="soft" icon={<Plus size={13} aria-hidden="true" />} aria-label={t.audio.library.addLabelDesign(entry.title)} data-testid="audio-lib-add-design" onClick={() => onAdd('design')}>
            {t.audio.library.addToDesign}
          </Button>
          <Button size="sm" aria-label={t.audio.library.addLabelPage(entry.title)} data-testid="audio-lib-add-page" onClick={() => onAdd('page')}>
            {t.audio.library.addToPage}
          </Button>
        </div>
      ) : null}
    </li>
  )
}

export function AudioLibraryTab() {
  const editor = useEditor()
  const readOnly = useEditorState((s) => s.readOnly)
  const state = useCatalogue()
  const [kind, setKind] = useState<LibraryKind>('music')
  const [query, setQuery] = useState('')
  const [mood, setMood] = useState<Mood | null>(null)
  const [category, setCategory] = useState<Category | null>(null)
  const [genre, setGenre] = useState('')
  const [duration, setDuration] = useState<DurationBand>('any')
  const [sort, setSort] = useState<Sort>('featured')
  const debounced = useDebounced(query.trim(), 120)
  // Emptying the box (or Clear) shows everything at once; only typing waits for a pause.
  const q = query.trim() === '' ? '' : debounced

  const entries = useMemo(() => (state.status === 'ready' ? state.catalogue.entries : []), [state])
  const facets = useMemo(() => facetsOf(entries, kind), [entries, kind])
  const shown = useMemo(
    () => filterEntries(entries, { kind, query: q, mood: kind === 'music' ? mood : null, category: kind === 'sfx' ? category : null, genre: kind === 'music' && genre ? genre : null, duration, sort }),
    [entries, kind, q, mood, category, genre, duration, sort],
  )
  const filtered = q !== '' || mood !== null || category !== null || genre !== '' || duration !== 'any'
  const clear = (): void => {
    setQuery('')
    setMood(null)
    setCategory(null)
    setGenre('')
    setDuration('any')
  }

  const add = (entry: CatalogueEntry, scope: 'design' | 'page'): void => {
    const target = scope === 'design' ? ({ type: 'design' } as const) : ({ type: 'page', pageId: editor.state.activePageId } as const)
    editor.audio.addFromLibrary(entry, target)
  }

  return (
    <div className={styles.tab} data-testid="audio-library">
      <Segmented
        label={t.audio.library.kindLabel}
        value={kind}
        options={[
          { value: 'music', label: t.audio.library.music },
          { value: 'sfx', label: t.audio.library.effects },
        ]}
        onChange={(value) => {
          setKind(value)
          setDuration('any')
          previewStop(editor)
        }}
      />
      <div className={styles.search}>
        <Search size={15} aria-hidden="true" />
        <input type="search" value={query} placeholder={kind === 'music' ? t.audio.library.searchMusic : t.audio.library.searchEffects} aria-label={t.audio.library.search} onChange={(e) => setQuery(e.target.value)} data-testid="audio-search" />
      </div>
      {state.status === 'ready' ? (
        <>
          <div className={styles.chips} role="group" aria-label={kind === 'music' ? t.audio.library.moodLabel : t.audio.library.categoryLabel}>
            {kind === 'music' ? (
              <>
                <Chip active={mood === null} onClick={() => setMood(null)} testId="audio-chip-all">
                  {t.audio.library.allMoods}
                </Chip>
                {facets.moods.map((m) => (
                  <Chip key={m.value} active={mood === m.value} onClick={() => setMood(mood === m.value ? null : m.value)} testId={`audio-chip-${m.value}`}>
                    {t.audio.library.moods[m.value]}
                  </Chip>
                ))}
              </>
            ) : (
              <>
                <Chip active={category === null} onClick={() => setCategory(null)} testId="audio-chip-all">
                  {t.audio.library.allCategories}
                </Chip>
                {facets.categories.map((c) => (
                  <Chip key={c.value} active={category === c.value} onClick={() => setCategory(category === c.value ? null : c.value)} testId={`audio-chip-${c.value}`}>
                    {t.audio.library.categories[c.value]}
                  </Chip>
                ))}
              </>
            )}
          </div>
          <div className={styles.filters}>
            {kind === 'music' ? (
              <Select aria-label={t.audio.library.genreLabel} value={genre} onChange={(e) => setGenre(e.target.value)} data-testid="audio-genre">
                <option value="">{t.audio.library.allGenres}</option>
                {facets.genres.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.value}
                  </option>
                ))}
              </Select>
            ) : null}
            <Select aria-label={t.audio.library.durationLabel} value={duration} onChange={(e) => setDuration(e.target.value as DurationBand)} data-testid="audio-duration">
              <option value="any">{t.audio.library.anyLength}</option>
              {(['short', 'medium', 'long'] as const).map((band) => (
                <option key={band} value={band}>
                  {t.audio.library.durations[kind][band]}
                </option>
              ))}
            </Select>
            <Select aria-label={t.audio.library.sortLabel} value={sort} onChange={(e) => setSort(e.target.value as Sort)} data-testid="audio-sort">
              {(['featured', 'title', 'shortest', 'longest'] as const).map((s) => (
                <option key={s} value={s}>
                  {t.audio.library.sorts[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className={styles.listHead}>
            <span aria-live="polite" data-testid="audio-count">
              {t.audio.library.count(shown.length)}
            </span>
            {filtered ? (
              <Button size="sm" variant="ghost" onClick={clear} data-testid="audio-clear">
                {t.audio.library.clearFilters}
              </Button>
            ) : null}
          </div>
          {state.catalogue.fromCache ? (
            <p className={styles.note} role="status">
              {t.audio.library.offline}
            </p>
          ) : null}
          {shown.length === 0 ? (
            <p className={styles.empty} data-testid="audio-none">
              {t.audio.library.none}
            </p>
          ) : (
            <ul className={styles.rows} data-testid="audio-results">
              {shown.map((entry) => (
                <Row key={`${entry.source}/${entry.id}`} entry={entry} canWrite={!readOnly} onAdd={(scope) => add(entry, scope)} />
              ))}
            </ul>
          )}
          <p className={styles.fine}>
            {t.audio.library.license} {state.catalogue.release ? t.audio.library.release(state.catalogue.release) : ''}
          </p>
          {state.catalogue.packs.length > 0 ? (
            <details className={styles.credits}>
              <summary>{t.audio.library.credits}</summary>
              <ul>
                {state.catalogue.packs.map((pack) => (
                  <li key={pack.id}>
                    {pack.attribution || pack.name} ({pack.license})
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : state.status === 'loading' ? (
        <p className={styles.note} role="status" data-testid="audio-loading">
          {t.audio.library.loading}
        </p>
      ) : (
        <div className={styles.problem} role="alert" data-testid="audio-error" data-code={state.code}>
          <p>{state.code === 'not-installed' ? t.audio.library.notInstalled : state.code === 'invalid' ? t.audio.library.invalid : t.audio.library.unreachable}</p>
          {state.code === 'not-installed' ? <p className={styles.hint}>{t.audio.library.notInstalledHint}</p> : null}
          <Button size="sm" variant="soft" onClick={() => catalogueStore.reload()} data-testid="audio-retry">
            {t.audio.library.retry}
          </Button>
        </div>
      )}
    </div>
  )
}

function previewStop(editor: ReturnType<typeof useEditor>): void {
  audioRuntime(editor).previewer.stop()
}

