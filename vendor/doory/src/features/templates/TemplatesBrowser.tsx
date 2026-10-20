import { LayoutTemplate, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { flattenPages, useTemplateCategories, useTemplatesList } from '@/lib/api/hooks'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { Button, EmptyState, Input, SegmentedControl, Skeleton } from '@/ui'
import type { TemplateQuery } from '@/types/api'
import { TemplateCard } from './TemplateCard'
import styles from './TemplatesBrowser.module.css'

type Orientation = 'all' | NonNullable<TemplateQuery['orientation']>

const ORIENTATIONS: Array<{ value: Orientation; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'square', label: 'Square' },
]

function isOrientation(value: string | null): value is NonNullable<TemplateQuery['orientation']> {
  return value === 'landscape' || value === 'portrait' || value === 'square'
}

/** Category chips, search, orientation filter and a masonry grid with load-more. Filters live in the URL. */
export function TemplatesBrowser() {
  const [params, setParams] = useSearchParams()
  const category = params.get('category') ?? ''
  const orientationParam = params.get('orientation')
  const orientation: Orientation = isOrientation(orientationParam) ? orientationParam : 'all'
  const urlQuery = params.get('q') ?? ''
  const [text, setText] = useState(urlQuery)
  const debounced = useDebouncedValue(text, 300)

  useEffect(() => {
    if (debounced === urlQuery) return
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (debounced.trim()) next.set('q', debounced.trim())
        else next.delete('q')
        return next
      },
      { replace: true },
    )
  }, [debounced, urlQuery, setParams])

  const categories = useTemplateCategories()
  const query: TemplateQuery = useMemo(
    () => ({ category: category || undefined, q: urlQuery || undefined, orientation: orientation === 'all' ? undefined : orientation }),
    [category, urlQuery, orientation],
  )
  const list = useTemplatesList(query)
  const templates = flattenPages(list.data)
  const filtered = Boolean(category || urlQuery || orientation !== 'all')

  function setParam(key: string, value: string | null) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )
  }

  function clearFilters() {
    setText('')
    setParams(new URLSearchParams(), { replace: true })
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          wrapperClassName={styles.searchWrap}
          label="Search templates"
          hideLabel
          type="search"
          placeholder="Search templates"
          leftIcon={<Search size={16} />}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rightSlot={text ? <Button variant="ghost" size="sm" aria-label="Clear search" onClick={() => setText('')} leftIcon={<X size={14} />} /> : undefined}
        />
        <SegmentedControl label="Orientation" value={orientation} onChange={(value) => setParam('orientation', value === 'all' ? null : value)} options={ORIENTATIONS} />
      </div>

      <div className={styles.chips} role="group" aria-label="Categories">
        <button type="button" className={styles.chip} aria-pressed={!category} onClick={() => setParam('category', null)}>
          All
        </button>
        {categories.isPending
          ? Array.from({ length: 5 }, (_, index) => <Skeleton key={index} width={84} height={34} radius="var(--radius-full)" />)
          : (categories.data ?? [])
              // A category nobody has published a template in would only lead to an empty page; the selected one stays.
              .filter((item) => item.template_count > 0 || item.slug === category)
              .map((item) => (
              <button key={item.id} type="button" className={styles.chip} aria-pressed={category === item.slug} onClick={() => setParam('category', category === item.slug ? null : item.slug)}>
                {item.name}
                <span className={styles.count}>{item.template_count}</span>
              </button>
            ))}
      </div>

      <div aria-live="polite" aria-busy={list.isPending}>
        {list.isPending ? (
          <ul className={styles.masonry} aria-label="Loading templates">
            {[1.25, 0.8, 1, 1.5, 0.7, 1.1, 0.9, 1.3].map((ratio, index) => (
              <li key={index} className={styles.item}>
                <Skeleton height={`${Math.round(11 * ratio)}rem`} radius="var(--radius-lg)" />
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <EmptyState icon={<LayoutTemplate size={28} />} title="Templates didn’t load" description="Check your connection and try again." role="alert" action={<Button onClick={() => void list.refetch()}>Try again</Button>} />
        ) : templates.length === 0 ? (
          filtered ? (
            <EmptyState icon={<Search size={28} />} title="No templates match" description="Try different words, or clear the filters to see everything." action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={<LayoutTemplate size={28} />} title="Templates are on their way" description="This Doory server has no templates yet. You can still start from a blank canvas." />
          )
        ) : (
          <>
            <ul className={styles.masonry}>
              {templates.map((template) => (
                <li key={template.id} className={styles.item}>
                  <TemplateCard template={template} />
                </li>
              ))}
            </ul>
            {list.hasNextPage ? (
              <div className={styles.more}>
                <Button variant="secondary" size="lg" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  Load more templates
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
