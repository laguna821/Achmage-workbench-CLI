import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PresetIcon } from '@/features/PresetIcon'
import { createUrl, describeSize } from '@/features/presets'
import { filterPresets, presetTags, useSizePresets } from '@/lib/sizePresets'
import { Dialog, EmptyState, Input, Tab, TabList, TabPanel, Tabs } from '@/ui'
import { CustomSizeForm } from './CustomSizeForm'
import styles from './CreateDesignDialog.module.css'

export interface CreateDesignDialogProps {
  open: boolean
  onClose(): void
  /** Which tab to show first. */
  initialTab?: 'sizes' | 'custom'
}

/** Tag chips offered at once; the rest are still found by searching. */
const MAX_TAG_CHIPS = 12

/** Pick a size preset (browsed by group, searched, filtered by tag) or enter a custom size. */
export function CreateDesignDialog({ open, onClose, initialTab = 'sizes' }: CreateDesignDialogProps) {
  const navigate = useNavigate()
  const catalogue = useSizePresets()
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])

  const inGroup = useMemo(() => filterPresets(catalogue, { group }).flatMap((section) => section.presets), [catalogue, group])
  const tagChips = useMemo(() => {
    const offered = presetTags(inGroup).slice(0, MAX_TAG_CHIPS)
    return [...offered, ...tags.filter((tag) => !offered.includes(tag))]
  }, [inGroup, tags])
  const sections = useMemo(() => filterPresets(catalogue, { query, group, tags }), [catalogue, query, group, tags])
  const toggleTag = (tag: string): void => setTags((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]))

  function go(url: string) {
    onClose()
    navigate(url)
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create a design" description="Choose a size to start with. You can change it any time." size="xl">
      <Tabs defaultValue={initialTab}>
        <TabList label="Size source">
          <Tab value="sizes">Popular sizes</Tab>
          <Tab value="custom">Custom size</Tab>
        </TabList>
        <TabPanel value="sizes">
          <Input label="Search sizes" hideLabel placeholder="Search sizes, e.g. “poster”" leftIcon={<Search size={16} />} value={query} onChange={(event) => setQuery(event.target.value)} type="search" />
          {catalogue.groups.length > 1 ? (
            <div className={styles.chips} role="group" aria-label="Size groups">
              {[{ slug: null, label: 'All sizes' }, ...catalogue.groups].map((item) => (
                <button key={item.slug ?? ''} type="button" className={styles.chip} aria-pressed={group === item.slug} onClick={() => setGroup(item.slug)}>
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
          {tagChips.length > 0 ? (
            <div className={styles.chips} role="group" aria-label="Filter by tag">
              {tagChips.map((tag) => (
                <button key={tag} type="button" className={`${styles.chip} ${styles.tag}`} aria-pressed={tags.includes(tag)} onClick={() => toggleTag(tag)}>
                  {tag}
                </button>
              ))}
            </div>
          ) : null}
          <div className={styles.groups}>
            {sections.length === 0 ? (
              <EmptyState compact title="No matching size" description="Try another word, or use the Custom size tab." />
            ) : (
              sections.map(({ path, presets }) => {
                const id = `preset-group-${path.map((part) => part.slug).join('-')}`
                return (
                  <section key={id} aria-labelledby={id}>
                    <h3 id={id} className={styles.groupTitle}>
                      {path.map((part) => part.label).join(' › ')}
                    </h3>
                    <ul className={styles.grid}>
                      {presets.map((preset) => (
                        <li key={preset.id}>
                          <button type="button" className={styles.preset} onClick={() => go(createUrl({ presetId: preset.id }))}>
                            <span className={styles.icon} aria-hidden="true">
                              <PresetIcon preset={preset} size={20} />
                            </span>
                            <span className={styles.text}>
                              <span className={styles.label}>{preset.label}</span>
                              <span className={styles.size}>{describeSize(preset)}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })
            )}
          </div>
        </TabPanel>
        <TabPanel value="custom">
          <CustomSizeForm onSubmit={(size) => go(createUrl(size))} />
        </TabPanel>
      </Tabs>
    </Dialog>
  )
}
