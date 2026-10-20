import { Grid3x3, Maximize, Ruler } from 'lucide-react'
import { useRef, useState } from 'react'
import { I } from '../chrome/icons'
import { useEditor, useEditorState } from '../context'
import { MAX_ZOOM, MIN_ZOOM, zoomLabel } from '../engine/zoom'
import { t } from '../strings'
import { Menu, type MenuItem } from '../ui/Menu'
import { Tooltip } from '../ui/Tooltip'
import styles from './Floating.module.css'

const PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8]

// Slider position 0..100 <-> zoom on a log scale so every zoom range gets equal travel.
const toSlider = (z: number): number => (Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 100
const fromSlider = (v: number): number => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v / 100)

/** The floating zoom pill: zoom out, slider, zoom in and the percentage (its menu has fit, presets, rulers and grid). */
export function ZoomControls() {
  const editor = useEditor()
  const zoom = useEditorState((s) => s.zoom)
  const mode = useEditorState((s) => s.zoomMode)
  const rulers = useEditorState((s) => s.ui.rulers)
  const grid = useEditorState((s) => s.ui.grid)
  const readOnly = useEditorState((s) => s.readOnly)
  const [menu, setMenu] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)

  const items: MenuItem[] = [
    { id: 'fit-page', label: t.workspace.fitPage, icon: <Maximize size={16} />, shortcut: 'Shift+1', checked: mode === 'fit-page', onSelect: () => editor.view.fit('fit-page') },
    { id: 'fit-width', label: t.workspace.fitWidth, checked: mode === 'fit-width', onSelect: () => editor.view.fit('fit-width') },
    { id: 'sep', separator: true },
    ...PRESETS.map((p) => ({ id: `z${p}`, label: zoomLabel(p), shortcut: p === 1 ? 'Shift+0' : undefined, onSelect: () => editor.view.setZoom(p) })),
    ...(readOnly
      ? []
      : [
          { id: 'sep2', separator: true },
          { id: 'rulers', label: t.workspace.rulers, icon: <Ruler size={16} />, shortcut: 'Shift+R', checked: rulers, onSelect: () => editor.patchUi({ rulers: !rulers }) },
          { id: 'grid', label: t.workspace.grid, icon: <Grid3x3 size={16} />, shortcut: "Mod+'", checked: grid, onSelect: () => editor.patchUi({ grid: !grid }) },
        ]),
  ]

  return (
    <div className={styles.zoom} role="group" aria-label={t.workspace.zoomControls} data-testid="ed-zoombar">
      <Tooltip label={t.workspace.zoomOut} shortcut="Mod+-" side="top">
        <button type="button" className={styles.zoomBtn} aria-label={t.workspace.zoomOut} data-testid="ed-zoom-out" onClick={() => editor.view.zoomOut()}>
          {I.zoomOut}
        </button>
      </Tooltip>
      <input
        type="range"
        className={styles.slider}
        min={0}
        max={100}
        step={0.5}
        value={toSlider(zoom)}
        aria-label={t.workspace.zoomLevel}
        aria-valuetext={zoomLabel(zoom)}
        data-testid="ed-zoom-slider"
        onChange={(e) => editor.view.setZoom(fromSlider(Number(e.target.value)))}
      />
      <Tooltip label={t.workspace.zoomIn} shortcut="Mod+=" side="top">
        <button type="button" className={styles.zoomBtn} aria-label={t.workspace.zoomIn} data-testid="ed-zoom-in" onClick={() => editor.view.zoomIn()}>
          {I.zoomIn}
        </button>
      </Tooltip>
      <button ref={anchor} type="button" className={styles.percent} aria-haspopup="menu" aria-expanded={menu} aria-label={`${t.workspace.zoomLevel}: ${zoomLabel(zoom)}`} data-testid="ed-zoom-value" onClick={() => setMenu((m) => !m)}>
        {zoomLabel(zoom)}
      </button>
      {menu ? <Menu label={t.workspace.zoomLevel} items={items} anchorRef={anchor} onClose={() => setMenu(false)} /> : null}
    </div>
  )
}
