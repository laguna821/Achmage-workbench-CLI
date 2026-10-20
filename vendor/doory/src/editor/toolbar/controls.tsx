import { type ReactNode, useCallback, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { I } from '../chrome/icons'
import { useEditor, useSelection } from '../context'
import { t } from '../strings'
import { Popover } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import { type Limit, clampTo, rangeHint } from './limits'
import { PopoverTool, ToolButton } from './parts'
import ed from '../chrome/ed.module.css'

const outside = (raw: string, limit: Limit): boolean => {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) && (n < limit.min || n > limit.max)
}

/** `−  36  +` with an inverted number box. The range is the field's tooltip; a value outside it is clamped when committed. */
export function Stepper({ label, value, limit, onChange, testId }: { label: string; value: number; limit: Limit; onChange: (value: number, key?: string) => void; testId: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const { min, max, step } = limit
  const clamp = (n: number): number => clampTo(limit, Math.round(n))
  const commit = (raw: string): void => {
    setDraft(null)
    const n = Number(raw)
    if (raw.trim() !== '' && Number.isFinite(n)) onChange(clamp(n))
  }
  const hint = rangeHint(limit)
  return (
    <div className={ed.stepper} role="group" aria-label={label} title={hint} data-testid={testId}>
      <button type="button" className={ed.stepBtn} aria-label={t.ctx.decreaseSize} title={t.ctx.decreaseSize} disabled={value <= min} data-testid={`${testId}-minus`} onClick={() => onChange(clamp(value - step), 'step')}>
        −
      </button>
      <input
        type="number"
        className={ed.stepInput}
        aria-label={label}
        aria-invalid={draft !== null && outside(draft, limit) ? true : undefined}
        title={hint}
        data-testid={`${testId}-input`}
        value={draft ?? value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) onChange(Math.round(n), 'typing')
        }}
        onBlur={(e) => commit(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value)
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            setDraft(null)
            onChange(clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : step)), 'step')
          }
        }}
      />
      <button type="button" className={ed.stepBtn} aria-label={t.ctx.increaseSize} title={t.ctx.increaseSize} disabled={value >= max} data-testid={`${testId}-plus`} onClick={() => onChange(clamp(value + step), 'step')}>
        +
      </button>
    </div>
  )
}

/**
 * A labelled number field of a popover (line height, stroke width, …). A value inside the range applies as it is
 * typed; one outside waits, is marked invalid and is clamped when the field is committed (Enter or leaving it).
 * The range is the tooltip and the accessible description.
 */
export function LimitedNumber({ label, value, limit, onChange, testId }: { label: string; value: number; limit: Limit; onChange: (value: number) => void; testId: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const hint = rangeHint(limit)
  const shown = String(Number(value.toFixed(limit.decimals)))
  const commit = (raw: string): void => {
    setDraft(null)
    const n = Number(raw)
    if (raw.trim() !== '' && Number.isFinite(n)) onChange(clampTo(limit, n))
  }
  return (
    <>
      <div className={ed.propLabel}>{label}</div>
      <input
        type="number"
        className={ed.propInput}
        aria-label={label}
        aria-invalid={draft !== null && outside(draft, limit) ? true : undefined}
        title={hint}
        data-testid={testId}
        value={draft ?? shown}
        min={limit.min}
        max={limit.max}
        step={limit.step}
        onChange={(e) => {
          const raw = e.target.value
          const n = Number(raw)
          if (raw.trim() !== '' && Number.isFinite(n) && n >= limit.min && n <= limit.max) {
            setDraft(null)
            onChange(clampTo(limit, n))
          } else setDraft(raw)
        }}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
          else if (e.key === 'Escape') setDraft(null)
        }}
      />
    </>
  )
}

/**
 * Quarter-turn rotate control: a small menu of presets. For a locked selection it stays in its place, disabled and
 * named "Rotation locked": hiding it would slide the lock button, which sits next to it, out
 * from under the pointer the moment it is pressed.
 */
export function RotateTool() {
  const editor = useEditor()
  const sel = useSelection()
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const angle = Math.round((((sel.bounds?.angle ?? 0) % 360) + 360) % 360)
  // Locking while the menu is open (Mod+L) closes it for good rather than reopening it after the unlock.
  if (sel.locked && open) setOpen(false)
  if (sel.locked) {
    return (
      <ToolButton label={t.ctx.rotationLocked} disabled onClick={() => undefined} testId="ed-rotate">
        {I.rotate}
      </ToolButton>
    )
  }
  const run = (fn: () => void): void => {
    fn()
    close()
  }
  return (
    <>
      <Tooltip label={t.ctx.rotateTitle(angle)} disabled={open}>
        <button ref={ref} type="button" className={`${ed.toolBtn} ${open ? ed.active : ''}`} aria-label={t.toolbar.rotate} aria-haspopup="menu" aria-expanded={open} data-testid="ed-rotate" onClick={() => setOpen((o) => !o)}>
          {I.rotate}
        </button>
      </Tooltip>
      <Popover open={open} onClose={close} anchorRef={ref} label={t.toolbar.rotate} placement="bottom" variant="plain" cover>
        <div className={ed.menuList} role="menu" data-testid="ed-rotate-menu">
          <button type="button" role="menuitem" className={ed.menuItem} onClick={() => run(() => editor.arrange.rotateBy(90))}>
            {t.ctx.rotateRight} <span>↻</span>
          </button>
          <button type="button" role="menuitem" className={ed.menuItem} onClick={() => run(() => editor.arrange.rotateBy(-90))}>
            {t.ctx.rotateLeft} <span>↺</span>
          </button>
          <button type="button" role="menuitem" className={ed.menuItem} onClick={() => run(() => editor.arrange.rotateBy(180))}>
            {t.ctx.rotate180} <span>⟳</span>
          </button>
          <button type="button" role="menuitem" className={ed.menuItem} disabled={angle === 0} onClick={() => run(() => editor.arrange.setAngle(0))}>
            {t.ctx.rotateReset} <span>{angle}°</span>
          </button>
        </div>
      </Popover>
    </>
  )
}

export function LockTool() {
  const editor = useEditor()
  const sel = useSelection()
  return (
    <ToolButton label={sel.locked ? t.ctx.unlockPosition : t.ctx.lockPosition} shortcut="Mod+L" pressed={sel.locked} onClick={() => editor.arrange.toggleLock()} testId="ed-lock">
      {sel.locked ? I.lock : I.unlock}
    </ToolButton>
  )
}

export function DuplicateTool() {
  const editor = useEditor()
  return (
    <ToolButton label={t.toolbar.duplicate} shortcut="Mod+D" onClick={() => void editor.arrange.duplicate()} testId="ed-duplicate">
      {I.duplicate}
    </ToolButton>
  )
}

export function DeleteTool() {
  const editor = useEditor()
  return (
    <ToolButton label={t.toolbar.delete} shortcut="Delete" danger onClick={() => editor.arrange.delete()} testId="ed-delete">
      {I.trash}
    </ToolButton>
  )
}

/** `Opacity` popover with the percentage on the label row (a slider). */
export function OpacityTool({ testId = 'ed-opacity' }: { testId?: string }) {
  const editor = useEditor()
  const sel = useSelection()
  const opacity = Number(sel.objects[0]?.opacity ?? 1)
  return (
    <PopoverTool label={t.toolbar.opacity} trigger={I.opacity} width={200} testId={testId}>
      <div className={`${ed.propLabel} ${ed.propLabelRow}`}>
        <span>{t.toolbar.opacity}</span>
        <span>{Math.round(opacity * 100)}%</span>
      </div>
      <input type="range" className={ed.slider} min={0} max={1} step={0.05} value={opacity} aria-label={t.toolbar.opacity} data-testid={`${testId}-range`} onChange={(e) => editor.style.setOpacity(Number(e.target.value))} />
    </PopoverTool>
  )
}

export function FlipTools() {
  const editor = useEditor()
  return (
    <>
      <ToolButton label={t.toolbar.flipH} onClick={() => editor.arrange.flip('horizontal')} testId="ed-flip-h">
        {I.flipH}
      </ToolButton>
      <ToolButton label={t.toolbar.flipV} onClick={() => editor.arrange.flip('vertical')} testId="ed-flip-v">
        {I.flipV}
      </ToolButton>
    </>
  )
}

export function ZOrderTools() {
  const editor = useEditor()
  return (
    <>
      <ToolButton label={t.toolbar.forward} shortcut="Mod+]" onClick={() => editor.arrange.zOrder('forward')} testId="ed-forward">
        {I.layerUp}
      </ToolButton>
      <ToolButton label={t.toolbar.backward} shortcut="Mod+[" onClick={() => editor.arrange.zOrder('backward')} testId="ed-backward">
        {I.layerDown}
      </ToolButton>
    </>
  )
}

export function CenterTools() {
  const editor = useEditor()
  return (
    <>
      <ToolButton label={t.ctx.centerH} onClick={() => editor.arrange.align('center', 'page')} testId="ed-center-h">
        {I.canvasCenterH}
      </ToolButton>
      <ToolButton label={t.ctx.centerV} onClick={() => editor.arrange.align('middle', 'page')} testId="ed-center-v">
        {I.canvasCenterV}
      </ToolButton>
    </>
  )
}

/** A named section of an "overflow" popover that can be folded away. */
export function Accordion({ title, children, defaultOpen = false, testId }: { title: string; children: ReactNode; defaultOpen?: boolean; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={ed.accordion} data-testid={testId}>
      <button type="button" className={ed.accordionHead} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open ? <div className={ed.accordionBody}>{children}</div> : null}
    </section>
  )
}

/** The `⋯` button at the end of the row: the less common controls live in its popover. */
export function OverflowTool({ children }: { children: ReactNode }) {
  return (
    <PopoverTool label={t.ctx.moreOptions} trigger={<span aria-hidden="true">⋯</span>} width={304} flush testId="ed-overflow">
      <div className={ed.overflow}>{children}</div>
    </PopoverTool>
  )
}
